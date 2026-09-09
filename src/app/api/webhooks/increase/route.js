import { recordProcessingAttempt, storeProviderEvent } from "@/lib/provider-events";
import { requiredEnv } from "@/lib/providers/config";
import { retrieveIncreaseObject } from "@/lib/providers/increase";
import { callRpc, insertRows, selectRows } from "@/lib/supabase";
import { verifyIncreaseSignature } from "@/lib/webhook-signatures";

function paymentEventType(status) {
  return {
    pending_approval: "PENDING",
    pending_submission: "PENDING",
    submitted: "SUBMITTED",
    settled: "SETTLED",
    returned: "RETURNED",
    canceled: "CANCELLED",
    rejected: "FAILED",
  }[status] || "UNKNOWN";
}

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

export async function POST(request) {
  const rawBody = await request.text();
  if (!verifyIncreaseSignature(rawBody, request.headers, requiredEnv("INCREASE_WEBHOOK_SECRET"))) {
    return Response.json({ error: "Invalid Increase signature" }, { status: 401 });
  }
  const event = JSON.parse(rawBody);
  const stored = await storeProviderEvent({
    provider: "increase",
    externalId: event.id,
    type: event.category,
    createdAt: event.created_at,
    payload: event,
  });
  if (!stored.inserted) return Response.json({ received: true, replay: true });

  try {
    if (event.associated_object_type === "ach_transfer") {
      const transfer = await retrieveIncreaseObject("ach_transfer", event.associated_object_id);
      const payments = await selectRows("payments", `provider_code=eq.increase&provider_payment_id=eq.${transfer.id}`);
      if (payments[0]) {
        let type = paymentEventType(transfer.status);
        if (type === "RETURNED" && payments[0].direction === "INBOUND") type = "RECALLED";
        await callRpc("record_payment_event", {
          p_payment_idempotency_key: payments[0].idempotency_key,
          p_event_idempotency_key: `increase:${event.id}`,
          p_business_account_id: payments[0].business_account_id,
          p_direction: payments[0].direction,
          p_rail_code: "ACH",
          p_amount_cents: payments[0].amount_cents,
          p_event_type: type,
          p_occurred_at: event.created_at,
          p_payment_request_id: payments[0].payment_request_id,
          p_provider_code: "increase",
          p_provider_payment_id: transfer.id,
          p_provider_event_id: stored.provider_event_id,
          p_value_date: ["SETTLED", "RETURNED", "RECALLED"].includes(type)
            ? (transfer.submission?.effective_date || transfer.settlement?.settled_at?.slice(0, 10) || event.created_at.slice(0, 10))
            : null,
          p_reason_code: transfer.return?.reason || null,
          p_details: { increase_status: transfer.status },
          p_rail_details: {
            provider_transfer_id: transfer.id,
            ach_return_code: type === "RETURNED" ? achReturnCode(transfer.return?.reason) : null,
            sec_code: "CCD",
          },
        });
        if (type === "RECALLED") {
          // A bounced deposit removes settled money immediately. Restrict spending
          // and freeze cards until Ops resolves the negative-balance risk.
          await insertRows("business_account_events", [{
            business_account_id: payments[0].business_account_id,
            provider_event_id: stored.provider_event_id,
            idempotency_key: `increase-restrict:${event.id}`,
            event_type: "RESTRICTED",
            occurred_at: event.created_at,
            details: { reason: transfer.return?.reason || "ACH funding recalled" },
          }], { ignoreDuplicates: true });
          const cards = await selectRows("cards", `business_account_id=eq.${payments[0].business_account_id}`);
          if (cards.length) {
            await insertRows("card_events", cards.map((card) => ({
              card_id: card.id,
              provider_event_id: stored.provider_event_id,
              idempotency_key: `increase-freeze:${event.id}:${card.id}`,
              event_type: "FROZEN",
              occurred_at: event.created_at,
              details: { reason: "ACH funding recalled" },
            })), { ignoreDuplicates: true });
          }
        }
      }
    }
    await recordProcessingAttempt(stored.provider_event_id, "SUCCEEDED");
    return Response.json({ received: true });
  } catch (error) {
    await recordProcessingAttempt(stored.provider_event_id, "RETRYABLE_FAILURE", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
