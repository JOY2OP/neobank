import { createSignedSessionValue } from "../src/lib/session-signature.js";

const origin = (process.env.SMOKE_ORIGIN || "http://127.0.0.1:3000").replace(/\/$/, "");
const secret = process.env.DEMO_SESSION_SECRET || "local-demo-only-change-me";
const checks = [
  { user: "sarah", path: "/app", marker: "Ledger balance" },
  { user: "sarah", path: "/core-loop", marker: "The neobank core loop" },
  { user: "sarah", path: "/app/payments", marker: "Payments" },
  { user: "sarah", path: "/app/cards", marker: "Cards" },
  { user: "sarah", path: "/app/standing-orders", marker: "Standing orders" },
  { user: "sarah", path: "/app/banks", marker: "Linked banks" },
  { user: "sarah", path: "/app/approvals", marker: "Approval queue" },
  { user: "ops", path: "/ops", marker: "Open breaks" },
  { user: "ops", path: "/core-loop", marker: "The neobank core loop" },
  { user: "ops", path: "/ops/reconciliation", marker: "Reconciliation" },
  { user: "ops", path: "/ops/statements", marker: "Statements" },
  { user: "ops", path: "/ops/events", marker: "Provider events" },
  { user: "ops", path: "/ops/demo-lab", marker: "Lithic Sandbox Terminal" },
];

let failures = 0;
for (const check of checks) {
  const session = createSignedSessionValue(check.user, secret);
  try {
    const response = await fetch(`${origin}${check.path}`, {
      headers: { Cookie: `corgi_demo_session=${session}` },
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.text();
    const rendered = response.status === 200 && body.includes(check.marker);
    console.log(`${rendered ? "PASS" : "FAIL"} ${check.path} (${response.status})`);
    if (!rendered) failures += 1;
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${check.path} (${error.name}: ${error.message})`);
  }
}

if (failures) {
  throw new Error(`${failures} page smoke check(s) failed.`);
}

console.log(`All ${checks.length} authenticated pages rendered from seeded data.`);
