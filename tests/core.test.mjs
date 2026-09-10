import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Lithic from "lithic";
import { increasePaymentEventKey, increasePaymentEventType, increasePaymentValueDate } from "../src/lib/increase-transfer-state.js";
import { lithicTransactionCommands } from "../src/lib/lithic-events.js";
import { buildLithicAuthorizationRequest, waitForLithicTransaction } from "../src/lib/lithic-simulation.js";
import { dollarsToCents, formatUsd } from "../src/lib/money.js";
import { verifyIncreaseSignature, verifyPersonaSignature } from "../src/lib/hmac-signatures.js";
import { createSignedSessionValue, readSignedSessionSlug } from "../src/lib/session-signature.js";

test("USD input becomes integer cents", () => {
  assert.equal(dollarsToCents("73.40"), 7340);
  assert.equal(dollarsToCents("5"), 500);
  assert.equal(formatUsd(7340), "$73.40");
});

test("invalid money input is rejected", () => {
  for (const value of ["0", "-1", "1.234", "ten", ""]) {
    assert.throws(() => dollarsToCents(value));
  }
});

test("Lithic authorization supplies merchant amount with merchant currency", () => {
  const request = buildLithicAuthorizationRequest({
    pan: "4111111111111111",
    amountCents: 5000,
    descriptor: "Corgi Fuel Stop",
  });

  assert.equal(request.amount, 5000);
  assert.equal(request.merchant_amount, 5000);
  assert.equal(request.merchant_currency, "USD");
  assert.equal(request.descriptor, "CORGI FUEL STOP");
});

test("Lithic transaction reads retry temporary Sandbox 404s", async () => {
  let attempts = 0;
  const transaction = await waitForLithicTransaction({
    token: "transaction_test",
    eventType: "AUTHORIZATION",
    delays: [0, 0, 0],
    retrieve: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("Transaction not found"), { status: 404 });
      return { token: "transaction_test", events: [{ type: "AUTHORIZATION" }] };
    },
  });

  assert.equal(attempts, 3);
  assert.equal(transaction.token, "transaction_test");
});

test("a signed demo cookie rejects identity tampering", () => {
  const secret = "a-test-secret";
  const cookie = createSignedSessionValue("sarah", secret);
  assert.equal(readSignedSessionSlug(cookie, secret), "sarah");
  assert.equal(readSignedSessionSlug(cookie.replace("sarah", "ops"), secret), null);
  assert.equal(readSignedSessionSlug(`${cookie}.extra`, secret), null);
});

test("provider HMAC checks accept current signatures and reject stale ones", () => {
  const body = '{"id":"event_test"}';
  const secret = "webhook-secret";
  const now = Math.floor(Date.now() / 1000);
  const persona = createHmac("sha256", secret).update(`${now}.${body}`).digest("hex");
  assert.equal(verifyPersonaSignature(body, `t=${now},v1=${persona}`, secret), true);

  const increase = createHmac("sha256", secret).update(`event_test.${now}.${body}`).digest("base64");
  const headers = new Headers({
    "webhook-id": "event_test",
    "webhook-timestamp": String(now),
    "webhook-signature": `v1,${increase}`,
  });
  assert.equal(verifyIncreaseSignature(body, headers, secret), true);
  assert.equal(verifyPersonaSignature(body, `t=${now - 301},v1=${persona}`, secret), false);
});

test("Lithic webhook signatures are verified against the untouched body", () => {
  const body = '{"event_type":"card_transaction.updated","token":"transaction_test"}';
  const id = "event_lithic_test";
  const now = Math.floor(Date.now() / 1000);
  const key = Buffer.from("lithic-webhook-test-key");
  const secret = `whsec_${key.toString("base64")}`;
  const signature = createHmac("sha256", key).update(`${id}.${now}.${body}`).digest("base64");
  const client = new Lithic({ apiKey: "sandbox-test-key", environment: "sandbox" });
  const parsed = client.webhooks.parse(body, {
    secret,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(now),
      "webhook-signature": `v1,${signature}`,
    },
  });
  assert.equal(parsed.event_type, "card_transaction.updated");
  assert.throws(() => client.webhooks.parse(`${body} `, {
    secret,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": String(now),
      "webhook-signature": `v1,${signature}`,
    },
  }));
});

