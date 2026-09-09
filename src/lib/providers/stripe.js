import "server-only";

import { providerMode, requiredEnv } from "./config";
import { simulatedId } from "./simulator";

async function stripeRequest(path, parameters) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requiredEnv("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(parameters),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Stripe sandbox error: ${data.error?.message || response.statusText}`);
  return data;
}

// Stripe owns card issuance and produces card-network events. Our webhook turns
// those events into holds and immutable ledger entries in Supabase.
export async function issueStripeCard({ name, email, actorId }) {
  if (providerMode("stripe") === "simulated") {
    return {
      cardholderId: simulatedId("ich"),
      cardId: simulatedId("ic"),
      last4: String(Math.floor(1000 + Math.random() * 9000)),
      source: "SIMULATED",
    };
  }

  const cardholder = await stripeRequest("/issuing/cardholders", {
    type: "individual",
    name,
    email,
    status: "active",
    "billing[address][line1]": "354 Oyster Point Blvd",
    "billing[address][city]": "South San Francisco",
    "billing[address][state]": "CA",
    "billing[address][postal_code]": "94080",
    "billing[address][country]": "US",
    "metadata[actor_id]": actorId,
  });
  const card = await stripeRequest("/issuing/cards", {
    cardholder: cardholder.id,
    currency: "usd",
    type: "virtual",
    status: "active",
    "metadata[actor_id]": actorId,
  });
  return { cardholderId: cardholder.id, cardId: card.id, last4: card.last4, source: "SANDBOX" };
}

export async function createStripeTestAuthorization(cardId, amountCents) {
  if (providerMode("stripe") === "simulated") {
    return { id: simulatedId("iauth"), amount: amountCents, source: "SIMULATED" };
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
