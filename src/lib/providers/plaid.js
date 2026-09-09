import "server-only";

import { appUrl, providerMode, requiredEnv } from "./config";
import { simulatedId } from "./simulator";

function plaidBaseUrl() {
  const environment = process.env.PLAID_MODE || "sandbox";
  return `https://${environment}.plaid.com`;
}

async function plaidRequest(path, body) {
  const response = await fetch(`${plaidBaseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: requiredEnv("PLAID_CLIENT_ID"),
      secret: requiredEnv("PLAID_SECRET"),
      ...body,
    }),
  });
  const data = await response.json();
  if (!response.ok || data.error_code) {
    throw new Error(`Plaid sandbox error: ${data.error_message || response.statusText}`);
  }
  return data;
}

// Plaid Link returns a short-lived public token. The browser sends it back to
// us, and only the server exchanges and stores the long-lived access token.
export async function createPlaidLinkToken(actorId) {
  if (providerMode("plaid") === "simulated") {
    return { linkToken: simulatedId("link"), source: "SIMULATED" };
  }
  const data = await plaidRequest("/link/token/create", {
    user: { client_user_id: actorId },
    client_name: "Corgi Business Banking",
    products: ["auth"],
    country_codes: ["US"],
    language: "en",
    webhook: `${appUrl()}/api/webhooks/plaid`,
  });
  return { linkToken: data.link_token, source: "SANDBOX" };
}

export async function exchangePlaidToken(publicToken) {
  if (providerMode("plaid") === "simulated") {
    return {
      accessToken: simulatedId("access"),
      itemId: simulatedId("item"),
      account: {
        id: simulatedId("acct"),
        name: "Chase Business Complete Banking",
        mask: "4821",
        routing: "110000000",
        number: "000123456789",
      },
      source: "SIMULATED",
    };
  }

  const exchanged = await plaidRequest("/item/public_token/exchange", {
    public_token: publicToken,
  });
  const auth = await plaidRequest("/auth/get", { access_token: exchanged.access_token });
  const firstAccount = auth.accounts[0];
  if (!firstAccount) throw new Error("Plaid returned no bank account.");
  const achNumbers = auth.numbers.ach.find((row) => row.account_id === firstAccount.account_id);
  if (!achNumbers) throw new Error("Plaid returned no ACH-capable account.");

  return {
    accessToken: exchanged.access_token,
    itemId: exchanged.item_id,
    account: {
      id: firstAccount.account_id,
      name: firstAccount.name,
      mask: firstAccount.mask,
      routing: achNumbers.routing,
      number: achNumbers.account,
    },
    source: "SANDBOX",
  };
}

export async function getPlaidVerificationKey(keyId) {
  return plaidRequest("/webhook_verification_key/get", { key_id: keyId });
}
