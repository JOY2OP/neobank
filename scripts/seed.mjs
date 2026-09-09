import { createHash } from "node:crypto";

const baseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!baseUrl || !serviceKey) {
  throw new Error("Copy .env.example to .env and add the Supabase values before seeding.");
}

const ids = {
  organization: "10000000-0000-4000-8000-000000000001",
  account: "10000000-0000-4000-8000-000000000002",
  sarah: "10000000-0000-4000-8000-000000000010",
  john: "10000000-0000-4000-8000-000000000011",
  ops: "10000000-0000-4000-8000-000000000012",
  system: "10000000-0000-4000-8000-000000000013",
  agent: "10000000-0000-4000-8000-000000000014",
  customerLedger: "10000000-0000-4000-8000-000000000020",
  achClearing: "10000000-0000-4000-8000-000000000021",
  cardPayable: "10000000-0000-4000-8000-000000000022",
  sarahCard: "10000000-0000-4000-8000-000000000030",
  johnCard: "10000000-0000-4000-8000-000000000031",
  beneficiary: "10000000-0000-4000-8000-000000000040",
  activeOrder: "10000000-0000-4000-8000-000000000050",
  retryOrder: "10000000-0000-4000-8000-000000000051",
  kybCase: "10000000-0000-4000-8000-000000000060",
  bank: "10000000-0000-4000-8000-000000000070",
};

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function insert(table, rows, onConflict = "id") {
  const conflictTarget = encodeURIComponent(onConflict);
  return request(`${table}?on_conflict=${conflictTarget}`, {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    body: JSON.stringify(rows),
  });
}

function rpc(name, parameters) {
  return request(`rpc/${name}`, { method: "POST", body: JSON.stringify(parameters) });
}

const now = new Date();
const today = now.toISOString().slice(0, 10);
// Fixed financial dates keep idempotent journal commands identical on every run.
const historyDate = "2026-09-08";
const retryOccurrenceDate = "2026-09-09";
const retryOccurredAt = "2026-09-09T12:00:00.000Z";
const retryAt = "2026-09-10T12:00:00.000Z";

console.log("Seeding Corgi's append-only demo workspace…");

await insert("actors", [
  { id: ids.sarah, kind: "HUMAN", display_name: "Sarah Chen" },
  { id: ids.john, kind: "HUMAN", display_name: "John Miller" },
  { id: ids.ops, kind: "HUMAN", display_name: "Maya Patel" },
  { id: ids.system, kind: "SYSTEM", display_name: "Corgi Scheduler" },
  { id: ids.agent, kind: "AGENT", display_name: "Corgi MCP Agent" },
]);
await insert("organizations", [{ id: ids.organization, legal_name: "Acme Inc." }]);
await insert("organization_memberships", [
  { organization_id: ids.organization, actor_id: ids.sarah, role: "OWNER" },
  { organization_id: ids.organization, actor_id: ids.john, role: "MAKER" },
  { organization_id: ids.organization, actor_id: ids.system, role: "MAKER" },
  { organization_id: ids.organization, actor_id: ids.agent, role: "MAKER" },
], "organization_id,actor_id");
await insert("organization_settings", [{ organization_id: ids.organization, approval_threshold_cents: 100000 }], "organization_id");

await insert("kyb_cases", [{ id: ids.kybCase, organization_id: ids.organization, provider_code: "simulator", external_case_id: "kyb_seed_acme" }]);
await insert("kyb_events", [{
  kyb_case_id: ids.kybCase,
  idempotency_key: "seed:kyb-approved",
  event_type: "APPROVED",
  provider_status: "approved",
  occurred_at: now.toISOString(),
  details: { source: "SIMULATED", note: "Use Persona sandbox for the live inquiry." },
}], "idempotency_key");
await insert("business_accounts", [{ id: ids.account, organization_id: ids.organization, account_name: "Operating account" }]);
await insert("business_account_events", [{
  business_account_id: ids.account,
  actor_id: ids.system,
  idempotency_key: "seed:account-opened",
  event_type: "OPENED",
  occurred_at: now.toISOString(),
  details: { source: "SEED" },
}], "idempotency_key");

