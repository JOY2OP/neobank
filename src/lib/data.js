import "server-only";

import { DEMO_IDS } from "./demo-users";
import { callRpc, isSupabaseConfigured, selectRows } from "./supabase";
import { providerMode } from "./providers/config";

function first(rows) {
  return Array.isArray(rows) ? rows[0] || null : rows;
}

export async function getCustomerDashboard(user) {
  if (!isSupabaseConfigured()) return { configured: false, error: "Add the Supabase values from .env.example." };

  try {
    const cardFilter = user.role === "OWNER"
      ? `business_account_id=eq.${DEMO_IDS.account}&provider_code=in.(lithic,simulator)`
      : `cardholder_actor_id=eq.${user.actorId}&provider_code=in.(lithic,simulator)`;
    const requestFilter = user.role === "OWNER"
      ? `business_account_id=eq.${DEMO_IDS.account}`
      : `initiated_by_actor_id=eq.${user.actorId}`;
    const orderFilter = user.role === "OWNER"
      ? `business_account_id=eq.${DEMO_IDS.account}`
      : `business_account_id=eq.${DEMO_IDS.account}&created_by_actor_id=eq.${user.actorId}`;

    const [cards, requests, beneficiaries, orders, fundingPayments] = await Promise.all([
      selectRows("cards", `select=*&${cardFilter}&order=created_at.desc`),
      selectRows("payment_request_status", `select=*&${requestFilter}&order=created_at.desc`),
      selectRows("beneficiaries", `select=*&organization_id=eq.${DEMO_IDS.organization}`),
      selectRows("current_standing_orders", `select=*&${orderFilter}&order=created_at.desc`),
      user.role === "OWNER"
        ? selectRows("payments", `select=*&business_account_id=eq.${DEMO_IDS.account}&direction=eq.INBOUND&provider_code=eq.increase&order=created_at.desc&limit=10`)
        : Promise.resolve([]),
    ]);

    const cardIds = cards.map((card) => card.id);
    const orderIds = orders.map((order) => order.id);
    const fundingPaymentIds = fundingPayments.map((payment) => payment.id);
    const [balances, accountStatus, cardStatuses, settlements, banks, bankEvents, holds, activity, kyb, fundingStatuses] = await Promise.all([
      user.role === "OWNER" ? selectRows("business_account_balances", `business_account_id=eq.${DEMO_IDS.account}`) : Promise.resolve([]),
      selectRows("current_business_account_status", `business_account_id=eq.${DEMO_IDS.account}`),
      cardIds.length ? selectRows("current_card_status", `card_id=in.(${cardIds.join(",")})`) : Promise.resolve([]),
      cardIds.length ? selectRows("card_settlements", `card_id=in.(${cardIds.join(",")})&order=recorded_at.desc&limit=50`) : Promise.resolve([]),
      user.role === "OWNER" ? selectRows("external_bank_accounts", `select=*&organization_id=eq.${DEMO_IDS.organization}`) : Promise.resolve([]),
      user.role === "OWNER" ? selectRows("external_bank_account_events", "select=*&order=recorded_at.desc") : Promise.resolve([]),
      user.role === "OWNER" ? selectRows("active_card_holds", `business_account_id=eq.${DEMO_IDS.account}`) : Promise.resolve([]),
      user.role === "OWNER" ? selectRows("business_account_activity", `business_account_id=eq.${DEMO_IDS.account}&order=booked_at.desc&limit=50`) : Promise.resolve([]),
      user.role === "OWNER" ? selectRows("current_kyb_status", `organization_id=eq.${DEMO_IDS.organization}`) : Promise.resolve([]),
      fundingPaymentIds.length
        ? selectRows("current_payment_status", `select=*&payment_id=in.(${fundingPaymentIds.join(",")})`)
        : Promise.resolve([]),
    ]);

    const occurrences = orderIds.length
      ? await selectRows("standing_order_occurrences", `standing_order_id=in.(${orderIds.join(",")})`)
      : [];
    const occurrenceIds = occurrences.map((occurrence) => occurrence.id);
    const attemptRows = occurrenceIds.length
      ? await selectRows("standing_order_attempt_events", `occurrence_id=in.(${occurrenceIds.join(",")})&order=recorded_at.desc&limit=50`)
      : [];
    const occurrenceOrders = new Map(occurrences.map((occurrence) => [occurrence.id, occurrence.standing_order_id]));
    const attempts = attemptRows.map((attempt) => ({
      ...attempt,
      standing_order_id: occurrenceOrders.get(attempt.occurrence_id),
    }));
    const statuses = new Map(cardStatuses.map((row) => [row.card_id, row.status]));
    const fundingStatusByPayment = new Map(fundingStatuses.map((row) => [row.payment_id, row]));
    const employeeActivity = [
      ...settlements.map((settlement) => ({
        id: settlement.id,
        amount_cents: settlement.amount_cents,
        created_at: settlement.recorded_at,
        description: "Card purchase",
        status: "SETTLED",
        entry_kind: "CARD_SETTLEMENT",
      })),
      ...requests,
    ].sort((left, right) => new Date(right.created_at) - new Date(left.created_at));
    return {
      configured: true,
      balance: first(balances) || {},
      accountStatus: first(accountStatus),
      cards: cards.map((card) => ({ ...card, status: statuses.get(card.id) || "UNKNOWN" })),
      banks: banks.map((bank) => ({
        ...bank,
        connection: bankEvents.find((event) => event.external_bank_account_id === bank.id)?.details || {},
      })),
      fundingPulls: fundingPayments.map((payment) => ({
        ...payment,
        status: fundingStatusByPayment.get(payment.id)?.status || "UNKNOWN",
        value_date: fundingStatusByPayment.get(payment.id)?.value_date || null,
      })),
      requests,
      beneficiaries,
      orders,
      attempts,
      holds,
      activity: user.role === "OWNER" ? activity : employeeActivity,
      kyb: first(kyb),
    };
  } catch (error) {
    return { configured: true, error: error.message };
  }
}

