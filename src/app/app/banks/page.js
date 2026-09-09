import { randomUUID } from "node:crypto";
import { fundAccountAction, settleIncreaseFundingAction } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import PlaidLinkButton from "@/components/plaid-link-button";
import { EmptyState, SectionHeading, SetupNotice, StatusPill } from "@/components/ui";
import { getCustomerDashboard } from "@/lib/data";
import { formatUsd } from "@/lib/money";
import { requireOwner } from "@/lib/session";

export default async function BanksPage() {
  const user = await requireOwner();
  const data = await getCustomerDashboard(user);
  const fundableBanks = data.banks?.filter((bank) => (
    bank.provider_code === "plaid"
    && bank.connection.increase_external_account_id
  )) || [];

  return (
    <>
      <SectionHeading
        eyebrow="Plaid + Increase"
        title="Linked banks"
        description="Plaid verifies account details; Increase receives an opaque external-account ID for ACH."
        action={<PlaidLinkButton />}
      />
      <SetupNotice error={data.error} />
      {!data.error ? (
        <div className="split-grid">
          <section className="panel">
            {data.banks.length ? (
              <div className="stack-list">
                {data.banks.map((bank) => (
                  <article className="list-row" key={bank.id}>
                    <div>
                      <strong>{bank.institution_name || "External bank"}</strong>
                      <span>{bank.account_name || "Business checking"} · •••• {bank.account_mask}</span>
                    </div>
                    <StatusPill tone="success">{bank.connection.source || "LINKED"}</StatusPill>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState title="No external bank linked">Use Plaid Link to connect a sandbox account.</EmptyState>
            )}
          </section>

          {fundableBanks.length ? (
            <ActionForm action={fundAccountAction} submitLabel="Pull funds">
              <h2>Fund operating account</h2>
              <p className="form-help">
                Increase creates a sandbox ACH pull. Submit it here, then settle it in the list below.
              </p>
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <label>
                From bank
                <select name="bankId" required>
                  {fundableBanks.map((bank) => (
                    <option value={bank.id} key={bank.id}>
                      {bank.institution_name} •••• {bank.account_mask}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Amount
                <input name="amount" inputMode="decimal" placeholder="5000.00" required />
              </label>
            </ActionForm>
          ) : (
            <section className="panel">
              <EmptyState title="Link a Plaid sandbox bank first">
                Seeded simulated banks cannot create real Increase sandbox transfers.
              </EmptyState>
            </section>
          )}
        </div>
      ) : null}
      {!data.error && data.fundingPulls?.length ? (
        <section className="panel">
          <div className="panel-head">
            <div><span className="eyebrow">Increase Sandbox</span><h2>Funding pulls</h2></div>
          </div>
          <div className="stack-list">
            {data.fundingPulls.map((payment) => (
              <article className="list-row" key={payment.id}>
                <div>
                  <strong>{formatUsd(payment.amount_cents)} ACH pull</strong>
                  <span>{payment.provider_payment_id}</span>
                </div>
                <StatusPill tone={payment.status === "SETTLED" ? "success" : "warning"}>{payment.status}</StatusPill>
                {payment.status !== "SETTLED" ? (
                  <ActionForm action={settleIncreaseFundingAction} submitLabel="Settle sandbox pull" className="core-action">
                    <input type="hidden" name="paymentId" value={payment.id} />
                  </ActionForm>
                ) : null}
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