ids.customerLedger = await rpc("create_ledger_account", {
  p_external_key: "ACME:CUSTOMER_DEPOSIT",
  p_account_class: "LIABILITY",
  p_purpose: "CUSTOMER_DEPOSIT",
  p_name: "Acme customer deposits",
  p_organization_id: ids.organization,
  p_business_account_id: ids.account,
  p_is_primary: true,
});
ids.achClearing = await rpc("create_ledger_account", {
  p_external_key: "PLATFORM:ACH_CLEARING",
  p_account_class: "ASSET",
  p_purpose: "RAIL_CLEARING",
  p_name: "ACH clearing",
  p_rail_code: "ACH",
});
ids.cardPayable = await rpc("create_ledger_account", {
  p_external_key: "PLATFORM:SIMULATOR_CARD_NETWORK_PAYABLE",
  p_account_class: "LIABILITY",
  p_purpose: "CARD_NETWORK_PAYABLE",
  p_name: "Simulator card payable",
  p_provider_code: "simulator",
});
await rpc("post_journal_entry", {
  p_posting_key: "seed:initial-funding",
  p_entry_kind: "ACH_SETTLEMENT",
  p_value_date: historyDate,
  p_description: "Opening ACH funding from Chase",
  p_postings: [
    { ledger_account_id: ids.achClearing, side: "DEBIT", amount_cents: 25000000 },
    { ledger_account_id: ids.customerLedger, side: "CREDIT", amount_cents: 25000000 },
  ],
  p_external_reference: "seed_funding_001",
  p_created_by_actor_id: ids.system,
  p_metadata: { source: "SEED" },
});

await insert("external_bank_accounts", [{ id: ids.bank, organization_id: ids.organization, provider_code: "simulator", provider_account_id: "plaid_seed_account", institution_name: "Chase", account_name: "Business Complete Banking", account_mask: "4821" }]);
await insert("external_bank_account_events", [{ external_bank_account_id: ids.bank, idempotency_key: "seed:bank-linked", event_type: "VERIFIED", occurred_at: now.toISOString(), details: { source: "SIMULATED", increase_external_account_id: "external_account_seed" } }], "idempotency_key");
await insert("cards", [
  { id: ids.sarahCard, business_account_id: ids.account, cardholder_actor_id: ids.sarah, provider_code: "simulator", provider_card_id: "card_seed_sarah", last4: "1048" },
  { id: ids.johnCard, business_account_id: ids.account, cardholder_actor_id: ids.john, provider_code: "simulator", provider_card_id: "card_seed_john", last4: "8842" },
]);
await insert("card_events", [
  { card_id: ids.sarahCard, actor_id: ids.sarah, idempotency_key: "seed:sarah-card-active", event_type: "ACTIVATED", occurred_at: now.toISOString(), details: { source: "SIMULATED" } },
  { card_id: ids.johnCard, actor_id: ids.sarah, idempotency_key: "seed:john-card-active", event_type: "ACTIVATED", occurred_at: now.toISOString(), details: { source: "SIMULATED" } },
], "idempotency_key");
await insert("beneficiaries", [{ id: ids.beneficiary, organization_id: ids.organization, rail_code: "ACH", display_name: "Northstar Office Supply", provider_recipient_reference: "external_account_seed_vendor", account_mask: "0194" }]);

