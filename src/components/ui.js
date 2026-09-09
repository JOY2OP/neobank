import { formatUsd } from "@/lib/money";

export function Brand() {
  return (
    <div className="brand">
      <span className="brand-dog" aria-hidden="true">◖ᴥ◗</span>
      <span>Corgi</span>
      <small>Business banking</small>
    </div>
  );
}

export function StatusPill({ children, tone = "neutral" }) {
  return <span className={`pill pill-${tone}`}>{children || "UNKNOWN"}</span>;
}

export function ProviderBadge({ mode }) {
  const sandbox = String(mode).toLowerCase() === "sandbox";
  return <StatusPill tone={sandbox ? "success" : "warning"}>{String(mode).toUpperCase()}</StatusPill>;
}

export function BalanceCard({ label, cents, note, accent = false }) {
  return (
    <section className={`balance-card ${accent ? "balance-card-accent" : ""}`}>
      <p>{label}</p>
      <strong>{formatUsd(cents)}</strong>
      {note ? <small>{note}</small> : null}
    </section>
  );
}

export function EmptyState({ title, children }) {
  return (
    <div className="empty-state">
      <span aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{children}</p>
    </div>
  );
}

export function SetupNotice({ error }) {
  if (!error) return null;
  return (
    <div className="notice notice-error" role="alert">
      <strong>Setup needed</strong>
      <span>{error}</span>
    </div>
  );
}

export function SectionHeading({ eyebrow, title, description, action }) {
  return (
    <div className="section-heading">
      <div>
        {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
