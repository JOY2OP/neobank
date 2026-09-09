import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { dollarsToCents, formatUsd } from "../src/lib/money.js";
import { verifyIncreaseSignature, verifyPersonaSignature, verifyStripeSignature } from "../src/lib/hmac-signatures.js";
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
  const stripe = createHmac("sha256", secret).update(`${now}.${body}`).digest("hex");
  assert.equal(verifyStripeSignature(body, `t=${now},v1=${stripe}`, secret), true);
  assert.equal(verifyPersonaSignature(body, `t=${now},v1=${stripe}`, secret), true);

  const increase = createHmac("sha256", secret).update(`event_test.${now}.${body}`).digest("base64");
  const headers = new Headers({
    "webhook-id": "event_test",
    "webhook-timestamp": String(now),
    "webhook-signature": `v1,${increase}`,
  });
  assert.equal(verifyIncreaseSignature(body, headers, secret), true);
  assert.equal(verifyStripeSignature(body, `t=${now - 301},v1=${stripe}`, secret), false);
});
