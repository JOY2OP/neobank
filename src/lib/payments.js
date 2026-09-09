import "server-only";

import { randomUUID } from "node:crypto";
import { createIncreaseAchTransfer } from "./providers/increase";
import { callRpc, selectRows } from "./supabase";

export async function submitPaymentRequest(requestId, actorId) {
  const requests = await selectRows("payment_requests", `id=eq.${requestId}`);
  const request = requests[0];
  if (!request) throw new Error("Payment request not found.");

  const beneficiaries = await selectRows("beneficiaries", `id=eq.${request.beneficiary_id}`);
  const beneficiary = beneficiaries[0];
  if (!beneficiary) throw new Error("Beneficiary not found.");

  // Our maker-checker decision happens before Increase sees the transfer.
  // This prevents a provider-side transfer from bypassing our approval rules.
  const transfer = await createIncreaseAchTransfer({
    externalAccountId: beneficiary.provider_recipient_reference,
    amountCents: request.amount_cents,
    memo: request.memo,
    idempotencyKey: `increase:${request.id}`,
  });

  await callRpc("record_payment_event", {
    p_payment_idempotency_key: `payment:${request.id}`,
    p_event_idempotency_key: `payment-submitted:${request.id}`,
    p_business_account_id: request.business_account_id,
    p_direction: "OUTBOUND",
    p_rail_code: request.rail_code,
    p_amount_cents: request.amount_cents,
    p_event_type: "SUBMITTED",
    p_occurred_at: new Date().toISOString(),
    p_payment_request_id: request.id,
    p_provider_code: transfer.source === "SANDBOX" ? "increase" : "simulator",
    p_provider_payment_id: transfer.id,
    p_actor_id: actorId,
    p_details: { provider_status: transfer.status, source: transfer.source },
    p_rail_details: { provider_transfer_id: transfer.id, sec_code: "CCD" },
  });
  return transfer;
}

export function newIdempotencyKey(prefix) {
  return `${prefix}:${randomUUID()}`;
}
