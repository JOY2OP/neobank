import "server-only";

import { randomUUID } from "node:crypto";
import Lithic from "lithic";
import { buildLithicAuthorizationRequest, waitForLithicTransaction } from "../lithic-simulation";
import { providerMode, requiredEnv } from "./config";
import { simulatedId } from "./simulator";

let client;

export function lithicClient() {
  if (!client) {
    client = new Lithic({
      apiKey: requiredEnv("LITHIC_API_KEY"),
      environment: "sandbox",
      webhookSecret: process.env.LITHIC_WEBHOOK_SECRET || null,
    });
  }
  return client;
}

async function retrieveSandboxCard(cardToken) {
  const card = await lithicClient().cards.retrieve(cardToken);
  if (!card.pan) {
    throw new Error("Lithic did not return the sandbox PAN required by its transaction simulator.");
  }
  if (card.state !== "OPEN") {
    throw new Error(`Lithic card •••• ${card.last_four || "unknown"} is ${String(card.state || "not open").toLowerCase()}.`);
  }
  return card;
}

export async function issueLithicCard({ name, actorId }) {
  if (providerMode("lithic") === "simulated") {
    return {
      accountToken: simulatedId("account"),
      cardId: simulatedId("card"),
      last4: String(Math.floor(1000 + Math.random() * 9000)),
      source: "SIMULATED",
    };
  }

  const card = await lithicClient().cards.create({
    type: "VIRTUAL",
    state: "OPEN",
    memo: `Corgi - ${name} (${actorId})`,
    "Idempotency-Key": randomUUID(),
  });
  return {
    accountToken: card.account_token,
    cardId: card.token,
    last4: card.last_four,
    source: "SANDBOX",
  };
}

export async function createLithicTestAuthorization(cardToken, amountCents, descriptor = "CORGI FUEL STOP") {
  const request = buildLithicAuthorizationRequest({ pan: null, amountCents, descriptor });
  if (providerMode("lithic") === "simulated") {
    return {
      id: simulatedId("auth"),
      amount: amountCents,
      approved: true,
      created: new Date().toISOString(),
      merchantName: request.descriptor,
      merchantCategoryCode: "5542",
      source: "SIMULATED",
    };
  }

  const card = await retrieveSandboxCard(cardToken);
  const simulated = await lithicClient().transactions.simulateAuthorization({ ...request, pan: card.pan });
  if (!simulated.token) throw new Error("Lithic accepted the simulation without returning a transaction token.");
  const transaction = await waitForLithicTransaction({
    retrieve: (token) => lithicClient().transactions.retrieve(token),
    token: simulated.token,
    eventType: "AUTHORIZATION",
  });
  const authorization = [...(transaction.events || [])].reverse().find((event) => event.type === "AUTHORIZATION");
  return {
    id: transaction.token,
    eventId: authorization?.token || transaction.token,
    amount: amountCents,
    approved: transaction.result === "APPROVED" && transaction.status !== "DECLINED",
    created: authorization?.created || transaction.created,
    merchantName: transaction.merchant?.descriptor || request.descriptor,
    merchantCategoryCode: transaction.merchant?.mcc || "5542",
    result: transaction.result,
    status: transaction.status,
    source: "SANDBOX",
  };
}

export async function clearLithicAuthorization(transactionToken, amountCents) {
  if (providerMode("lithic") === "simulated") {
    return { id: simulatedId("clearing"), transactionId: transactionToken, created: new Date().toISOString(), source: "SIMULATED" };
  }

  await lithicClient().transactions.simulateClearing({ token: transactionToken, amount: amountCents });
  const transaction = await waitForLithicTransaction({
    retrieve: (token) => lithicClient().transactions.retrieve(token),
    token: transactionToken,
    eventType: "CLEARING",
  });
  const clearing = [...(transaction.events || [])].reverse().find((event) => event.type === "CLEARING");
  if (!clearing) throw new Error("Lithic accepted clearing but the transaction does not contain a clearing event yet.");
  return { id: clearing.token, transactionId: transaction.token, created: clearing.created, source: "SANDBOX" };
}

export async function returnLithicTransaction(cardToken, amountCents) {
  if (providerMode("lithic") === "simulated") {
    return { id: simulatedId("return"), created: new Date().toISOString(), source: "SIMULATED" };
  }

  const card = await retrieveSandboxCard(cardToken);
  const simulated = await lithicClient().transactions.simulateReturn({
    amount: amountCents,
    descriptor: "CORGI FUEL STOP",
    pan: card.pan,
  });
  if (!simulated.token) throw new Error("Lithic accepted the return without returning a transaction token.");
  const transaction = await waitForLithicTransaction({
    retrieve: (token) => lithicClient().transactions.retrieve(token),
    token: simulated.token,
    eventType: "RETURN",
  });
  const returned = [...(transaction.events || [])].reverse().find((event) => event.type === "RETURN");
  return { id: returned?.token || transaction.token, created: returned?.created || transaction.created, source: "SANDBOX" };
}
