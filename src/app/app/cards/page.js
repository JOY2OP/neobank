import { issueCardAction } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { EmptyState, SectionHeading, SetupNotice, StatusPill } from "@/components/ui";
import { getCustomerDashboard } from "@/lib/data";
import { requireCustomer } from "@/lib/session";

export default async function CardsPage() {
  const user = await requireCustomer();
  const data = await getCustomerDashboard(user);
  return (
    <>
      <SectionHeading eyebrow="Stripe Issuing" title={user.role === "OWNER" ? "Team cards" : "Your card"} description="Only masked card data is stored in Corgi." />
      <SetupNotice error={data.error} />
      {!data.error && data.cards.some((card) => card.provider_code === "simulator") ? <div className="notice notice-warning"><strong>Seeded demo cards</strong><span>Cards labeled SIMULATOR exist only in Corgi and never appear in Stripe. Cards created through the form below are labeled STRIPE.</span></div> : null}
      {!data.error ? <div className="card-gallery">
        {data.cards.length ? data.cards.map((card) => <article className="bank-card" key={card.id}><div className="bank-card-top"><span>Corgi</span><StatusPill tone={card.status === "ACTIVATED" ? "success" : "warning"}>{card.status}</StatusPill></div><div className="chip" /><strong>•••• &nbsp; •••• &nbsp; •••• &nbsp; {card.last4}</strong><div className="bank-card-foot"><span>ACME INC.</span><span>{card.provider_code.toUpperCase()}</span></div></article>) : <EmptyState title="No cards issued">Issue a card after KYB is approved.</EmptyState>}
      </div> : null}
      {!data.error && user.role === "OWNER" ? <ActionForm action={issueCardAction} submitLabel="Issue virtual card" className="form-card compact-form"><h2>Issue a new card</h2><label>Cardholder<select name="cardholder" defaultValue="john"><option value="sarah">Sarah Chen</option><option value="john">John Miller</option></select></label><label className="checkbox-label"><input type="checkbox" name="termsAccepted" value="yes" required />I confirm this cardholder accepted the Stripe Issuing Authorized User Terms.</label><p className="form-help">Uses Stripe Issuing sandbox unless STRIPE_MODE is explicitly simulated.</p></ActionForm> : null}
    </>
  );
}
