import "server-only";

import {
  increasePaymentEventKey,
  increasePaymentEventType,
  increasePaymentValueDate,
} from "./increase-transfer-state";
import { callRpc, insertRows, selectRows } from "./supabase";

function achReturnCode(reason) {
  const codes = {
    insufficient_fund: "R01",
    account_closed: "R02",
    no_account: "R03",
    invalid_account_number: "R04",
    unauthorized_debit_to_consumer_account: "R10",
  };
  return codes[reason] || "R99";
}

export async function recordIncreaseAchTransfer({
  transfer,
  eventId,
  eventCreatedAt,
  providerEventId = null,
  actorId = null,
}) {
  const payments = await selectRows(
    "payments",
    `provider_code=eq.increase&provider_payment_id=eq.${transfer.id}`,
  );
  if (!payments[0]) return { matched: false, eventType: null };

  const payment = payments[0];
  let eventType = increasePaymentEventType(transfer);
  if (eventType === "RETURNED" && payment.direction === "INBOUND") eventType = "RECALLED";
  const occurredAt = transfer.settlement?.settled_at || eventCreatedAt;

  await callRpc("record_payment_event", {
    p_payment_idempotency_key: payment.idempotency_key,
    p_event_idempotency_key: increasePaymentEventKey(transfer, eventType, eventId),
    p_business_account_id: payment.business_account_id,
    p_direction: payment.direction,
    p_rail_code: "ACH",
    p_amount_cents: payment.amount_cents,
    p_event_type: eventType,
    p_occurred_at: occurredAt,
    p_payment_request_id: payment.payment_request_id,
    p_provider_code: "increase",
    p_provider_payment_id: transfer.id,
    p_provider_event_id: providerEventId,
    p_actor_id: actorId,
    p_value_date: increasePaymentValueDate(transfer, eventType, eventCreatedAt),
    p_reason_code: transfer.return?.reason || null,
    p_details: {
      increase_status: transfer.status,
      settled_at: transfer.settlement?.settled_at || null,
    },
    p_rail_details: {
      provider_transfer_id: transfer.id,
      ach_return_code: ["RETURNED", "RECALLED"].includes(eventType)
        ? achReturnCode(transfer.return?.reason)
        : null,
      sec_code: "CCD",
    },
  });

  if (eventType === "RECALLED") {
    await insertRows("business_account_events", [{
      business_account_id: payment.business_account_id,
      provider_event_id: providerEventId,
      idempotency_key: `increase-restrict:${transfer.id}:${transfer.return?.reason || "unknown"}`,
      event_type: "RESTRICTED",
      occurred_at: occurredAt,
      details: { reason: transfer.return?.reason || "ACH funding recalled" },
    }], { ignoreDuplicates: true });
    const cards = await selectRows("cards", `business_account_id=eq.${payment.business_account_id}`);
    if (cards.length) {
      await insertRows("card_events", cards.map((card) => ({
        card_id: card.id,
        provider_event_id: providerEventId,
        idempotency_key: `increase-freeze:${transfer.id}:${card.id}`,
        event_type: "FROZEN",
        occurred_at: occurredAt,
        details: { reason: "ACH funding recalled" },
      })), { ignoreDuplicates: true });
    }
  }

  return { matched: true, eventType };
}
