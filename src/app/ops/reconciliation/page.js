import { runReconciliationAction } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { EmptyState, SectionHeading, SetupNotice, StatusPill } from "@/components/ui";
import { getOpsDashboard } from "@/lib/data";
import { formatUsd } from "@/lib/money";

export default async function ReconciliationPage() {
  const data = await getOpsDashboard();
  const today = new Date().toISOString().slice(0, 10);
  return <><SectionHeading eyebrow="Scheme file diff" title="Reconciliation" description="Compare processor rows with posted card settlements. Existing financial rows are never changed." /><SetupNotice error={data.error} />{!data.error ? <><ActionForm action={runReconciliationAction} submitLabel="Run reconciliation" className="form-card horizontal-form"><label>Provider<select name="provider" defaultValue="stripe"><option value="stripe">Stripe Issuing</option><option value="simulator">Simulator</option></select></label><label>Settlement date<input type="date" name="settlementDate" defaultValue={today} required /></label><label>CSV file<input type="file" name="file" accept=".csv,text/csv" required /></label></ActionForm><section className="panel"><div className="panel-head"><div><span className="eyebrow">Exceptions</span><h2>Open and historical breaks</h2></div><a className="text-link" href="/sample-scheme-file.csv" download>Download sample CSV</a></div>{data.breaks.length ? <div className="table-wrap"><table><thead><tr><th>Break</th><th>Reference</th><th>Age</th><th>File</th><th>Ledger</th><th>Status</th></tr></thead><tbody>{data.breaks.map((item) => <tr key={item.id}><td><StatusPill tone={item.break_type === "AMOUNT_MISMATCH" ? "warning" : "danger"}>{item.break_type}</StatusPill></td><td>{item.processor_reference}</td><td>{item.age_days}d</td><td>{item.file_amount_cents ? formatUsd(item.file_amount_cents) : "—"}</td><td>{item.ledger_amount_cents ? formatUsd(item.ledger_amount_cents) : "—"}</td><td>{item.status}</td></tr>)}</tbody></table></div> : <EmptyState title="No reconciliation breaks">Upload a scheme file; planted differences appear here.</EmptyState>}</section></> : null}</>;
}
