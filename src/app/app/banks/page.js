import { randomUUID } from "node:crypto";
import { fundAccountAction } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import PlaidLinkButton from "@/components/plaid-link-button";
import { EmptyState, SectionHeading, SetupNotice, StatusPill } from "@/components/ui";
import { getCustomerDashboard } from "@/lib/data";
import { requireOwner } from "@/lib/session";

export default async function BanksPage() {
  const user = await requireOwner();
  const data = await getCustomerDashboard(user);

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

          {data.banks.length ? (
            <ActionForm action={fundAccountAction} submitLabel="Pull funds">
              <h2>Fund operating account</h2>
              <p className="form-help">
                Increase pulls sandbox funds by ACH. They become available only after its settlement webhook.
              </p>
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <label>
                From bank
                <select name="bankId" required>
                  {data.banks.map((bank) => (
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
          ) : null}
        </div>
      ) : null}
    </>
  );
}