// Seed the exact auth -> over-capture -> correction path used in the debrief.
await rpc("record_authorization_event", { p_provider_code: "simulator", p_provider_authorization_id: "auth_seed_settled", p_card_id: ids.johnCard, p_event_type: "AUTHORIZED", p_authorized_total_cents: 5000, p_occurred_at: now.toISOString(), p_idempotency_key: "seed:history-auth", p_merchant_name: "Corgi Fuel Stop", p_merchant_category_code: "5542", p_details: { source: "SIMULATED" } });
const settlement = await rpc("record_card_settlement", { p_provider_code: "simulator", p_provider_settlement_id: "settlement_demo_history", p_card_id: ids.johnCard, p_external_authorization_id: "auth_seed_settled", p_amount_cents: 7340, p_value_date: historyDate, p_occurred_at: now.toISOString(), p_explicit_force_post: false, p_is_final_capture: true, p_idempotency_key: "seed:history-settlement", p_actor_id: ids.system });
await rpc("reverse_card_settlement", { p_settlement_id: settlement[0].settlement_id, p_idempotency_key: "seed:history-reversal", p_value_date: historyDate, p_reason: "Merchant correction learned after settlement", p_actor_id: ids.system });
await rpc("record_card_settlement", { p_provider_code: "simulator", p_provider_settlement_id: "settlement_ledger_only", p_card_id: ids.sarahCard, p_external_authorization_id: null, p_amount_cents: 2199, p_value_date: historyDate, p_occurred_at: now.toISOString(), p_explicit_force_post: true, p_is_final_capture: true, p_idempotency_key: "seed:ledger-only-settlement", p_actor_id: ids.system });
await rpc("record_authorization_event", { p_provider_code: "simulator", p_provider_authorization_id: "auth_seed_active_hold", p_card_id: ids.johnCard, p_event_type: "AUTHORIZED", p_authorized_total_cents: 5000, p_occurred_at: now.toISOString(), p_idempotency_key: "seed:active-hold", p_merchant_name: "Golden Gate Fuel", p_merchant_category_code: "5542", p_details: { source: "SIMULATED" } });

await rpc("create_payment_request", { p_business_account_id: ids.account, p_beneficiary_id: ids.beneficiary, p_rail_code: "ACH", p_initiated_by_actor_id: ids.john, p_amount_cents: 250000, p_requested_execution_date: today, p_idempotency_key: "seed:pending-payment", p_memo: "September office equipment" });

await insert("standing_orders", [
  { id: ids.activeOrder, business_account_id: ids.account, beneficiary_id: ids.beneficiary, rail_code: "ACH", created_by_actor_id: ids.sarah, amount_cents: 85000, schedule_rule: "MONTHLY", starts_on: today },
  { id: ids.retryOrder, business_account_id: ids.account, beneficiary_id: ids.beneficiary, rail_code: "ACH", created_by_actor_id: ids.john, amount_cents: 99999999, schedule_rule: "MONTHLY", starts_on: today },
]);
await insert("standing_order_events", [
  { standing_order_id: ids.activeOrder, actor_id: ids.sarah, idempotency_key: "seed:active-order", event_type: "CREATED", occurred_at: now.toISOString(), details: { name: "Monthly software bill" } },
  { standing_order_id: ids.retryOrder, actor_id: ids.john, idempotency_key: "seed:retry-order", event_type: "CREATED", occurred_at: now.toISOString(), details: { name: "Large vendor payment" } },
], "idempotency_key");
const occurrence = await rpc("create_standing_order_occurrence", { p_standing_order_id: ids.retryOrder, p_scheduled_for: retryOccurrenceDate, p_idempotency_key: `seed:retry-occurrence:${retryOccurrenceDate}` });
const occurrenceId = occurrence[0].occurrence_id;
for (const type of ["STARTED", "INSUFFICIENT_FUNDS"]) {
  await rpc("record_standing_order_attempt", { p_occurrence_id: occurrenceId, p_attempt_number: 1, p_event_type: type, p_occurred_at: retryOccurredAt, p_idempotency_key: `seed:retry:${retryOccurrenceDate}:${type}` });
}
await rpc("record_standing_order_attempt", { p_occurrence_id: occurrenceId, p_attempt_number: 1, p_event_type: "RETRY_SCHEDULED", p_occurred_at: retryOccurredAt, p_idempotency_key: `seed:retry:${retryOccurrenceDate}:scheduled`, p_retry_at: retryAt });

