import { randomUUID } from "node:crypto";

export function simulatedId(prefix) {
  return `${prefix}_sim_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

export function simulatedProviderEvent(provider, eventType, payload = {}) {
  return {
    id: simulatedId("evt"),
    provider,
    eventType,
    createdAt: new Date().toISOString(),
    payload: { ...payload, simulated: true },
  };
}
