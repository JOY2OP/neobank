import "server-only";

import { providerMode, requiredEnv } from "./config";
import { simulatedId } from "./simulator";

function stripeTestKey() {
  const key = requiredEnv("STRIPE_SECRET_KEY");
  if (!key.startsWith("sk_test_")) {
    throw new Error("STRIPE_SECRET_KEY must be a Stripe test-mode secret key (sk_test_...).");
  }
  return key;
}

async function stripeRequest(path, parameters) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeTestKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(parameters),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Stripe sandbox error: ${data.error?.message || response.statusText}`);
  return data;
}

async function stripeGet(path) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${stripeTestKey()}` },
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Stripe sandbox error: ${data.error?.message || response.statusText}`);
  return data;
}

async function stripeV2Get(path) {
  const response = await fetch(`https://api.stripe.com/v2${path}`, {
    headers: {
      Authorization: `Bearer ${stripeTestKey()}`,
      "Stripe-Version": "2026-08-26.preview",
    },
    cache: "no-store",
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Stripe sandbox error: ${data.error?.message || response.statusText}`);
  return data;
}

async function getStripeFundingSource() {
  const balance = await stripeGet("/balance");
  if (balance.livemode) throw new Error("Stripe returned a live-mode balance; only sandbox Issuing is allowed.");
  if (balance.issuing) {
    return {
      type: "issuing_balance",
      availableCents: Number(balance.issuing.available?.find((item) => item.currency === "usd")?.amount || 0),
      cardParameters: {},
    };
  }

  const configuredId = process.env.STRIPE_FINANCIAL_ACCOUNT_ID;
  const financialAccounts = configuredId
    ? [await stripeV2Get(`/money_management/financial_accounts/${configuredId}`)]
    : (await stripeV2Get("/money_management/financial_accounts?limit=20")).data || [];
  const financialAccount = financialAccounts.find((item) => item.status === "open");
  if (!financialAccount) {
    const pending = financialAccounts.find((item) => item.status === "pending");
    throw new Error(pending
      ? `Stripe Financial Account ${pending.id} is pending. Finish Card issuing sandbox activation in Stripe, wait for status OPEN, then retry.`
      : "Stripe has neither a standalone Issuing balance nor an open Financial Account. Finish Card issuing sandbox activation, then retry.");
  }
  return {
    type: "financial_account_v2",
    availableCents: Number(financialAccount.balance?.available?.usd?.value || 0),
    cardParameters: { financial_account_v2: financialAccount.id },
  };
}

// Stripe chooses the provider-side funding model for each Issuing sandbox.
// Neither provider balance becomes Corgi's customer ledger.
export async function issueStripeCard({ name, email, phoneNumber, actorId, acceptedTermsAt, acceptedTermsIp, acceptedTermsUserAgent }) {
  if (providerMode("stripe") === "simulated") {
    return {
      cardholderId: simulatedId("ich"),
      cardId: simulatedId("ic"),
      last4: String(Math.floor(1000 + Math.random() * 9000)),
      source: "SIMULATED",
    };
  }

  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts.shift();
  const lastName = nameParts.join(" ");
  if (!firstName || !lastName) throw new Error("Stripe cardholders need a first and last name.");
  const funding = await getStripeFundingSource();

  const cardholder = await stripeRequest("/issuing/cardholders", {
    type: "individual",
    name,
    email,
    phone_number: phoneNumber,
    status: "active",
    "individual[first_name]": firstName,
    "individual[last_name]": lastName,
    "individual[card_issuing][user_terms_acceptance][date]": String(acceptedTermsAt),
    "individual[card_issuing][user_terms_acceptance][ip]": acceptedTermsIp,
    "individual[card_issuing][user_terms_acceptance][user_agent]": acceptedTermsUserAgent,
    "billing[address][line1]": "354 Oyster Point Blvd",
    "billing[address][city]": "South San Francisco",
    "billing[address][state]": "CA",
    "billing[address][postal_code]": "94080",
    "billing[address][country]": "US",
    "metadata[actor_id]": actorId,
  });
  if (cardholder.livemode) throw new Error("Stripe returned a live-mode cardholder; only sandbox Issuing is allowed.");

  const card = await stripeRequest("/issuing/cards", {
    cardholder: cardholder.id,
    currency: "usd",
    type: "virtual",
    status: "active",
    "metadata[actor_id]": actorId,
    ...funding.cardParameters,
  });
  if (card.livemode) throw new Error("Stripe returned a live-mode card; only sandbox Issuing is allowed.");
  return { cardholderId: cardholder.id, cardId: card.id, last4: card.last4, source: "SANDBOX" };
}

export async function createStripeTestAuthorization(cardId, amountCents) {
  if (providerMode("stripe") === "simulated") {
    return { id: simulatedId("iauth"), amount: amountCents, source: "SIMULATED" };
  }
  const funding = await getStripeFundingSource();
  if (funding.availableCents < amountCents) {
    throw new Error(`Stripe's ${funding.type === "issuing_balance" ? "Issuing balance" : "Financial Account"} has ${funding.availableCents} cents available; add sandbox USD funds before authorizing ${amountCents} cents.`);
  }
  const authorization = await stripeRequest("/test_helpers/issuing/authorizations", {
    card: cardId,
    amount: String(amountCents),
    currency: "usd",
    "merchant_data[name]": "Corgi Fuel Stop",
    "merchant_data[category]": "automated_fuel_dispensers",
  });
  return { ...authorization, source: "SANDBOX" };
}

export async function captureStripeAuthorization(authorizationId, amountCents) {
  if (providerMode("stripe") === "simulated") {
    return { id: authorizationId, capture_amount: amountCents, source: "SIMULATED" };
  }
  const authorization = await stripeRequest(
    `/test_helpers/issuing/authorizations/${authorizationId}/capture`,
    { capture_amount: String(amountCents), close_authorization: "true" },
  );
  return { ...authorization, source: "SANDBOX" };
}

export async function retrieveStripeAuthorization(authorizationId) {
  if (providerMode("stripe") === "simulated") return null;
  return stripeGet(`/issuing/authorizations/${authorizationId}`);
}

export async function retrieveStripeTransaction(transactionId) {
  if (providerMode("stripe") === "simulated") return null;
  return stripeGet(`/issuing/transactions/${transactionId}`);
}

export async function refundStripeTransaction(transactionId, amountCents) {
  if (providerMode("stripe") === "simulated") {
    return { id: transactionId, refund_amount: amountCents, source: "SIMULATED" };
  }
  const transaction = await stripeRequest(
    `/test_helpers/issuing/transactions/${transactionId}/refund`,
    { refund_amount: String(amountCents) },
  );
  return { ...transaction, source: "SANDBOX" };
}