const providerEvent = await rpc("ingest_provider_event", { p_provider_code: "simulator", p_provider_account: "seed", p_environment: "SIMULATED", p_external_event_id: "event_seed_001", p_event_type: "issuing.authorization.created", p_provider_created_at: now.toISOString(), p_signature_verified: true, p_payload: { seeded: true } });
await rpc("record_provider_event_attempt", { p_provider_event_id: providerEvent[0].provider_event_id, p_attempt_number: 1, p_outcome: "SUCCEEDED", p_started_at: now.toISOString(), p_completed_at: now.toISOString(), p_details: { seeded: true } });

const reconciliationRows = [
  { processor_reference: "settlement_demo_history", amount_cents: 7000, value_date: historyDate },
  { processor_reference: "file_only_break", amount_cents: 4299, value_date: historyDate },
];
await rpc("run_scheme_reconciliation", { p_provider_code: "simulator", p_settlement_date: historyDate, p_file_reference: "seed-scheme-file.csv", p_file_hash: createHash("sha256").update(JSON.stringify(reconciliationRows)).digest("hex"), p_rows: reconciliationRows });

const balances = await request(`business_account_balances?business_account_id=eq.${ids.account}`);
const [kybStatus, accountStatus, cardStatuses, activeHoldAuthorizations, paymentRequests, reconciliationBreaks, standingOrderAttempts] = await Promise.all([
  request(`current_kyb_status?organization_id=eq.${ids.organization}`),
  request(`current_business_account_status?business_account_id=eq.${ids.account}`),
  request(`current_card_status?card_id=in.(${ids.sarahCard},${ids.johnCard})`),
  request("card_authorizations?provider_code=eq.simulator&provider_authorization_id=eq.auth_seed_active_hold&select=id,card_hold_events(delta_cents,is_terminal)"),
  request("payment_request_status?idempotency_key=eq.seed%3Apending-payment"),
  request("latest_reconciliation_breaks?select=break_type"),
  request(`standing_order_attempt_events?occurrence_id=eq.${occurrenceId}`),
]);

const activeHoldCents = activeHoldAuthorizations[0]?.card_hold_events
  ?.filter((event) => !event.is_terminal)
  .reduce((sum, event) => sum + Number(event.delta_cents), 0);
const expectedBreakTypes = new Set(reconciliationBreaks.map((item) => item.break_type));
const expectedAttemptTypes = new Set(standingOrderAttempts.map((item) => item.event_type));
const checks = {
  "KYB approved": kybStatus[0]?.status === "APPROVED",
  "Account opened": accountStatus[0]?.status === "OPENED",
  "Two active cards": cardStatuses.filter((item) => item.status === "ACTIVATED").length === 2,
  "$50 active hold": activeHoldCents === 5000,
  "Maker-checker request exists": paymentRequests[0]?.requires_approval === true,
  "Three reconciliation cases": ["IN_FILE_NOT_LEDGER", "IN_LEDGER_NOT_FILE", "AMOUNT_MISMATCH"].every((type) => expectedBreakTypes.has(type)),
  "NSF retry scheduled": ["STARTED", "INSUFFICIENT_FUNDS", "RETRY_SCHEDULED"].every((type) => expectedAttemptTypes.has(type)),
};
const failedChecks = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
if (failedChecks.length) {
  throw new Error(`Seed verification failed: ${failedChecks.join(", ")}`);
}

console.log("Seed complete and safe to run again.");
console.table({ Sarah: ids.sarah, John: ids.john, Ops: ids.ops, Account: ids.account, "Ledger cents": balances[0]?.ledger_balance_cents, "Available cents": balances[0]?.available_balance_cents });
console.log(`Verified ${Object.keys(checks).length} core-loop fixtures.`);
console.log("Demo URLs: /login, /app, /app/approvals, /ops/demo-lab");
