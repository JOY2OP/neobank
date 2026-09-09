"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/actions";

const customerLinks = [
  ["/app", "Overview"],
  ["/app/payments", "Payments"],
  ["/app/cards", "Cards"],
  ["/app/standing-orders", "Standing orders"],
];
const ownerLinks = [
  ["/app/banks", "Linked banks"],
  ["/app/approvals", "Approvals"],
];
const opsLinks = [
  ["/ops", "Operations"],
  ["/ops/reconciliation", "Reconciliation"],
  ["/ops/statements", "Statements"],
  ["/ops/events", "Provider events"],
  ["/ops/demo-lab", "Demo lab"],
];

export default function AppShell({ user, children }) {
  const pathname = usePathname();
  const links = user.portal === "ops"
    ? opsLinks
    : user.role === "OWNER" ? [...customerLinks, ...ownerLinks] : customerLinks;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-product">
          <strong>Corgi</strong>
          <span>Business banking</span>
        </div>
        <nav aria-label="Primary navigation">
          {links.map(([href, label]) => (
            <Link key={href} href={href} className={pathname === href ? "nav-link active" : "nav-link"}>
              {label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-foot">
          <strong>{user.name}</strong>
          <small>{user.email}</small>
        </div>
      </aside>
      <div className="shell-main">
        <header className="topbar">
          <div><span className="live-dot" /> Sandbox workspace</div>
          <div className="topbar-user">
            <span>{user.role}</span>
            <form action={logoutAction}><button className="text-button">Switch user</button></form>
          </div>
        </header>
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
