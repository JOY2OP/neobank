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
      {!data.error ? <div className="card-gallery">
        {data.cards.length ? data.cards.map((card) => <article className="bank-card" key={card.id}><div className="bank-card-top"><span>Corgi</span><StatusPill tone={card.status === "ACTIVATED" ? "success" : "warning"}>{card.status}</StatusPill></div><div className="chip" /><strong>•••• &nbsp; •••• &nbsp; •••• &nbsp; {card.last4}</strong><div className="bank-card-foot"><span>ACME INC.</span><span>{card.provider_code.toUpperCase()}</span></div></article>) : <EmptyState title="No cards issued">Issue a card after KYB is approved.</EmptyState>}
      </div> : null}
      {!data.error && user.role === "OWNER" ? <ActionForm action={issueCardAction} submitLabel="Issue virtual card" className="form-card compact-form"><h2>Issue a new card</h2><label>Cardholder<select name="cardholder" defaultValue="john"><option value="sarah">Sarah Chen</option><option value="john">John Miller</option></select></label><p className="form-help">Uses Stripe Issuing sandbox unless STRIPE_MODE is explicitly simulated.</p></ActionForm> : null}
    </>
  );
}
