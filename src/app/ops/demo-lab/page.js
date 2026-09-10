import {
  lithicSandboxAuthorizeAction,
  lithicSandboxClearAction,
  lithicSandboxReturnAction,
  runDemoAction,
} from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { EmptyState, SectionHeading, SetupNotice, StatusPill } from "@/components/ui";
import { getLithicSandboxTerminal, getOpsDashboard } from "@/lib/data";
import { formatUsd } from "@/lib/money";
import { providerMode } from "@/lib/providers/config";

const scenarios = [
  ["authorization", "1. Authorize $50.00", "Creates a card hold. Ledger stays still; available balance drops."],
  ["capture", "2. Capture $73.40", "Posts the actual amount and releases the original hold exactly once."],
  ["reversal", "3. Reverse settlement", "Appends a correction on the original value date with a later booking time."],
  ["out-of-order", "Settlement before authorization", "Parks the settlement, then matches it when its authorization arrives."],
  ["force-post", "Force post $18.99", "Posts a settlement with no authorization and therefore no hold to release."],
  ["provider-delay", "Provider delayed", "Records a retryable failure while leaving financial state untouched."],
  ["duplicate-webhook", "Duplicate webhook", "Delivers the same external event twice; idempotency stores it once."],
  ["ach-return", "ACH return - R01", "Settles an outbound ACH, then appends its return rather than editing history."],
  ["standing-orders", "Run due standing orders", "Creates each due occurrence once and applies the one-retry NSF policy."],
  ["nsf-retry", "Run NSF retry", "Moves time forward 25 hours; a second insufficient-funds attempt pauses the order."],
];

function cardLabel(card) {
  return `${card.cardholder_name} - card ending ${card.last4}`;
}

export default async function DemoLabPage() {
  const [data, terminal] = await Promise.all([
    getOpsDashboard(),
    getLithicSandboxTerminal(),
  ]);
  const lithicMode = providerMode("lithic");
  const terminalEnabled = lithicMode === "sandbox" && !terminal.error;

  return (
    <>
      <SectionHeading
        eyebrow="Sandbox operations"
        title="Live-fire Demo Lab"
        description="Run a real Lithic sandbox card lifecycle, then use isolated simulations for hostile accounting cases."
        action={<StatusPill tone={terminalEnabled ? "success" : "warning"}>{terminalEnabled ? "LITHIC SANDBOX" : "SIMULATED"}</StatusPill>}
      />
      <SetupNotice error={data.error} />
      {!data.error ? (
        <>
          <section className="panel lab-terminal">
            <div className="panel-head">
              <div>
                <span className="eyebrow">External merchant simulator</span>
                <h2>Lithic Sandbox Terminal</h2>
              </div>
              <StatusPill tone={terminalEnabled ? "success" : "warning"}>{lithicMode.toUpperCase()}</StatusPill>
            </div>
            <div className="notice notice-info">
              <strong>How card spending begins</strong>
              <span>Choose an employee Lithic card to simulate a merchant authorization. Clear the resulting transaction separately; signed Lithic webhooks remain visible in Provider events.</span>
            </div>
            <div className="notice notice-info">
              <strong>Cardholders</strong>
              <span>Corgi assigns every card to Sarah or John. This Lithic sandbox uses its default program account, so the Lithic Account Holders page may remain empty; the card memo and local actor mapping retain ownership.</span>
            </div>
            {terminal.error ? <div className="notice notice-error"><strong>Terminal unavailable</strong><span>{terminal.error}</span></div> : null}
            {lithicMode !== "sandbox" ? <div className="notice notice-warning"><strong>Live controls disabled</strong><span>Set LITHIC_MODE=sandbox to create transactions in Lithic.</span></div> : null}

            <div className="lab-terminal-grid">
              {terminalEnabled && terminal.cards.length ? (
                <ActionForm action={lithicSandboxAuthorizeAction} submitLabel="Authorize in Lithic" className="form-card lab-action">
                  <span className="eyebrow">Step 1</span>
                  <h2>Authorize a card</h2>
                  <label>Employee card<select name="cardId" required defaultValue=""><option value="" disabled>Choose a Lithic card</option>{terminal.cards.map((card) => <option value={card.id} key={card.id}>{cardLabel(card)}</option>)}</select></label>
                  <label>Authorization amount<input name="amount" inputMode="decimal" defaultValue="50.00" required /></label>
                  <label>Merchant<input name="descriptor" defaultValue="Corgi Fuel Stop" maxLength={25} required /></label>
                  <p className="form-help">Creates a real Lithic sandbox transaction and reserves the amount as a card hold.</p>
                </ActionForm>
              ) : (
                <div className="form-card lab-action"><EmptyState title="No live Lithic cards">Issue an open Lithic card from the Cards page first.</EmptyState></div>
              )}

              {terminalEnabled && terminal.authorizations.length ? (
                <ActionForm action={lithicSandboxClearAction} submitLabel="Clear in Lithic" className="form-card lab-action">
                  <span className="eyebrow">Step 2</span>
                  <h2>Clear an authorization</h2>
                  <label>Pending transaction<select name="authorizationId" required defaultValue=""><option value="" disabled>Choose an active hold</option>{terminal.authorizations.map((authorization) => <option value={authorization.id} key={authorization.id}>{cardLabel(authorization.card)} - {authorization.merchant_name || "Merchant"} - held {formatUsd(authorization.active_amount_cents)}</option>)}</select></label>
                  <label>Clearing amount<input name="amount" inputMode="decimal" defaultValue="73.40" required /></label>
                  <p className="form-help">The clearing can differ from the authorization. Final clearing posts actual money and releases the hold once.</p>
                </ActionForm>
              ) : (
                <div className="form-card lab-action"><EmptyState title="No pending Lithic transaction">Authorize a live card first; its active hold will become selectable here.</EmptyState></div>
              )}

              {terminalEnabled && terminal.settlements.length ? (
                <ActionForm action={lithicSandboxReturnAction} submitLabel="Return in Lithic" className="form-card lab-action">
                  <span className="eyebrow">Step 3</span>
                  <h2>Return a purchase</h2>
                  <label>Settled transaction<select name="settlementId" required defaultValue=""><option value="" disabled>Choose a settlement</option>{terminal.settlements.map((settlement) => <option value={settlement.id} key={settlement.id}>{cardLabel(settlement.card)} - {settlement.authorization?.merchant_name || "Merchant"} - {formatUsd(settlement.amount_cents)}</option>)}</select></label>
                  <p className="form-help">Targets the selected settlement and appends an equal-and-opposite correction on its original value date.</p>
                </ActionForm>
              ) : (
                <div className="form-card lab-action"><EmptyState title="No settled Lithic purchase">Clear a live authorization before testing a return.</EmptyState></div>
              )}
            </div>
          </section>

          <div className="lab-section-heading">
            <span className="eyebrow">Clearly labeled simulator</span>
            <h2>Hostile accounting scenarios</h2>
            <p>These controls exercise edge cases through the same database commands without claiming provider evidence.</p>
          </div>
          <div className="scenario-grid">
            {scenarios.map(([value, title, description]) => (
              <ActionForm key={value} action={runDemoAction} submitLabel="Run scenario" className="scenario-card">
                <input type="hidden" name="scenario" value={value} />
                <span className="scenario-icon" aria-hidden="true">◇</span>
                <h2>{title}</h2>
                <p>{description}</p>
              </ActionForm>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
