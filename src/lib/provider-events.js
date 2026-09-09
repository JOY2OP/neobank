import "server-only";

import { callRpc, selectRows } from "./supabase";

export async function storeProviderEvent({ provider, account = "default", externalId, type, createdAt, payload }) {
  // Persist first: if processing fails, Ops can see and retry the exact payload.
  // The database unique key also makes provider retries safe.
  const rows = await callRpc("ingest_provider_event", {
    p_provider_code: provider,
    p_provider_account: account,
    p_environment: provider === "simulator" ? "SIMULATED" : "SANDBOX",
    p_external_event_id: externalId,
    p_event_type: type,
    p_provider_created_at: createdAt || null,
    p_signature_verified: true,
    p_payload: payload,
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function recordProcessingAttempt(providerEventId, outcome, error = null) {
  const previous = await selectRows(
    "provider_event_processing_attempts",
    `provider_event_id=eq.${providerEventId}&select=attempt_number&order=attempt_number.desc&limit=1`,
  );
  const attemptNumber = Number(previous[0]?.attempt_number || 0) + 1;
  const now = new Date().toISOString();
  return callRpc("record_provider_event_attempt", {
    p_provider_event_id: providerEventId,
    p_attempt_number: attemptNumber,
    p_outcome: outcome,
    p_started_at: now,
    p_completed_at: now,
    p_error_code: error ? "PROCESSING_ERROR" : null,
    p_error_message: error?.message || null,
    p_details: {},
  });
}

export async function shouldProcessProviderEvent(providerEventId) {
  const rows = await selectRows(
    "current_provider_event_status",
    `provider_event_id=eq.${providerEventId}`,
  );
  const status = rows[0]?.status || "RECEIVED";
  return status === "RECEIVED" || status === "RETRYABLE_FAILURE";
}
