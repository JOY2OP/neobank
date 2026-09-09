import { EmptyState, SectionHeading, SetupNotice, StatusPill } from "@/components/ui";
import { getOpsDashboard } from "@/lib/data";

export default async function EventsPage() {
  const data = await getOpsDashboard();
  return <><SectionHeading eyebrow="Verified inbox" title="Provider events" description="Every webhook is signature-checked, stored once, and then processed. Replays return success without another posting." /><SetupNotice error={data.error} />{!data.error ? <section className="panel">{data.events.length ? <div className="table-wrap"><table><thead><tr><th>Provider</th><th>Event</th><th>External ID</th><th>Received</th><th>Processing</th></tr></thead><tbody>{data.events.map((event) => <tr key={event.id}><td><strong>{event.provider_code.toUpperCase()}</strong><small>{event.environment}</small></td><td>{event.event_type}</td><td className="mono">{event.external_event_id}</td><td>{new Date(event.received_at).toLocaleString("en-US")}</td><td><StatusPill tone={event.processing?.status === "SUCCEEDED" ? "success" : "warning"}>{event.processing?.status || "RECEIVED"}</StatusPill>{event.processing?.error_message ? <small>{event.processing.error_message}</small> : null}</td></tr>)}</tbody></table></div> : <EmptyState title="No provider deliveries">Signed webhooks and Demo Lab events appear here.</EmptyState>}</section> : null}</>;
}
