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
      <SectionHeading eyebrow="Lithic Issuing" title={user.role === "OWNER" ? "Team cards" : "Your card"} description="Each provider card is assigned to a Corgi team member; only its opaque token and masked data are stored." />
      <SetupNotice error={data.error} />
      {!data.error && data.cards.some((card) => card.provider_code === "simulator") ? <div className="notice notice-warning"><strong>Seeded demo cards</strong><span>Cards labeled SIMULATOR exist only in Corgi and never appear in Lithic. Cards created through the form below are labeled LITHIC.</span></div> : null}
      {!data.error ? <div className="card-gallery">
        {data.cards.length ? data.cards.map((card) => <article className="bank-card" key={card.id}><div className="bank-card-top"><span>Corgi</span><StatusPill tone={card.status === "ACTIVATED" ? "success" : "warning"}>{card.status}</StatusPill></div><div className="chip" /><strong>•••• &nbsp; •••• &nbsp; •••• &nbsp; {card.last4}</strong><div className="bank-card-foot"><span>{card.cardholder_name.toUpperCase()}</span><span>{card.provider_code.toUpperCase()}</span></div></article>) : <EmptyState title="No cards issued">Issue a card after KYB is approved.</EmptyState>}
      </div> : null}
      {!data.error && user.role === "OWNER" ? <ActionForm action={issueCardAction} submitLabel="Issue virtual card" className="form-card compact-form"><h2>Issue a new card</h2><label>Cardholder<select name="cardholder" defaultValue="john"><option value="sarah">Sarah Chen</option><option value="john">John Miller</option></select></label><p className="form-help">Uses Lithic sandbox unless LITHIC_MODE is explicitly simulated. PAN and CVV are never stored by Corgi.</p></ActionForm> : null}
    </>
  );
}
