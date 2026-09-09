const STATUS_EVENT_TYPES = {
  pending_approval: "PENDING",
  pending_submission: "PENDING",
  submitted: "SUBMITTED",
  returned: "RETURNED",
  canceled: "CANCELLED",
  rejected: "FAILED",
};

export function increasePaymentEventType(transfer) {
  if (transfer.return || transfer.status === "returned") return "RETURNED";
  if (transfer.settlement?.settled_at) return "SETTLED";
  return STATUS_EVENT_TYPES[transfer.status] || "UNKNOWN";
}

export function increasePaymentEventKey(transfer, eventType, fallbackEventId) {
  if (eventType === "SETTLED") {
    return `increase:${transfer.id}:settled:${transfer.settlement.settled_at}`;
  }
  if (["RETURNED", "RECALLED"].includes(eventType)) {
    return `increase:${transfer.id}:returned:${transfer.return?.reason || "unknown"}`;
  }
  return `increase:${fallbackEventId}`;
}

export function increasePaymentValueDate(transfer, eventType, fallbackDate) {
  if (!["SETTLED", "RETURNED", "RECALLED"].includes(eventType)) return null;
  return (
    transfer.settlement?.settled_at?.slice(0, 10)
    || transfer.submission?.effective_date
    || fallbackDate.slice(0, 10)
  );
}
