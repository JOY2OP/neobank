import Link from "next/link";
import { providerSummary } from "@/app/actions";
import { BalanceCard, ProviderBadge, SectionHeading, SetupNotice, StatusPill } from "@/components/ui";
import { getOpsDashboard } from "@/lib/data";

export default async function OpsOverview() {
  const data = await getOpsDashboard();
  const providers = await providerSummary();
  const failures = data.events?.filter((event) => event.processing?.status !== "SUCCEEDED").length || 0;
  return <><SectionHeading eyebrow="Internal operations" title="Good morning, Maya" description="Provider truth, reconciliation, and live-fire controls in one place." action={<div className="provider-row">{providers.map((item) => <span key={item.name} className="provider-item">{item.name}<ProviderBadge mode={item.mode} /></span>)}</div>} /><SetupNotice error={data.error} />{!data.error ? <><div className="balance-grid"><BalanceCard label="Open breaks" cents={data.breaks.length * 100} note="Count shown as 0.01 dollars each" /><BalanceCard label="Provider exceptions" cents={failures * 100} note="Events needing attention" /><BalanceCard label="Reconciliation runs" cents={data.runs.length * 100} note="Recent uploaded files" /><BalanceCard label="Standing orders" cents={data.orders.length * 100} note="Configured schedules" /></div><div className="dashboard-grid"><Link className="feature-card" href="/ops/reconciliation"><span>≋</span><div><h2>Reconciliation</h2><p>Upload processor truth and inspect aged breaks.</p></div><b>→</b></Link><Link className="feature-card" href="/ops/statements"><span>▤</span><div><h2>Bitemporal statements</h2><p>Ask what the ledger knew at a historical cutoff.</p></div><b>→</b></Link><Link className="feature-card" href="/ops/events"><span>⚡</span><div><h2>Provider events</h2><p>Inspect verified delivery and processing attempts.</p></div><b>→</b></Link><Link className="feature-card" href="/ops/demo-lab"><span>◈</span><div><h2>Demo lab</h2><p>Run hostile sequencing and retry scenarios.</p></div><b>→</b></Link></div></> : null}</>;
}
