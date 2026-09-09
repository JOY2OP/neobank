import { recordProcessingAttempt, storeProviderEvent } from "@/lib/provider-events";
import { verifyPlaidSignature } from "@/lib/webhook-signatures";

export async function POST(request) {
  const rawBody = await request.text();
  const token = request.headers.get("plaid-verification");
  if (!(await verifyPlaidSignature(rawBody, token))) {
    return Response.json({ error: "Invalid Plaid signature" }, { status: 401 });
  }
  const event = JSON.parse(rawBody);
  const externalId = event.webhook_id || `${event.item_id}:${event.webhook_code}:${event.environment}`;
  const stored = await storeProviderEvent({
    provider: "plaid",
    externalId,
    type: `${event.webhook_type}.${event.webhook_code}`,
    createdAt: null,
    payload: event,
  });
  if (stored.inserted) await recordProcessingAttempt(stored.provider_event_id, "SUCCEEDED");
  return Response.json({ received: true, replay: !stored.inserted });
}
