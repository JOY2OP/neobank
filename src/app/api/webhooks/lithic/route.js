import { recordProcessingAttempt, shouldProcessProviderEvent, storeProviderEvent } from "@/lib/provider-events";
import { lithicTransactionCommands } from "@/lib/lithic-events";
import { lithicClient } from "@/lib/providers/lithic";
import { requiredEnv } from "@/lib/providers/config";
import { callRpc, selectRows } from "@/lib/supabase";

async function findCard(providerCardId) {
  const cards = await selectRows("cards", `provider_code=eq.lithic&provider_card_id=eq.${providerCardId}`);
  if (!cards[0]) throw new Error(`No local card matches Lithic card ${providerCardId}.`);
  return cards[0];
}

async function settlementForReturn(cardId, returnEventToken, references) {
  // The core-loop return action records this exact provider event token on the
  // chosen settlement. It is a durable correlation if the provider's return
  // snapshot does not include transaction_series references.
  const priorEvents = await selectRows(
    "card_settlement_events",
    `idempotency_key=eq.${encodeURIComponent(`lithic:return:${returnEventToken}`)}&select=settlement_id&limit=1`,
  );
  if (priorEvents[0]) {
    const correlated = await selectRows(
      "card_settlements",
      `id=eq.${priorEvents[0].settlement_id}&provider_code=eq.lithic&card_id=eq.${cardId}&limit=1`,
    );
    if (correlated[0]) return correlated[0];
  }

  for (const reference of references) {
    const encoded = encodeURIComponent(reference);
    const byClearing = await selectRows(
      "card_settlements",
      `provider_code=eq.lithic&card_id=eq.${cardId}&provider_settlement_id=eq.${encoded}&limit=2`,
    );
    if (byClearing.length === 1) return byClearing[0];

    const byAuthorization = await selectRows(
      "card_settlements",
      `provider_code=eq.lithic&card_id=eq.${cardId}&external_authorization_id=eq.${encoded}&limit=2`,
    );
    if (byAuthorization.length === 1) return byAuthorization[0];
    if (byAuthorization.length > 1) {
      throw new Error("Lithic return matches multiple captures; an event-level clearing reference is required.");
    }
  }
  throw new Error("Lithic return has no exact original transaction reference; refusing to reverse the latest card settlement.");
}

async function processLithicTransaction(transaction, providerEventId) {
  const card = await findCard(transaction.card_token);
  for (const command of lithicTransactionCommands(transaction)) {
    if (command.kind === "authorization") {
      await callRpc("record_authorization_event", {
        p_provider_code: "lithic",
        p_provider_authorization_id: transaction.token,
        p_card_id: card.id,
        p_event_type: command.eventType,
        p_authorized_total_cents: command.authorizedTotalCents,
        p_occurred_at: command.occurredAt,
        p_idempotency_key: `lithic:authorization:${command.eventToken}:${command.eventType}`,
        p_provider_event_id: providerEventId,
        p_merchant_name: transaction.merchant?.descriptor || null,
        p_merchant_category_code: transaction.merchant?.mcc || null,
        p_details: { lithic_status: transaction.status, lithic_result: transaction.result },
      });
      continue;
    }

    if (command.kind === "settlement") {
      if (!Number.isSafeInteger(command.amountCents) || command.amountCents <= 0) {
        throw new Error(`Lithic clearing ${command.eventToken} has an invalid cardholder amount.`);
      }
      await callRpc("record_card_settlement", {
        p_provider_code: "lithic",
        p_provider_settlement_id: command.eventToken,
        p_card_id: card.id,
        p_external_authorization_id: command.externalAuthorizationId,
        p_amount_cents: command.amountCents,
        p_value_date: command.valueDate,
        p_occurred_at: command.occurredAt,
        p_explicit_force_post: command.forcePost,
        p_is_final_capture: command.finalCapture,
        p_idempotency_key: `lithic:clearing:${command.eventToken}`,
        p_provider_event_id: providerEventId,
      });
      continue;
    }

    const settlement = await settlementForReturn(card.id, command.eventToken, command.relatedReferences);
    await callRpc("reverse_card_settlement", {
      p_settlement_id: settlement.id,
      p_idempotency_key: `lithic:return:${command.eventToken}`,
      p_value_date: settlement.value_date,
      p_reason: "Lithic sandbox return",
      p_provider_event_id: providerEventId,
    });
  }
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
