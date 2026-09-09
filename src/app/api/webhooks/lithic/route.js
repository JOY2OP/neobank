import { recordProcessingAttempt, shouldProcessProviderEvent, storeProviderEvent } from "@/lib/provider-events";
import { lithicClient } from "@/lib/providers/lithic";
import { requiredEnv } from "@/lib/providers/config";
import { callRpc, selectRows } from "@/lib/supabase";

async function findCard(providerCardId) {
  const cards = await selectRows("cards", `provider_code=eq.lithic&provider_card_id=eq.${providerCardId}`);
  if (!cards[0]) throw new Error(`No local card matches Lithic card ${providerCardId}.`);
  return cards[0];
}

function latestEvent(transaction, types) {
  return [...(transaction.events || [])].reverse().find((event) => types.includes(event.type));
}

function eventAmount(event, fallback) {
  return Math.abs(Number(event?.amounts?.cardholder?.amount ?? event?.amount ?? fallback ?? 0));
}

async function processLithicTransaction(transaction, providerEventId) {
  const card = await findCard(transaction.card_token);
  const returnEvent = latestEvent(transaction, ["RETURN"]);
  if (returnEvent) {
    const settlements = await selectRows(
      "card_settlements",
      `provider_code=eq.lithic&card_id=eq.${card.id}&order=recorded_at.desc&limit=1`,
    );
    if (!settlements[0]) throw new Error("Lithic return arrived before its original settlement.");
    await callRpc("reverse_card_settlement", {
      p_settlement_id: settlements[0].id,
      p_idempotency_key: `lithic:return:${returnEvent.token}`,
      p_value_date: settlements[0].value_date,
      p_reason: "Lithic sandbox return",
      p_provider_event_id: providerEventId,
    });
    return;
  }

  if (transaction.status === "SETTLED") {
    const clearing = latestEvent(transaction, ["CLEARING", "FINANCIAL_AUTHORIZATION"]);
    if (!clearing) return;
    await callRpc("record_card_settlement", {
      p_provider_code: "lithic",
      p_provider_settlement_id: clearing.token,
      p_card_id: card.id,
      p_external_authorization_id: transaction.token,
      p_amount_cents: eventAmount(clearing, transaction.settled_amount),
      p_value_date: clearing.created.slice(0, 10),
      p_occurred_at: clearing.created,
      p_explicit_force_post: clearing.type === "FINANCIAL_AUTHORIZATION",
      p_is_final_capture: true,
      p_idempotency_key: `lithic:clearing:${clearing.token}`,
      p_provider_event_id: providerEventId,
    });
    return;
  }

  const authorization = latestEvent(transaction, ["AUTHORIZATION", "AUTHORIZATION_ADVICE"]);
  const terminal = latestEvent(transaction, ["AUTHORIZATION_REVERSAL", "AUTHORIZATION_EXPIRY"]);
  let eventType = transaction.result === "APPROVED" ? "AUTHORIZED" : "DECLINED";
  if (transaction.status === "VOIDED" || terminal?.type === "AUTHORIZATION_REVERSAL") eventType = "REVERSED";
  if (transaction.status === "EXPIRED" || terminal?.type === "AUTHORIZATION_EXPIRY") eventType = "EXPIRED";
  const lifecycleEvent = terminal || authorization;
  if (!lifecycleEvent) return;
  await callRpc("record_authorization_event", {
    p_provider_code: "lithic",
    p_provider_authorization_id: transaction.token,
    p_card_id: card.id,
    p_event_type: eventType,
    p_authorized_total_cents: eventType === "AUTHORIZED" ? eventAmount(authorization, transaction.authorization_amount) : null,
    p_occurred_at: lifecycleEvent.created,
    p_idempotency_key: `lithic:authorization:${lifecycleEvent.token}:${eventType}`,
    p_provider_event_id: providerEventId,
    p_merchant_name: transaction.merchant?.descriptor || null,
    p_merchant_category_code: transaction.merchant?.mcc || null,
    p_details: { lithic_status: transaction.status, lithic_result: transaction.result },
  });
}

export async function POST(request) {
  const rawBody = await request.text();
  let event;
  try {
    event = lithicClient().webhooks.parse(rawBody, {
      headers: Object.fromEntries(request.headers.entries()),
      secret: requiredEnv("LITHIC_WEBHOOK_SECRET"),
    });
  } catch {
    return Response.json({ error: "Invalid Lithic signature" }, { status: 401 });
  }

  const transaction = event.payload || event;
  const eventType = event.event_type || transaction.event_type;
  const externalId = request.headers.get("webhook-id") || event.token;
  if (!externalId) return Response.json({ error: "Lithic webhook ID is missing" }, { status: 400 });
  const stored = await storeProviderEvent({
    provider: "lithic",
    externalId,
    type: eventType || "unknown",
    createdAt: event.created || transaction.updated || transaction.created || null,
    payload: event,
  });
  const replay = !stored.inserted;
  if (replay && !(await shouldProcessProviderEvent(stored.provider_event_id))) {
    return Response.json({ received: true, replay: true });
  }

  try {
    if (eventType === "card_transaction.updated") {
      await processLithicTransaction(transaction, stored.provider_event_id);
    }
    await recordProcessingAttempt(stored.provider_event_id, "SUCCEEDED");
    return Response.json({ received: true, replay, retried: replay });
  } catch (error) {
    await recordProcessingAttempt(stored.provider_event_id, "RETRYABLE_FAILURE", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
