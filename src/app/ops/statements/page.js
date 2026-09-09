import { EmptyState, SectionHeading, SetupNotice, StatusPill } from "@/components/ui";
import { getStatement } from "@/lib/data";
import { formatDate, formatUsd } from "@/lib/money";

export default async function StatementsPage({ searchParams }) {
  const params = await searchParams;
  const end = params.end || new Date().toISOString().slice(0, 10);
  const start = params.start || new Date(new Date().getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const knownAt = params.knownAt || new Date().toISOString();
  let rows = [];
  let error = "";
  try { rows = await getStatement({ start, end, knownAt }); } catch (caught) { error = caught.message; }
  const net = rows.reduce((sum, row) => sum + Number(row.signed_amount_cents), 0);
  return <><SectionHeading eyebrow="Value date × booking time" title="Statement viewer" description="Move the knowledge cutoff backward to see what Corgi believed before a later correction arrived." /><SetupNotice error={error} /><form className="filter-bar"><label>Period start<input type="date" name="start" defaultValue={start} /></label><label>Period end<input type="date" name="end" defaultValue={end} /></label><label>Knowledge cutoff<input type="datetime-local" name="knownAt" defaultValue={knownAt.slice(0, 16)} /></label><button className="button button-primary">Apply cutoff</button></form><div className="notice notice-info"><strong>Statement net movement: {formatUsd(net)}</strong><span>Only entries booked by {new Date(knownAt).toLocaleString("en-US")} are included.</span></div>{!error ? <section className="panel">{rows.length ? <div className="table-wrap"><table><thead><tr><th>Value date</th><th>Booked at</th><th>Description</th><th>Type</th><th className="number">Amount</th></tr></thead><tbody>{rows.map((row) => <tr key={row.journal_entry_id}><td>{formatDate(row.value_date)}</td><td>{new Date(row.booked_at).toLocaleString("en-US")}</td><td>{row.description}</td><td><StatusPill tone={row.reversal_of_entry_id ? "warning" : "neutral"}>{row.entry_kind}</StatusPill></td><td className={`number ${row.signed_amount_cents < 0 ? "negative" : "positive"}`}>{formatUsd(row.signed_amount_cents)}</td></tr>)}</tbody></table></div> : <EmptyState title="No statement entries">Widen the date range or run a Demo Lab settlement.</EmptyState>}</section> : null}</>;
}
