# Corgi Track 3 — 18-hour cut list

## Submission slice

Ship one explainable USD business-account journey:

1. Sign in as one of the seeded demo roles.
2. Show KYB as an account-opening gate. Persona remains honestly simulated because its sandbox is sales-gated.
3. Link a sandbox bank with Plaid and fund the account over Increase.
4. Issue a standalone Stripe Issuing sandbox card, then demonstrate authorization, a different settlement amount, and a reversal. Treasury and Financial Accounts are outside this slice.
5. Have John create an above-threshold ACH and Sarah approve it. John cannot approve his own request.
6. Show the reversal on the original value date and at two different knowledge cutoffs.
7. Reconcile a processor file and surface all three break types.

The “core loop” is this demo script, not a customer product area. It may remain as a direct demo/runbook URL, but it does not belong in customer or Ops navigation.

## Must finish before freeze

- Deployed URL and demo access for Sarah (owner), John (maker), and Maya (Ops).
- Immutable double-entry ledger with balances derived from journal postings.
- Active card holds and payment reservations derived from append-only events.
- Idempotent, signature-verified webhooks and visible provider failure/delay states.
- Two genuinely live sandbox integrations. Stripe Issuing is the highest-value card integration; Plaid and Increase cover bank linking and ACH.
- Card hostile-sequencing cases: different-amount capture, reversal, force post, settlement-before-authorization, and duplicate delivery.
- Maker-checker enforcement and ACH return/recall behavior.
- Bitemporal statement viewer and reconciliation breaks screen.
- Minimum MCP surface required by the brief: three read tools and one write tool that enters the same human approval queue.
- Seed script, `.env.example`, integration evidence, README labels, five-minute video, and final smoke test.

## Cut from this submission

| Cut | Why it is cut | Week-two implementation |
| --- | --- | --- |
| USDC/cross-border payout | It is on the stretch ladder and no adapter exists. A USDC-specific table would pretend the integration is implemented. | Add Circle/Bridge behind the generic payment adapter, testnet confirmation, accepted quote, and ledger posting. |
| Wires and multi-currency | The brief permits wires only “if ambitious” and explicitly fixes the ledger to USD cents. | Add a wire adapter; treat any future FX quote as a separate accepted contract. |
| Native mobile app | A responsive web experience is enough to demonstrate the domain mechanics in the remaining time. | Build a thin mobile client over the same authenticated API. |
| General public API | A safe public contract, OAuth, rate limits, versioning, and idempotency deserve more than a rushed wrapper. Webhook routes are not presented as the public API. | Publish read endpoints and payment-intent creation with scoped credentials and idempotency keys. |
| Production authentication and onboarding forms | The trial explicitly asks for demo credentials. Signed demo sessions and server-side role checks cover the evaluated roles. | Supabase Auth/SSO, invitations, recovery, audit events, and real director data collection. |
| Live Persona KYB | The decision log records that access is sales-gated. It must never be represented as live. | Replace the simulator once sandbox access is granted; keep the same inquiry/event interface. |
| Card controls, disputes, fees/interest, pots, and payee confirmation | All are stretch features and distract from the hostile card lifecycle. | Implement in that order only after the live-fire path is stable. |
| Full statement artifact generation | The evaluated behavior is reproducible bitemporal statement data; polished PDF/CSV documents are secondary. | Generate immutable artifacts and persist their content hashes. |
| Full standing-order operations suite | Keep the already-built once-only execution and one-retry NSF policy, but cut edit/cancel history UI and complex calendars. | Add holiday calendars, notifications, edit-as-replacement, and operations controls. |
| General ledger/admin CRUD | Financial history must never be editable, and CRUD screens add risk without proving domain command. | Add narrowly scoped operational commands that append correction events. |

## Explicitly not cut

These are central to the scoring or live-fire script: append-only accounting, card holds, different-amount settlement, reversal entries, value date versus booking time, settlement-before-authorization, webhook idempotency, maker-checker, ACH return/recall, statements, reconciliation, provider-down behavior, deployment, and the minimum MCP surface.

## Data-source boundary

- Providers report external facts: identity decisions, linked-account tokens/metadata, transfer states, card authorizations, captures, refunds, and scheme files.
- Supabase stores the verified provider-event inbox, domain events, internal payment/card records, append-only journal entries/postings, and reconciliation results.
- Customer balances always come from Corgi's Supabase ledger projections. Provider balances may be used for reconciliation or diagnostics, never as the customer balance source of truth.
- Secrets and raw account credentials are server-only. Store only provider references, masked account/card details, and the audit payload needed to replay or explain an event.