export async function getApprovalQueue() {
  const requests = await selectRows(
    "payment_request_status",
    `select=*&business_account_id=eq.${DEMO_IDS.account}&status=in.(PENDING_APPROVAL,APPROVED)&order=created_at.asc`,
  );
  const actors = await selectRows("actors", "select=id,display_name");
  const beneficiaries = await selectRows("beneficiaries", "select=id,display_name");
  const actorNames = new Map(actors.map((actor) => [actor.id, actor.display_name]));
  const beneficiaryNames = new Map(beneficiaries.map((item) => [item.id, item.display_name]));
  return requests.map((request) => ({
    ...request,
    initiator_name: actorNames.get(request.initiated_by_actor_id) || "Unknown",
    beneficiary_name: beneficiaryNames.get(request.beneficiary_id) || "Unknown",
  }));
}

export async function getOpsDashboard() {
  if (!isSupabaseConfigured()) return { configured: false, error: "Add the Supabase values from .env.example." };
  const names = ["provider deliveries", "processing outcomes", "reconciliation runs", "reconciliation breaks", "settlements", "standing orders"];
  const settled = await Promise.allSettled([
    selectRows("provider_events", "select=*&order=received_at.desc&limit=50"),
    selectRows("current_provider_event_status", "select=*"),
    selectRows("reconciliation_runs", "select=*&order=started_at.desc&limit=20"),
    selectRows("latest_reconciliation_breaks", "select=*&order=age_days.desc"),
    selectRows("card_settlements", "select=*&order=recorded_at.desc&limit=30"),
    selectRows("current_standing_orders", "select=*&order=created_at.desc"),
  ]);
  const values = settled.map((item) => item.status === "fulfilled" ? item.value : []);
  const issues = settled.flatMap((item, index) => item.status === "rejected"
    ? [`${names[index]} unavailable: ${item.reason?.message || "unknown error"}`]
    : []);
  if (issues.length === settled.length) {
    return { configured: true, error: "Operations data is temporarily unavailable. Financial state was not changed." };
  }

  const [events, statuses, runs, breaks, settlements, orders] = values;
  const statusMap = new Map(statuses.map((status) => [status.provider_event_id, status]));
  const enrichedEvents = events.map((event) => ({ ...event, processing: statusMap.get(event.id) }));
  return {
    configured: true,
    events: enrichedEvents,
    runs,
    breaks,
    settlements,
    orders,
    issues,
    degradedProviders: enrichedEvents
      .filter((event) => ["RETRYABLE_FAILURE", "TERMINAL_FAILURE"].includes(event.processing?.status))
      .map((event) => event.provider_code)
      .filter((provider, index, providers) => providers.indexOf(provider) === index),
  };
}

