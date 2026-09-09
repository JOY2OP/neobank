"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/app/actions";
import { Brand } from "./ui";

const customerLinks = [
  ["/core-loop", "Core loop", "1â†’7"],
  ["/app", "Overview", "⌂"],
  ["/app/payments", "Payments", "↗"],
  ["/app/cards", "Cards", "▣"],
  ["/app/standing-orders", "Standing orders", "↻"],
];
const ownerLinks = [
  ["/app/banks", "Linked banks", "⌁"],
  ["/app/approvals", "Approvals", "✓"],
];
const opsLinks = [
  ["/core-loop", "Core loop", "1â†’7"],
  ["/ops", "Operations", "⌂"],
  ["/ops/reconciliation", "Reconciliation", "≋"],
  ["/ops/statements", "Statements", "▤"],
  ["/ops/events", "Provider events", "⚡"],
  ["/ops/demo-lab", "Demo lab", "◈"],
];

export default function AppShell({ user, children }) {
  const pathname = usePathname();
  const links = user.portal === "ops"
    ? opsLinks
    : user.role === "OWNER" ? [...customerLinks, ...ownerLinks] : customerLinks;
  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Primary navigation">
          {links.map(([href, label, icon]) => {
            const active = pathname === href;
            return (
              <Link key={href} href={href} className={active ? "nav-link active" : "nav-link"}>
                <span aria-hidden="true">{icon}</span>{label}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <span className="avatar">{user.name.split(" ").map((part) => part[0]).join("")}</span>
          <div><strong>{user.name}</strong><small>{user.email}</small></div>
        </div>
      </aside>
      <div className="shell-main">
        <header className="topbar">
          <div><span className="live-dot" /> Sandbox workspace</div>
          <div className="topbar-user"><span>{user.role}</span><form action={logoutAction}><button className="text-button">Switch user</button></form></div>
        </header>
        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