test("Increase settlement is detected from the settlement timestamp", () => {
  const transfer = {
    id: "ach_transfer_test",
    status: "submitted",
    settlement: { settled_at: "2026-09-09T12:00:00Z" },
    submission: { effective_date: "2026-09-08" },
  };
  assert.equal(increasePaymentEventType(transfer), "SETTLED");
  assert.equal(
    increasePaymentEventKey(transfer, "SETTLED", "event_test"),
    "increase:ach_transfer_test:settled:2026-09-09T12:00:00Z",
  );
  assert.equal(increasePaymentValueDate(transfer, "SETTLED", "2026-09-10T00:00:00Z"), "2026-09-09");
});

test("Increase returns take precedence over settlement", () => {
  const transfer = {
    id: "ach_transfer_returned",
    status: "submitted",
    settlement: { settled_at: "2026-09-09T12:00:00Z" },
    return: { reason: "insufficient_fund" },
  };
  assert.equal(increasePaymentEventType(transfer), "RETURNED");
});

test("Lithic authorization advice becomes an incremental total", () => {
  const commands = lithicTransactionCommands({
    token: "transaction_incremental",
    result: "APPROVED",
    authorization_amount: 7500,
    pending_amount: 7500,
    events: [
      { token: "event_auth", type: "AUTHORIZATION", result: "APPROVED", amount: 5000, created: "2026-09-08T10:00:00Z" },
      { token: "event_advice", type: "AUTHORIZATION_ADVICE", result: "APPROVED", amount: 7500, created: "2026-09-08T11:00:00Z" },
    ],
  });

  assert.deepEqual(
    commands.map(({ eventType, authorizedTotalCents }) => ({ eventType, authorizedTotalCents })),
    [
      { eventType: "AUTHORIZED", authorizedTotalCents: 5000 },
      { eventType: "INCREMENTED", authorizedTotalCents: 7500 },
    ],
  );
});

test("Lithic multiple completion only marks the clearing that exhausts the hold as final", () => {
  const commands = lithicTransactionCommands({
    token: "transaction_multiple_capture",
    result: "APPROVED",
    pending_amount: 0,
    events: [
      { token: "event_auth", type: "AUTHORIZATION", result: "APPROVED", amount: 5000, created: "2026-09-08T10:00:00Z" },
      { token: "event_capture_1", type: "CLEARING", result: "APPROVED", amount: 3000, created: "2026-09-09T10:00:00Z" },
      { token: "event_capture_2", type: "CLEARING", result: "APPROVED", amount: 2000, created: "2026-09-10T10:00:00Z" },
    ],
  });
  const settlements = commands.filter((command) => command.kind === "settlement");

  assert.deepEqual(
    settlements.map(({ eventToken, amountCents, finalCapture }) => ({ eventToken, amountCents, finalCapture })),
    [
      { eventToken: "event_capture_1", amountCents: 3000, finalCapture: false },
      { eventToken: "event_capture_2", amountCents: 2000, finalCapture: true },
    ],
  );
});

test("Lithic partial capture preserves the remaining hold", () => {
  const commands = lithicTransactionCommands({
    token: "transaction_partial_capture",
    result: "APPROVED",
    amounts: { hold: { amount: 2000 } },
    events: [
      { token: "event_auth", type: "AUTHORIZATION", result: "APPROVED", amount: 5000, created: "2026-09-08T10:00:00Z" },
      { token: "event_capture", type: "CLEARING", result: "APPROVED", amount: 3000, created: "2026-09-09T10:00:00Z" },
    ],
  });

  assert.equal(commands.find((command) => command.kind === "settlement").finalCapture, false);
});

test("Lithic force post has no invented authorization link", () => {
  const commands = lithicTransactionCommands({
    token: "transaction_force_post",
    result: "APPROVED",
    events: [
      { token: "event_financial_auth", type: "FINANCIAL_AUTHORIZATION", result: "APPROVED", amount: 1899, created: "2026-09-09T10:00:00Z" },
    ],
  });
  const settlement = commands[0];

  assert.equal(settlement.forcePost, true);
  assert.equal(settlement.finalCapture, true);
  assert.equal(settlement.externalAuthorizationId, null);
});

test("Lithic return exposes only exact provider correlation references", () => {
  const commands = lithicTransactionCommands({
    token: "transaction_return",
    transaction_series: {
      related_transaction_token: "transaction_original",
      related_transaction_event_token: "clearing_original",
    },
    events: [
      { token: "event_return", type: "RETURN", result: "APPROVED", amount: 5000, created: "2026-09-10T10:00:00Z" },
    ],
  });

  assert.deepEqual(commands[0].relatedReferences, ["clearing_original", "transaction_original"]);
});
