import Link from "next/link";
import { providerSummary } from "@/app/actions";
import { BalanceCard, EmptyState, ProviderBadge, SectionHeading, SetupNotice, StatusPill } from "@/components/ui";
import { getCustomerDashboard } from "@/lib/data";
import { formatDate, formatUsd } from "@/lib/money";
import { requireCustomer } from "@/lib/session";

export default async function CustomerOverview() {
  const user = await requireCustomer();
  const data = await getCustomerDashboard(user);
  const providers = await providerSummary();
  const balance = data.balance || {};

  return (
    <>
      <SectionHeading
        eyebrow="Acme Inc. · Business checking"
        title={`Good morning, ${user.name.split(" ")[0]}`}
        description={user.role === "OWNER" ? "Here is Acme's provable cash position." : "Here is your card and payment activity."}
        action={<div className="provider-row">{providers.map((item) => <ProviderBadge key={item.name} mode={item.mode} />)}</div>}
      />
      <SetupNotice error={data.error} />
      {data.accountStatus?.status === "RESTRICTED" ? <div className="notice notice-error"><strong>Account restricted</strong><span>An ACH funding return removed settled money. Payments and card spending are frozen while Ops reviews the account.</span></div> : null}
      {!data.error && user.role === "OWNER" ? (
        <div className="balance-grid">
          <BalanceCard label="Ledger balance" cents={balance.ledger_balance_cents} note="Settled journal entries" accent />
          <BalanceCard label="Available to spend" cents={balance.available_balance_cents} note="Ledger minus active holds and reservations" />
          <BalanceCard label="Card holds" cents={balance.held_cents} note="Authorised, not yet settled" />
          <BalanceCard label="Payment reservations" cents={balance.reserved_cents} note="Approved, not yet settled" />
        </div>
      ) : null}
      {!data.error ? (
        <div className="dashboard-grid">
          <section className="panel span-2">
            <div className="panel-head"><div><span className="eyebrow">Latest entries</span><h2>{user.role === "OWNER" ? "Account activity" : "Your card and payment activity"}</h2></div><Link href="/app/payments">View payments →</Link></div>
            {data.activity?.length ? (
              <div className="table-wrap"><table><thead><tr><th>Description</th><th>Date</th><th>Status</th><th className="number">Amount</th></tr></thead><tbody>
                {data.activity.slice(0, 7).map((entry) => (
                  <tr key={entry.journal_entry_id || entry.id}>
                    <td><strong>{entry.description || entry.memo || "ACH payment"}</strong><small>{entry.entry_kind || entry.rail_code}</small></td>
                    <td>{formatDate(entry.value_date || entry.created_at)}</td>
                    <td><StatusPill tone={entry.status === "SETTLED" ? "success" : "neutral"}>{entry.status || "POSTED"}</StatusPill></td>
                    <td className={`number ${Number(entry.signed_amount_cents) < 0 ? "negative" : "positive"}`}>{formatUsd(entry.signed_amount_cents ?? -entry.amount_cents)}</td>
                  </tr>
                ))}
              </tbody></table></div>
            ) : <EmptyState title="No activity yet">Run the seed script or create a payment to populate this view.</EmptyState>}
          </section>
          {user.role === "OWNER" ? <section className="panel span-2">
            <div className="panel-head"><div><span className="eyebrow">Reserved card money</span><h2>Active holds</h2></div></div>
            {data.holds.length ? <div className="stack-list">{data.holds.map((hold) => <article className="list-row" key={hold.authorization_id}><div><strong>{formatUsd(hold.active_amount_cents)}</strong><span>Authorization {hold.authorization_id.slice(0, 8)} · updated {formatDate(hold.last_recorded_at)}</span></div><StatusPill tone="warning">ACTIVE HOLD</StatusPill></article>)}</div> : <EmptyState title="No active card holds">New authorizations reserve available balance here.</EmptyState>}
          </section> : null}
          <section className="panel">
            <div className="panel-head"><div><span className="eyebrow">Cards</span><h2>{user.role === "OWNER" ? "Team cards" : "Your card"}</h2></div><Link href="/app/cards">Manage →</Link></div>
            <div className="mini-card-list">
              {data.cards?.length ? data.cards.slice(0, 3).map((card) => (
                <div className="mini-card" key={card.id}><div><span>VIRTUAL · {card.provider_code.toUpperCase()}</span><strong>•••• {card.last4}</strong></div><StatusPill tone={card.status === "ACTIVATED" ? "success" : "warning"}>{card.status}</StatusPill></div>
              )) : <EmptyState title="No cards">Sarah can issue a sandbox or simulated card.</EmptyState>}
            </div>
          </section>
          {user.role === "OWNER" ? <section className="panel">
            <div className="panel-head"><div><span className="eyebrow">Action needed</span><h2>Approvals</h2></div><Link href="/app/approvals">Open queue →</Link></div>
            <div className="metric"><strong>{data.requests?.filter((item) => item.status === "PENDING_APPROVAL").length || 0}</strong><span>payments waiting for a second human</span></div>
          </section> : null}
          <section className="panel">
            <div className="panel-head"><div><span className="eyebrow">Automation</span><h2>Standing orders</h2></div><Link href="/app/standing-orders">View →</Link></div>
            <div className="metric"><strong>{data.orders?.filter((item) => item.status === "CREATED").length || 0}</strong><span>active schedules with one 24-hour NSF retry</span></div>
          </section>
        </div>
      ) : null}
    </>
  );
}
