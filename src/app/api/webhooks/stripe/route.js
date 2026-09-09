import { recordProcessingAttempt, storeProviderEvent } from "@/lib/provider-events";
import { requiredEnv } from "@/lib/providers/config";
import { callRpc, selectRows } from "@/lib/supabase";
import { verifyStripeSignature } from "@/lib/webhook-signatures";

function stripeCardId(object) {
  return typeof object.card === "string" ? object.card : object.card?.id;
}

async function findCard(providerCardId) {
  const cards = await selectRows("cards", `provider_code=eq.stripe&provider_card_id=eq.${providerCardId}`);
  if (!cards[0]) throw new Error(`No local card matches Stripe card ${providerCardId}.`);
  return cards[0];
}

async function processStripeEvent(event, providerEventId) {
  const object = event.data.object;
  if (event.type.startsWith("issuing_authorization.")) {
    const card = await findCard(stripeCardId(object));
    let eventType = object.approved ? "AUTHORIZED" : "DECLINED";
    if (object.status === "reversed") eventType = "REVERSED";
    if (object.status === "closed" && !object.transactions?.length) eventType = "EXPIRED";
    await callRpc("record_authorization_event", {
      p_provider_code: "stripe",
      p_provider_authorization_id: object.id,
      p_card_id: card.id,
      p_event_type: eventType,
      p_authorized_total_cents: ["AUTHORIZED", "INCREMENTED"].includes(eventType) ? Math.abs(object.amount) : null,
      p_occurred_at: new Date(object.created * 1000).toISOString(),
      p_idempotency_key: `stripe:${event.id}`,
      p_provider_event_id: providerEventId,
      p_merchant_name: object.merchant_data?.name || null,
      p_merchant_category_code: object.merchant_data?.category_code || null,
      p_details: { stripe_status: object.status },
    });
    return;
  }

  if (event.type.startsWith("issuing_transaction.")) {
    const card = await findCard(stripeCardId(object));
    const authorizationId = typeof object.authorization === "string"
      ? object.authorization
      : object.authorization?.id;
    if (object.type === "capture") {
      await callRpc("record_card_settlement", {
        p_provider_code: "stripe",
        p_provider_settlement_id: object.id,
        p_card_id: card.id,
        p_external_authorization_id: authorizationId || null,
        p_amount_cents: Math.abs(object.amount),
        p_value_date: new Date(object.created * 1000).toISOString().slice(0, 10),
        p_occurred_at: new Date(object.created * 1000).toISOString(),
        p_explicit_force_post: !authorizationId,
        p_is_final_capture: true,
        p_idempotency_key: `stripe:${event.id}`,
        p_provider_event_id: providerEventId,
      });
    } else if (object.type === "refund" && authorizationId) {
      const settlements = await selectRows(
        "card_settlements",
        `provider_code=eq.stripe&external_authorization_id=eq.${authorizationId}&order=recorded_at.desc&limit=1`,
      );
      if (!settlements[0]) throw new Error("Refund arrived before its original settlement.");
      await callRpc("reverse_card_settlement", {
        p_settlement_id: settlements[0].id,
        p_idempotency_key: `stripe:${event.id}`,
        p_value_date: settlements[0].value_date,
        p_reason: "Stripe Issuing refund",
        p_provider_event_id: providerEventId,
      });
    }
  }
}

export async function POST(request) {
  // Signature verification needs the exact bytes Stripe sent, before JSON parsing.
  const rawBody = await request.text();
  if (!verifyStripeSignature(rawBody, request.headers.get("stripe-signature"), requiredEnv("STRIPE_WEBHOOK_SECRET"))) {
    return Response.json({ error: "Invalid Stripe signature" }, { status: 401 });
  }
  const event = JSON.parse(rawBody);
  const stored = await storeProviderEvent({
    provider: "stripe",
    externalId: event.id,
    type: event.type,
    createdAt: event.created ? new Date(event.created * 1000).toISOString() : null,
    payload: event,
  });
  if (!stored.inserted) return Response.json({ received: true, replay: true });

  try {
    await processStripeEvent(event, stored.provider_event_id);
    await recordProcessingAttempt(stored.provider_event_id, "SUCCEEDED");
    return Response.json({ received: true });
  } catch (error) {
    await recordProcessingAttempt(stored.provider_event_id, "RETRYABLE_FAILURE", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
