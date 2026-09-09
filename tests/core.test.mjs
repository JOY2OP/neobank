import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Lithic from "lithic";
import { increasePaymentEventKey, increasePaymentEventType, increasePaymentValueDate } from "../src/lib/increase-transfer-state.js";
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