export async function getStatement({ start, end, knownAt }) {
  return callRpc("statement_lines", {
    p_business_account_id: DEMO_IDS.account,
    p_period_start: start,
    p_period_end: end,
    p_known_at: knownAt,
  });
}

export async function getCoreLoopState() {
  const [kybCases, kybEvents, businessEvents, banks, bankEvents, payments, paymentStatuses, cards, authorizations, activeHolds, settlements, settlementEvents, requests, runs, breaks] = await Promise.all([
    selectRows("kyb_cases", `select=*&organization_id=eq.${DEMO_IDS.organization}&provider_code=eq.persona&order=created_at.desc`),
    selectRows("kyb_events", "select=*&order=recorded_at.desc"),
    selectRows("business_account_events", `select=*&business_account_id=eq.${DEMO_IDS.account}&event_type=eq.OPENED&order=recorded_at.desc`),
    selectRows("external_bank_accounts", `select=*&organization_id=eq.${DEMO_IDS.organization}&provider_code=eq.plaid&order=created_at.desc`),
    selectRows("external_bank_account_events", "select=*&order=recorded_at.desc"),
    selectRows("payments", `select=*&business_account_id=eq.${DEMO_IDS.account}&order=created_at.desc`),
    selectRows("current_payment_status", "select=*"),
    selectRows("cards", `select=*&business_account_id=eq.${DEMO_IDS.account}&provider_code=eq.lithic&order=created_at.desc`),
    selectRows("card_authorizations", "select=*&provider_code=eq.lithic&order=first_seen_at.desc"),
    selectRows("active_card_holds", `select=*&business_account_id=eq.${DEMO_IDS.account}&order=last_recorded_at.desc`),
    selectRows("card_settlements", "select=*&provider_code=eq.lithic&order=recorded_at.desc"),
    selectRows("card_settlement_events", "select=*&event_type=eq.REVERSED&order=recorded_at.desc"),
    selectRows("payment_request_status", `select=*&business_account_id=eq.${DEMO_IDS.account}&initiated_by_actor_id=eq.${DEMO_IDS.john}&order=created_at.desc`),
    selectRows("reconciliation_runs", "select=*&provider_code=eq.lithic&order=started_at.desc"),
    selectRows("latest_reconciliation_breaks", "select=*&order=age_days.desc"),
  ]);
  const caseIds = new Set(kybCases.map((item) => item.id));
  const cardIds = new Set(cards.map((item) => item.id));
  const activeAuthorizationIds = new Set(activeHolds.map((item) => item.authorization_id));
  const auth = authorizations.find((item) => cardIds.has(item.card_id) && activeAuthorizationIds.has(item.id));
  const settlement = settlements.find((item) => cardIds.has(item.card_id));
  const reversedIds = new Set(settlementEvents.map((item) => item.settlement_id));
  const outbound = payments.find((item) => item.direction === "OUTBOUND" && item.provider_code === "increase");
  const paymentStatus = new Map(paymentStatuses.map((item) => [item.payment_id, item.status]));
  const kyb = kybEvents.find((item) => caseIds.has(item.kyb_case_id)) || null;
  return {
    modes: Object.fromEntries(["persona", "plaid", "increase", "lithic"].map((name) => [name, providerMode(name)])),
    kyb,
    kybCase: kybCases[0] || null,
    accountOpened: Boolean(kyb?.provider_event_id && businessEvents.some((item) => item.provider_event_id === kyb.provider_event_id)),
    bank: banks[0] || null,
    bankEvent: bankEvents.find((item) => item.external_bank_account_id === banks[0]?.id) || null,
    funding: (() => { const item = payments.find((row) => row.direction === "INBOUND" && row.provider_code === "increase"); return item ? { ...item, status: paymentStatus.get(item.id) || "SUBMITTED" } : null; })(),
    card: cards[0] || null,
    authorization: auth || null,
    settlement: settlement || null,
    outboundRequest: requests[0] || null,
    outbound: outbound ? { ...outbound, status: paymentStatus.get(outbound.id) || "SUBMITTED" } : null,
    reversal: settlement && reversedIds.has(settlement.id),
    reconciliation: runs[0] || null,
    breaks,
  };
}
