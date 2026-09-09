import { DEMO_IDS } from "@/lib/demo-users";
import { recordProcessingAttempt, storeProviderEvent } from "@/lib/provider-events";
import { requiredEnv } from "@/lib/providers/config";
import { insertRows, selectRows } from "@/lib/supabase";
import { verifyPersonaSignature } from "@/lib/webhook-signatures";

const STATUS_MAP = {
  "inquiry.created": "PENDING",
  "inquiry.started": "IN_REVIEW",
  "inquiry.completed": "IN_REVIEW",
  "inquiry.approved": "APPROVED",
  "inquiry.declined": "REJECTED",
};

export async function POST(request) {
  const rawBody = await request.text();
  if (!verifyPersonaSignature(rawBody, request.headers.get("persona-signature"), requiredEnv("PERSONA_WEBHOOK_SECRET"))) {
    return Response.json({ error: "Invalid Persona signature" }, { status: 401 });
  }
  const event = JSON.parse(rawBody);
  const name = event.data.attributes.name;
  const inquiry = event.data.attributes.payload.data;
  const stored = await storeProviderEvent({
    provider: "persona",
    externalId: event.data.id,
    type: name,
    createdAt: event.data.attributes["created-at"],
    payload: event,
  });
  if (!stored.inserted) return Response.json({ received: true, replay: true });

  try {
    const cases = await selectRows("kyb_cases", `provider_code=eq.persona&external_case_id=eq.${inquiry.id}`);
    if (!cases[0]) throw new Error("Persona inquiry is not linked to a local KYB case.");
    const status = STATUS_MAP[name];
    if (status) {
      await insertRows("kyb_events", [{
        kyb_case_id: cases[0].id,
        provider_event_id: stored.provider_event_id,
        idempotency_key: `persona:${event.data.id}`,
        event_type: status,
        provider_status: inquiry.attributes.status,
        occurred_at: event.data.attributes["created-at"],
        details: {},
      }]);
    }
    if (status === "APPROVED") {
      await insertRows("business_account_events", [{
        business_account_id: DEMO_IDS.account,
        provider_event_id: stored.provider_event_id,
        idempotency_key: `persona-account-open:${inquiry.id}`,
        event_type: "OPENED",
        occurred_at: event.data.attributes["created-at"],
        details: { inquiry_id: inquiry.id },
      }], { ignoreDuplicates: true });
    }
    await recordProcessingAttempt(stored.provider_event_id, "SUCCEEDED");
    return Response.json({ received: true });
  } catch (error) {
    await recordProcessingAttempt(stored.provider_event_id, "RETRYABLE_FAILURE", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
