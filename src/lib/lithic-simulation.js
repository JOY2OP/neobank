export function buildLithicAuthorizationRequest({ pan, amountCents, descriptor }) {
  const merchantName = String(descriptor || "CORGI FUEL STOP").trim().toUpperCase();
  if (!merchantName || merchantName.length > 25) {
    throw new Error("Merchant name must be between 1 and 25 characters.");
  }
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error("Lithic authorization amount must be positive integer cents.");
  }

  return {
    amount: amountCents,
    descriptor: merchantName,
    mcc: "5542",
    merchant_acceptor_city: "SAN FRANCISCO",
    merchant_acceptor_country: "USA",
    merchant_acceptor_id: "CORGI-FUEL-001",
    merchant_acceptor_state: "CA",
    merchant_amount: amountCents,
    merchant_currency: "USD",
    pan,
  };
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForLithicTransaction({ retrieve, token, eventType, delays = [0, 250, 500, 1000, 2000, 3000] }) {
  let latestTransaction = null;

  for (const delay of delays) {
    if (delay) await pause(delay);
    try {
      latestTransaction = await retrieve(token);
      if (!eventType || latestTransaction.events?.some((event) => event.type === eventType)) {
        return latestTransaction;
      }
    } catch (error) {
      if (error?.status !== 404) throw error;
    }
  }

  if (latestTransaction) {
    throw new Error(`Lithic transaction ${token} is still waiting for its ${eventType.toLowerCase()} event.`);
  }
  throw new Error(`Lithic accepted transaction ${token}, but Sandbox has not made it readable yet. Check Lithic Transactions before retrying.`);
}
