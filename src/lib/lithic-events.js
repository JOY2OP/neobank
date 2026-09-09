const AUTHORIZATION_EVENT_TYPES = new Set(["AUTHORIZATION", "AUTHORIZATION_ADVICE"]);
const CLEARING_EVENT_TYPES = new Set(["CLEARING", "FINANCIAL_AUTHORIZATION"]);

function absoluteCents(value) {
  if (value === null || value === undefined || value === "") return null;
  const cents = Number(value);
  return Number.isFinite(cents) ? Math.abs(cents) : null;
}

export function lithicEventAmount(event, fallback = null) {
  return absoluteCents(
    event?.amounts?.cardholder?.amount
      ?? event?.amount
      ?? fallback,
  );
}

export function lithicRemainingHold(transaction) {
  return absoluteCents(
    transaction?.amounts?.hold?.amount
      ?? transaction?.pending_amount,
  );
}

export function lithicReturnReferences(transaction, event) {
  return [
    event?.related_transaction_event_token,
    transaction?.transaction_series?.related_transaction_event_token,
    event?.related_transaction_token,
    transaction?.transaction_series?.related_transaction_token,
    transaction?.related_transaction_event_token,
    transaction?.related_transaction_token,
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

// A webhook contains a snapshot of the transaction and all events seen so far.
// Return deterministic commands for every event; database idempotency keys make
// replaying older events harmless while also recovering from a missed webhook.
export function lithicTransactionCommands(transaction) {
  const events = [...(transaction?.events || [])].sort((left, right) => {
    const timeDifference = new Date(left.created || 0) - new Date(right.created || 0);
    return timeDifference || String(left.token || "").localeCompare(String(right.token || ""));
  });
  const debitClearings = events.filter((event) => CLEARING_EVENT_TYPES.has(event.type));
  const lastClearing = debitClearings.at(-1);
  const remainingHold = lithicRemainingHold(transaction);

  return events.flatMap((event) => {
    if (AUTHORIZATION_EVENT_TYPES.has(event.type)) {
      const approved = event.result === "APPROVED" && transaction.result !== "DECLINED";
      return [{
        kind: "authorization",
        eventToken: event.token,
        eventType: approved
          ? event.type === "AUTHORIZATION_ADVICE" ? "INCREMENTED" : "AUTHORIZED"
          : "DECLINED",
        authorizedTotalCents: approved
          ? lithicEventAmount(event, transaction.authorization_amount)
          : null,
        occurredAt: event.created || transaction.updated || transaction.created,
      }];
    }

    if (event.type === "AUTHORIZATION_REVERSAL" || event.type === "AUTHORIZATION_EXPIRY") {
      return [{
        kind: "authorization",
        eventToken: event.token,
        eventType: event.type === "AUTHORIZATION_EXPIRY" ? "EXPIRED" : "REVERSED",
        authorizedTotalCents: null,
        occurredAt: event.created || transaction.updated || transaction.created,
      }];
    }

    if (CLEARING_EVENT_TYPES.has(event.type)) {
      const forcePost = event.type === "FINANCIAL_AUTHORIZATION";
      return [{
        kind: "settlement",
        eventToken: event.token,
        amountCents: lithicEventAmount(event, transaction.settled_amount),
        occurredAt: event.created || transaction.updated || transaction.created,
        valueDate: (event.created || transaction.updated || transaction.created).slice(0, 10),
        externalAuthorizationId: forcePost ? null : transaction.token,
        forcePost,
        // Lithic exposes the remaining hold on the transaction. Only the last
        // clearing in this snapshot is terminal, and only when no hold remains.
        finalCapture: forcePost || (event === lastClearing && remainingHold === 0),
      }];
    }

    if (event.type === "RETURN") {
      return [{
        kind: "return",
        eventToken: event.token,
        occurredAt: event.created || transaction.updated || transaction.created,
        relatedReferences: lithicReturnReferences(transaction, event),
      }];
    }

    return [];
  });
}
