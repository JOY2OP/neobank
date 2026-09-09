import "server-only";

import { providerMode, requiredEnv } from "./config";
import { simulatedId } from "./simulator";

function increaseBaseUrl() {
  return (process.env.INCREASE_BASE_URL || "https://sandbox.increase.com").replace(/\/$/, "");
}

async function increaseRequest(path, options = {}) {
  const response = await fetch(`${increaseBaseUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${requiredEnv("INCREASE_API_KEY")}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Increase sandbox error: ${data.message || response.statusText}`);
  return data;
}

// Plaid supplies verified ACH numbers. Increase tokenizes them as an External
// Account and then moves sandbox money using only the returned opaque ID.
export async function createIncreaseExternalAccount({ name, routing, number, idempotencyKey }) {
  if (providerMode("increase") === "simulated") {
    return { id: simulatedId("external_account"), source: "SIMULATED" };
  }
  const account = await increaseRequest("/external_accounts", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      description: name,
      routing_number: routing,
      account_number: number,
      funding: "checking",
      account_holder: "business",
    }),
  });
  return { ...account, source: "SANDBOX" };
}

export async function createIncreaseAchTransfer({ externalAccountId, amountCents, memo, idempotencyKey }) {
  if (providerMode("increase") === "simulated") {
    return { id: simulatedId("ach_transfer"), status: "pending_submission", source: "SIMULATED" };
  }
  const transfer = await increaseRequest("/ach_transfers", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      account_id: requiredEnv("INCREASE_ACCOUNT_ID"),
      external_account_id: externalAccountId,
      amount: amountCents,
      statement_descriptor: (memo || "CORGI PAYMENT").slice(0, 10).toUpperCase(),
      company_name: "ACME INC",
    }),
  });
  return { ...transfer, source: "SANDBOX" };
}

export async function createIncreaseFundingTransfer({ externalAccountId, amountCents, idempotencyKey }) {
  if (providerMode("increase") === "simulated") {
    return { id: simulatedId("funding_transfer"), status: "pending_submission", source: "SIMULATED" };
  }

  // Increase represents an ACH pull from the linked bank with a negative amount.
  // Our ledger still records the customer-facing funding amount as positive cents.
  const transfer = await increaseRequest("/ach_transfers", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({
      account_id: requiredEnv("INCREASE_ACCOUNT_ID"),
      external_account_id: externalAccountId,
      amount: -amountCents,
      statement_descriptor: "CORGI FUND",
      company_name: "ACME INC",
    }),
  });
  return { ...transfer, source: "SANDBOX" };
}

export function retrieveIncreaseObject(type, id) {
  const paths = {
    ach_transfer: `/ach_transfers/${id}`,
    inbound_ach_transfer: `/inbound_ach_transfers/${id}`,
    transaction: `/transactions/${id}`,
  };
  if (!paths[type]) throw new Error(`Unsupported Increase object type: ${type}`);
  return increaseRequest(paths[type]);
}

export function simulateIncreaseTransfer(transferId, action, reason = "insufficient_fund") {
  if (providerMode("increase") === "simulated") {
    return { id: transferId, status: action, source: "SIMULATED" };
  }
  const suffix = action === "return" ? "return" : action;
  return increaseRequest(`/simulations/ach_transfers/${transferId}/${suffix}`, {
    method: "POST",
    body: JSON.stringify(action === "return" ? { reason } : {}),
  });
}
