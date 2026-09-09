import Link from "next/link";
import { providerSummary } from "@/app/actions";
import { MetricCard, ProviderBadge, SectionHeading, SetupNotice } from "@/components/ui";
import { getOpsDashboard } from "@/lib/data";

export default async function OpsOverview() {
  const data = await getOpsDashboard();
  const providers = await providerSummary();
  const failures = data.events?.filter((event) => event.processing?.status !== "SUCCEEDED").length || 0;
  const degradation = [...(data.degradedProviders || []), ...(data.issues || [])];
  return <>
    <SectionHeading eyebrow="Internal operations" title="Good morning, Maya" description="Provider truth, reconciliation, and live-fire controls in one place." action={<div className="provider-row">{providers.map((item) => <span key={item.name} className="provider-item">{item.name}<ProviderBadge mode={item.mode} /></span>)}</div>} />
    <SetupNotice error={data.error} />
    {degradation.length ? <div className="notice notice-warning" role="status"><strong>Degraded safely</strong><span>Provider updates are delayed or failing ({degradation.join(", ")}). Corgi keeps the last verified ledger state, never substitutes simulator success, and retries the stored delivery without double-posting.</span></div> : null}
    {!data.error ? <>
      <div className="balance-grid"><MetricCard label="Open breaks" value={data.breaks.filter((item) => item.status !== "RESOLVED").length} note="Unresolved reconciliation exceptions" /><MetricCard label="Provider exceptions" value={failures} note="Events needing attention" /><MetricCard label="Reconciliation runs" value={data.runs.length} note="Recent uploaded files" /><MetricCard label="Standing orders" value={data.orders.length} note="Configured schedules" /></div>
      <div className="dashboard-grid"><Link className="feature-card" href="/ops/reconciliation"><span>≋</span><div><h2>Reconciliation</h2><p>Upload processor truth and inspect aged breaks.</p></div><b>→</b></Link><Link className="feature-card" href="/ops/statements"><span>▤</span><div><h2>Bitemporal statements</h2><p>Ask what the ledger knew at a historical cutoff.</p></div><b>→</b></Link><Link className="feature-card" href="/ops/events"><span>⚡</span><div><h2>Webhook deliveries</h2><p>Inspect signature checks, outcomes, and retry counts.</p></div><b>→</b></Link><Link className="feature-card" href="/ops/demo-lab"><span>◈</span><div><h2>Demo lab</h2><p>Run hostile sequencing and retry scenarios.</p></div><b>→</b></Link></div>
    </> : null}
  </>;
}
