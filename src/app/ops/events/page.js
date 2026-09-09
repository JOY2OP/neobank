import { EmptyState, SectionHeading, SetupNotice, StatusPill } from "@/components/ui";
import { getOpsDashboard } from "@/lib/data";

export default async function EventsPage() {
  const data = await getOpsDashboard();
  return <>
    <SectionHeading
      eyebrow="Verified inbox"
      title="Webhook delivery log"
      description="Verified payloads are stored before processing. Failed deliveries stay retryable; a successful replay never posts money twice."
    />
    <SetupNotice error={data.error} />
    {data.issues?.length ? <div className="notice notice-warning" role="status"><strong>Partially degraded</strong><span>{data.issues.join(" ")}</span></div> : null}
    {!data.error ? <section className="panel">
      {data.events.length ? <div className="table-wrap"><table>
        <thead><tr><th>Provider</th><th>Event / external ID</th><th>Received</th><th>Signature</th><th>Outcome</th><th>Retries</th></tr></thead>
        <tbody>{data.events.map((event) => {
          const status = event.processing?.status || "RECEIVED";
          const retryCount = Math.max(0, Number(event.processing?.attempt_number || 0) - 1);
          const tone = status === "SUCCEEDED" ? "success" : status === "TERMINAL_FAILURE" ? "danger" : "warning";
          return <tr key={event.id}>
            <td><strong>{event.provider_code.toUpperCase()}</strong><small>{event.environment}</small></td>
            <td>{event.event_type}<small className="mono">{event.external_event_id}</small></td>
            <td>{new Date(event.received_at).toLocaleString("en-US")}</td>
            <td><StatusPill tone={event.signature_verified ? "success" : "danger"}>{event.signature_verified ? "VERIFIED" : "REJECTED"}</StatusPill></td>
            <td><StatusPill tone={tone}>{status}</StatusPill>{event.processing?.error_message ? <small>{event.processing.error_message}</small> : null}</td>
            <td><strong>{retryCount}</strong><small>{event.processing?.attempt_number ? `${event.processing.attempt_number} processing attempt(s)` : "Awaiting first attempt"}</small></td>
          </tr>;
        })}</tbody>
      </table></div> : <EmptyState title="No provider deliveries">Signed webhooks and Demo Lab events appear here.</EmptyState>}
    </section> : null}
  </>;
}
