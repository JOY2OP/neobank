import { runDemoAction } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { SectionHeading, SetupNotice, StatusPill } from "@/components/ui";
import { getOpsDashboard } from "@/lib/data";

const scenarios = [
  ["authorization", "1. Authorize $50.00", "Creates a card hold. Ledger stays still; available balance drops."],
  ["capture", "2. Capture $73.40", "Posts the actual amount and releases the original hold exactly once."],
  ["reversal", "3. Reverse settlement", "Appends a correction on the original value date with a later booking time."],
  ["out-of-order", "Settlement before authorization", "Parks the settlement, then matches it when its authorization arrives."],
  ["force-post", "Force post $18.99", "Posts a settlement with no authorization and therefore no hold to release."],
  ["provider-delay", "Provider delayed", "Records a retryable failure while leaving financial state untouched."],
  ["duplicate-webhook", "Duplicate webhook", "Delivers the same external event twice; idempotency stores it once."],
  ["ach-return", "ACH return · R01", "Settles an outbound ACH, then appends its return rather than editing history."],
  ["standing-orders", "Run due standing orders", "Creates each due occurrence once and applies the one-retry NSF policy."],
  ["nsf-retry", "Run NSF retry", "Moves time forward 25 hours; a second insufficient-funds attempt pauses the order."],
];

export default async function DemoLabPage() {
  const data = await getOpsDashboard();
  return <><SectionHeading eyebrow="Clearly labeled simulator" title="Live-fire Demo Lab" description="These controls deliberately create awkward event sequences through the same database commands used by real webhooks." action={<StatusPill tone="warning">SIMULATED</StatusPill>} /><SetupNotice error={data.error} />{!data.error ? <div className="scenario-grid">{scenarios.map(([value, title, description]) => <ActionForm key={value} action={runDemoAction} submitLabel="Run scenario" className="scenario-card"><input type="hidden" name="scenario" value={value} /><span className="scenario-icon" aria-hidden="true">◈</span><h2>{title}</h2><p>{description}</p></ActionForm>)}</div> : null}</>;
}
