import { recordProcessingAttempt, storeProviderEvent } from "@/lib/provider-events";
import { recordIncreaseAchTransfer } from "@/lib/increase-events";
import { requiredEnv } from "@/lib/providers/config";
import { retrieveIncreaseObject } from "@/lib/providers/increase";
import { verifyIncreaseSignature } from "@/lib/webhook-signatures";

export async function POST(request) {
  const rawBody = await request.text();
  if (!verifyIncreaseSignature(rawBody, request.headers, requiredEnv("INCREASE_WEBHOOK_SECRET"))) {
    return Response.json({ error: "Invalid Increase signature" }, { status: 401 });
  }
  const event = JSON.parse(rawBody);
  const stored = await storeProviderEvent({
    provider: "increase",
    externalId: event.id,
    type: event.category,
    createdAt: event.created_at,
    payload: event,
  });
  if (!stored.inserted) return Response.json({ received: true, replay: true });

  try {
    if (event.associated_object_type === "ach_transfer") {
      const transfer = await retrieveIncreaseObject("ach_transfer", event.associated_object_id);
      await recordIncreaseAchTransfer({
        transfer,
        eventId: event.id,
        eventCreatedAt: event.created_at,
        providerEventId: stored.provider_event_id,
      });
    }
    await recordProcessingAttempt(stored.provider_event_id, "SUCCEEDED");
    return Response.json({ received: true });
  } catch (error) {
    await recordProcessingAttempt(stored.provider_event_id, "RETRYABLE_FAILURE", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
