import { randomUUID } from "node:crypto";
import { createPaymentAction } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { EmptyState, SectionHeading, SetupNotice, StatusPill } from "@/components/ui";
import { getCustomerDashboard } from "@/lib/data";
import { formatDate, formatUsd } from "@/lib/money";
import { requireCustomer } from "@/lib/session";

export default async function PaymentsPage() {
  const user = await requireCustomer();
  const data = await getCustomerDashboard(user);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <SectionHeading eyebrow="ACH money out" title="Payments" description="Amounts above Acme's threshold require approval by a different human." />
      <SetupNotice error={data.error} />
      {!data.error ? <div className="split-grid">
        <ActionForm action={createPaymentAction} submitLabel="Create payment">
          <h2>Send USD</h2>
          <input type="hidden" name="idempotencyKey" value={randomUUID()} />
          <label>Beneficiary<select name="beneficiary" required defaultValue=""><option value="" disabled>Choose beneficiary</option>{data.beneficiaries.map((item) => <option value={item.id} key={item.id}>{item.display_name} · •••• {item.account_mask}</option>)}</select></label>
          <label>Amount<input name="amount" inputMode="decimal" placeholder="2500.00" required /></label>
          <label>Execution date<input type="date" name="executionDate" defaultValue={today} min={today} required /></label>
          <label>Memo<input name="memo" placeholder="September invoice" maxLength={80} /></label>
          <p className="form-help">The database snapshots the approval threshold and decides whether this payment can submit immediately.</p>
        </ActionForm>
        <section className="panel"><div className="panel-head"><div><span className="eyebrow">History</span><h2>Payment requests</h2></div></div>
          {data.requests.length ? <div className="stack-list">{data.requests.map((request) => <article className="list-row" key={request.id}><div><strong>{formatUsd(-request.amount_cents)}</strong><span>{request.memo || "ACH payment"} · {formatDate(request.created_at)}</span></div><StatusPill tone={request.status === "SETTLED" ? "success" : request.status === "REJECTED" ? "danger" : "warning"}>{request.status}</StatusPill></article>)}</div> : <EmptyState title="No payment requests">Your submitted ACH payments appear here.</EmptyState>}
        </section>
      </div> : null}
    </>
  );
}
