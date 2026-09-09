import Link from "next/link";
import { coreAuthorizeCardAction, coreReconcileAction, coreReverseSettlementAction, coreSettleCardAction, startKybAction } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import AppShell from "@/components/app-shell";
import { ProviderBadge, SectionHeading, StatusPill } from "@/components/ui";
import { getCoreLoopState } from "@/lib/data";
import { formatUsd } from "@/lib/money";
import { getSessionUser } from "@/lib/session";
import { redirect } from "next/navigation";

function Step({ number, title, done, blocked, detail, children }) {
  return (
    <section className={`core-step ${done ? "core-step-done" : ""}`}>
      <div className="core-step-number">{done ? "✓" : number}</div>
      <div className="core-step-body">
        <div className="core-step-head">
          <h2>{title}</h2>
          <StatusPill tone={done ? "success" : blocked ? "danger" : "warning"}>{done ? "COMPLETE" : blocked ? "BLOCKED" : "NEXT"}</StatusPill>
        </div>
        <p>{detail}</p>
        {!done && !blocked ? children : null}
      </div>
    </section>
  );
}

export default async function CoreLoopPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const state = await getCoreLoopState();
  const isOwner = user.portal === "customer" && user.role === "OWNER";
  const isEmployee = user.portal === "customer" && user.role === "MAKER";
  const isOps = user.portal === "ops";
  const kybDone = state.kyb?.event_type === "APPROVED" && state.accountOpened;
  const bankDone = Boolean(state.bank && state.bankEvent?.details?.increase_external_account_id);
  const fundingDone = state.funding?.status === "SETTLED";
  const cardDone = Boolean(state.card);
  const authDone = Boolean(state.authorization);
  const settlementDone = Boolean(state.settlement);
  const approvalDone = Boolean(state.outboundRequest?.status === "APPROVED" || state.outbound);
  const outboundDone = Boolean(state.outbound);
  const reconDone = Boolean(state.reconciliation);

  return (
    <AppShell user={user}>
      <SectionHeading eyebrow="Track 3 executable journey" title="The neobank core loop" description="Only real sandbox provider records turn green. Seeded and simulated records do not count." action={<div className="provider-row">{Object.entries(state.modes).map(([name, mode]) => <span className="provider-item" key={name}>{name}<ProviderBadge mode={mode} /></span>)}</div>} />
      <div className="notice notice-info"><strong>Current actor: {user.name}</strong><span>Sarah owns onboarding, banking, card issuance, and approval. John creates the payment. Maya triggers network events and reconciliation. Use Switch user between stages.</span></div>
      <div className="core-loop-list">
        <Step number="1" title="Pass KYB and open the business account" done={kybDone} blocked={state.modes.persona !== "sandbox"} detail={kybDone ? `Persona approved case ${state.kybCase?.external_case_id}.` : state.modes.persona !== "sandbox" ? "PERSONA_MODE is simulated. A simulated approval cannot satisfy this step." : state.kybCase ? `Persona case ${state.kybCase.external_case_id} is waiting for its approved webhook.` : "Create a Persona sandbox inquiry, complete it, and let the signed approved webhook open the account."}>
          {isOwner ? <ActionForm action={startKybAction} submitLabel="Start real sandbox KYB" className="core-action" /> : <p className="core-instruction">Switch to Sarah Chen to start KYB.</p>}
        </Step>

        <Step number="2" title="Link a bank and fund through Increase" done={fundingDone} blocked={!kybDone || state.modes.plaid !== "sandbox" || state.modes.increase !== "sandbox"} detail={fundingDone ? `Increase settled ${formatUsd(state.funding.amount_cents)} into the ledger.` : !kybDone ? "Complete provider-backed KYB before money movement is enabled." : state.funding ? `Increase transfer ${state.funding.provider_payment_id} is ${state.funding.status}; settle it in the Increase sandbox.` : bankDone ? "The Plaid account is tokenized in Increase. Submit a funding pull next." : "Plaid Link creates the verified bank and immediately tokenizes it as an Increase External Account."}>
          {isOwner ? <Link className="button button-secondary" href="/app/banks">Link bank / pull funds</Link> : <p className="core-instruction">Switch to Sarah Chen for bank linking and funding.</p>}
        </Step>

        <Step number="3" title="Issue a Stripe sandbox card" done={cardDone} blocked={!fundingDone || state.modes.stripe !== "sandbox"} detail={cardDone ? `Stripe card ${state.card.provider_card_id} (•••• ${state.card.last4}) is active.` : !fundingDone ? "Wait for the Increase funding transfer to settle first." : state.modes.stripe !== "sandbox" ? "STRIPE_MODE is simulated. Set it to sandbox after Stripe finishes provisioning the Financial Account." : "Issue a virtual card backed by the open Stripe test Financial Account."}>
          {isOwner ? <Link className="button button-secondary" href="/app/cards">Issue Stripe card</Link> : <p className="core-instruction">Switch to Sarah Chen to issue the card.</p>}
        </Step>

        <Step number="4" title="Authorize $50, then settle $73.40 two days later" done={settlementDone} blocked={!cardDone || state.modes.stripe !== "sandbox"} detail={settlementDone ? `Settlement ${state.settlement.provider_settlement_id} booked ${formatUsd(state.settlement.amount_cents)} on value date ${state.settlement.value_date}.` : authDone ? `Authorization ${state.authorization.provider_authorization_id} has an active hold. Capture it for a different amount.` : "Stripe test helpers create the card-network authorization; Corgi records its hold before settlement."}>
          {isOps ? <ActionForm action={authDone ? coreSettleCardAction : coreAuthorizeCardAction} submitLabel={authDone ? "Settle $73.40" : "Authorize $50.00"} className="core-action" /> : <p className="core-instruction">Switch to Maya Patel after the Stripe card exists.</p>}
        </Step>

        <Step number="5" title="Send an outbound ACH with a second approver" done={outboundDone} blocked={!settlementDone || !bankDone} detail={outboundDone ? `Approved Increase transfer ${state.outbound.provider_payment_id} is ${state.outbound.status}.` : !settlementDone ? "Complete the different-amount card settlement first." : state.outboundRequest ? `John's request is ${state.outboundRequest.status}. ${approvalDone ? "Provider submission is ready or in progress." : "Sarah must approve it."}` : "John creates an above-threshold ACH. Sarah must approve it; the maker cannot approve their own request."}>
          {isEmployee ? <Link className="button button-secondary" href="/app/payments">Create $2,500+ payment</Link> : isOwner ? <Link className="button button-secondary" href="/app/approvals">Approve John&apos;s payment</Link> : <p className="core-instruction">Switch to John to create it, then Sarah to approve it.</p>}
        </Step>

        <Step number="6" title="Survive a reversed card settlement" done={state.reversal} blocked={!outboundDone || !settlementDone || state.modes.stripe !== "sandbox"} detail={state.reversal ? "The original journal entry remains immutable; an equal and opposite correction was appended on the original value date." : !outboundDone ? "Complete the maker-checker outbound payment first." : "Refund the Stripe capture and append—not mutate—the accounting reversal."}>
          {isOps ? <ActionForm action={coreReverseSettlementAction} submitLabel="Reverse in Stripe" className="core-action" /> : <p className="core-instruction">Switch to Maya Patel to trigger the Stripe refund.</p>}
        </Step>

        <Step number="7" title="Reconcile the Stripe scheme file" done={reconDone} blocked={!state.reversal} detail={reconDone ? `Run ${state.reconciliation.id} completed with ${state.breaks.length} currently open break(s).` : !state.reversal ? "Append the reversal before reconciling the processor file." : "Generate the scheme row from Stripe's settlement reference and compare it with the immutable ledger posting."}>
          {isOps ? <ActionForm action={coreReconcileAction} submitLabel="Generate and reconcile file" className="core-action" /> : <p className="core-instruction">Switch to Maya Patel to run reconciliation.</p>}
        </Step>
      </div>
    </AppShell>
  );
}
