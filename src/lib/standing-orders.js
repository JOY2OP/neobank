import "server-only";

import { DEMO_IDS } from "./demo-users";
import { submitPaymentRequest } from "./payments";
import { callRpc, selectRows } from "./supabase";

function isScheduledForDate(order, date) {
  const start = new Date(`${order.starts_on}T00:00:00Z`);
  const target = new Date(`${date}T00:00:00Z`);
  if (target < start || (order.ends_on && date > order.ends_on)) return false;
  if (order.schedule_rule === "WEEKLY") return start.getUTCDay() === target.getUTCDay();
  return start.getUTCDate() === target.getUTCDate();
}

async function availableBalance(accountId) {
  const rows = await selectRows("business_account_balances", `business_account_id=eq.${accountId}`);
  return Number(rows[0]?.available_balance_cents || 0);
}

async function recordAttempt(occurrenceId, number, type, extra = {}) {
  return callRpc("record_standing_order_attempt", {
    p_occurrence_id: occurrenceId,
    p_attempt_number: number,
    p_event_type: type,
    p_occurred_at: extra.occurredAt || new Date().toISOString(),
    p_idempotency_key: `standing-attempt:${occurrenceId}:${number}:${type}`,
    p_payment_request_id: extra.paymentRequestId || null,
    p_retry_at: extra.retryAt || null,
  });
}

async function runAttempt(order, occurrenceId, attemptNumber) {
  await recordAttempt(occurrenceId, attemptNumber, "STARTED");
  if ((await availableBalance(order.business_account_id)) < order.amount_cents) {
    await recordAttempt(occurrenceId, attemptNumber, "INSUFFICIENT_FUNDS");
    if (attemptNumber === 1) {
      const scheduledAt = new Date();
      const retryAt = new Date(scheduledAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
      await recordAttempt(occurrenceId, 1, "RETRY_SCHEDULED", {
        occurredAt: scheduledAt.toISOString(),
        retryAt,
      });
      return "RETRY_SCHEDULED";
    }

    await recordAttempt(occurrenceId, 2, "FAILED");
    await callRpc("pause_standing_order", {
      p_standing_order_id: order.id,
      p_actor_id: DEMO_IDS.system,
      p_reason: "The scheduled payment failed twice because funds were insufficient.",
      p_idempotency_key: `standing-pause:${occurrenceId}`,
    });
    return "PAUSED";
  }

  const created = await callRpc("create_payment_request", {
    p_business_account_id: order.business_account_id,
    p_beneficiary_id: order.beneficiary_id,
    p_rail_code: order.rail_code,
    p_initiated_by_actor_id: order.created_by_actor_id,
    p_amount_cents: order.amount_cents,
    p_requested_execution_date: new Date().toISOString().slice(0, 10),
    p_idempotency_key: `standing-payment:${occurrenceId}`,
    p_memo: "Scheduled payment",
  });
  const request = Array.isArray(created) ? created[0] : created;
  if (!request.requires_approval) await submitPaymentRequest(request.payment_request_id, DEMO_IDS.system);
  await recordAttempt(occurrenceId, attemptNumber, "SUBMITTED", {
    paymentRequestId: request.payment_request_id,
  });
  return request.requires_approval ? "PENDING_APPROVAL" : "SUBMITTED";
}

export async function runDueStandingOrders(now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const orders = await selectRows("current_standing_orders", "status=eq.CREATED");
  const results = [];

  for (const order of orders.filter((item) => isScheduledForDate(item, today))) {
    const result = await callRpc("create_standing_order_occurrence", {
      p_standing_order_id: order.id,
      p_scheduled_for: today,
      p_idempotency_key: `standing-occurrence:${order.id}:${today}`,
    });
    const occurrence = Array.isArray(result) ? result[0] : result;
    if (occurrence.inserted) {
      results.push({ orderId: order.id, status: await runAttempt(order, occurrence.occurrence_id, 1) });
    }
  }

  const retries = await selectRows(
    "standing_order_attempt_events",
    `event_type=eq.RETRY_SCHEDULED&retry_at=lte.${encodeURIComponent(now.toISOString())}`,
  );
  for (const retry of retries) {
    const existing = await selectRows(
      "standing_order_attempt_events",
      `occurrence_id=eq.${retry.occurrence_id}&attempt_number=eq.2`,
    );
    if (existing.length) continue;
    const occurrences = await selectRows("standing_order_occurrences", `id=eq.${retry.occurrence_id}`);
    const matchingOrders = await selectRows("current_standing_orders", `id=eq.${occurrences[0].standing_order_id}`);
    results.push({
      orderId: matchingOrders[0].id,
      status: await runAttempt(matchingOrders[0], retry.occurrence_id, 2),
    });
  }
  return results;
}
