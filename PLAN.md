# Beginner-Friendly Corgi Neobank Core Loop

## Summary

Build the core neobank demo in straightforward JavaScript, prioritizing readable control flow over abstraction. Use one dropdown login for Sarah, John, and Ops, backed by the existing Supabase ledger. Persona, Plaid, Lithic, and Increase use sandbox by default; simulation is an explicit per-provider choice.

The code should be explainable file-by-file by a beginner: small named functions, shallow call chains, descriptive variables, concise comments at important financial and integration boundaries, and no generic provider framework.

## Code Style and Structure

- Keep JavaScript rather than converting to TypeScript. Use simple JSDoc only where an input or returned object benefits from explanation.
- Use Next.js App Router Server Components for data display and small client components for dropdowns, forms, dialogs, and Plaid Link.
- Avoid dependency injection, factories, generic repositories, class hierarchies, metaprogramming, and overly reusable component systems.
- Prefer concrete service modules with obvious exports:
  - `lithic.js`: issue card and simulate authorization/clearing/return.
  - `plaid.js`: create Link token, exchange token, retrieve bank details, verify webhook.
  - `persona.js`: create inquiry and verify webhook.
  - `increase.js`: create external account, submit ACH, retrieve event, simulate settlement/return.
  - `simulator.js`: generate equivalent demo events.
- Keep orchestration visible in server actions: validate input → authorize actor → call provider → record event/RPC → refresh page.
- Add comments where they explain “why” or how services connect, for example:
  - Why webhook verification must use the untouched raw request body.
  - Why an external provider event is stored before applying it to the ledger.
  - Why available balance is queried rather than saved.
  - Why a settlement can be parked before its authorization arrives.
  - Why provider errors must not fall back to fake success.
- Do not comment obvious JavaScript syntax. Add a short header comment to each provider file explaining its end-to-end flow.
- Add a README “code tour” tracing one card authorization and one ACH payment from UI action through provider, webhook, and ledger function.

## Application and UI

- Create `/login`, customer pages under `/app`, and isolated internal pages under `/ops`.
- Store the selected demo identity in a signed, HTTP-only cookie. Repeat authorization checks in every data query and mutation:
  - Sarah: company balances, all cards/activity, bank linking, payments, approvals.
  - John: his card/activity and payment initiation only.
  - Ops: reconciliation, statements, provider events, and demo controls only.
- Use the screenshot’s warm style: off-white background, `#ff5a00` orange, pale peach active states, dark text, thin borders, rounded panels, subtle shadows, left navigation, and compact header.
- Use a code-native dog icon and system fonts. Remove Google-hosted fonts so offline builds work.
- Include loading, empty, error, provider-delay, and edge states with plain-language explanations.

## Data and Financial Behavior

- Continue using the existing SQL functions as the only way to mutate financial state. Never update or delete ledger, hold, settlement, payment, or approval records.
- Add one readable, additive Supabase migration containing:
  - Server-only storage for Plaid sandbox connection tokens.
  - An atomic reconciliation function.
  - A current reconciliation-break projection with first-seen aging.
  - Simple approval and activity read views.
- Add an idempotent `scripts/seed.mjs` for Acme Inc., Sarah, John, Ops, ledger accounts, beneficiaries, approval threshold, initial funding, cards, believable activity, maker-checker, standing orders, provider events, and reconciliation examples.
- Convert entered dollars to integer cents in one small helper. Reject floats with more than two decimal places, non-USD values, and non-positive amounts.
- Maker-checker rules:
  - Above-threshold payments enter `PENDING_APPROVAL`.
  - John and Ops cannot approve payments.
  - Sarah cannot approve a payment she initiated.
  - Rejections require a reason.
  - Approval atomically checks and reserves available funds.
  - Provider failure leaves the payment visibly approved and retryable.
- Standing orders are part of the core loop:
  - Support weekly/monthly schedules, a first execution date, and an optional end date.
  - Use a deterministic occurrence key so each scheduled date fires once across restarts.
  - On insufficient available funds, post no journal and show an NSF alert.
  - Schedule exactly one retry for 24 hours later; a second NSF appends failure and pauses the order.
  - Above-threshold occurrences use the same maker-checker flow.
- Statements use value date for the financial day and booking time for `knowledge_cutoff`. Reversals append a new journal entry using the original settlement value date.

## Provider Connections

- Configure each provider independently with `sandbox` or `simulated`. Never switch modes automatically after an error.
- Persona creates a sandbox inquiry; signed webhook events advance KYB and open the account. [Persona webhook guidance](https://docs.withpersona.com/quickstart-webhooks)
- Plaid creates a Link token, exchanges the public token, retrieves Auth details, and saves only masked account data outside the server-only token store. [Plaid Link flow](https://plaid.com/docs/quickstart/) and [webhook verification](https://plaid.com/docs/api/webhooks/webhook-verification/)
- Increase receives the Plaid-derived sandbox routing/account details, creates an external account, and submits ACH transfers after internal approval. Signed events update submission, settlement, failure, and return states. [Increase ACH sandbox](https://www.increase.com/documentation/api/ach-transfers) and [webhook verification](https://www.increase.com/documentation/webhooks)
- Lithic creates virtual cards. Signed `card_transaction.updated` events call the existing hold/settlement SQL functions. Its sandbox simulator supports the `$50.00` authorization, `$73.40` clearing, force post, and return. [Lithic transaction simulation](https://docs.lithic.com/docs/simulating-transactions) and [webhooks](https://docs.lithic.com/docs/events-api)
- Simulator events pass through the same provider inbox and ledger functions as real webhooks; they are always visibly labeled `SIMULATED`.
- Webhook routes:
  - `POST /api/webhooks/lithic`
  - `POST /api/webhooks/persona`
  - `POST /api/webhooks/plaid`
  - `POST /api/webhooks/increase`
- Store the verified provider event first, use its external ID for idempotency, then apply the domain event. Log success or failure as a processing attempt.

## Demo Experiences

- Sarah’s overview shows ledger balance, available balance, holds/reservations, recent activity, cards, linked banks, and pending approvals.
- John sees his masked card details, his own card activity, and a payment form.
- The owner approval screen supports approve or reject-with-reason and clearly explains self-approval failures.
- Ops receives:
  - Reconciliation CSV upload and all three break categories.
  - Statement viewer with date range and `knowledge_cutoff`.
  - Provider event log with delivery/processing status.
  - Demo Lab controls for authorization, over-capture, reversal, settlement-before-auth, force post, duplicate webhook, ACH return, and provider delay.
- Real Lithic events demonstrate the live card integration. Clearly labeled simulated, backdated events demonstrate the multi-day and bitemporal cases honestly.

## Environment and Documentation

- Add `.env.example` containing no secrets:
  - Supabase URL, service-role key, and demo-session secret.
  - Explicit mode, credentials, and webhook secret for each provider.
  - Persona template ID, Plaid sandbox configuration, and Increase account ID.
- Default every provider to `sandbox`. Each may be set to `simulated` independently. Missing sandbox credentials produce an understandable configuration error, never an automatic fake fallback.
- Update the README with setup, migration, seed, role credentials, provider modes, demo walkthrough, and code tour.
- Keep the decision log timestamped as choices are implemented.
- Record USDC, MCP, native mobile, and a general public API in the deferred cut list. Standing orders are included in the core loop.
- Do not deploy the application.

## Test Plan

- Role tests cover cookie tampering, page isolation, server-action permissions, and scoped Sarah/John data.
- Ledger scenario verifies:
  - Funding raises ledger and available balances equally.
  - `$50.00` authorization lowers only available balance.
  - `$73.40` capture posts once and releases the hold once.
  - Duplicate delivery changes nothing.
  - Thursday’s reversal corrects Tuesday while a Wednesday cutoff preserves the earlier view.
  - Settlement-before-auth parks and later matches without creating a stale hold.
- Payment tests cover threshold boundaries, John-to-Sarah approval, required rejection reasons, self-approval denial, insufficient funds, reservation behavior, settlement, and ACH returns.
- Reconciliation tests cover all three break types, duplicate files, aging, malformed rows, and upload limits.
- Webhook tests cover valid/invalid signatures, stale timestamps, duplicate IDs, processing failures, and out-of-order events.
- Browser tests cover login and the primary Sarah, John, and Ops journeys.
- Run lint, tests, and the production build. Code comments and names are included in review: each important flow must be understandable without tracing through a generic abstraction layer.

## Assumptions

- The existing Supabase schema is already applied; the user will copy `.env.example` to `.env`, add credentials, and apply the additive migration and seed.
- Only sandbox/test identities and money are used. Full card numbers, CVCs, real PII, and live credentials are never stored.
- The dropdown is intentionally demo authentication, not production authentication.
- Small amounts of repetition are acceptable when they make provider flows easier to read and explain.
- Standing orders follow the insufficient-funds and one-retry policy in `DECISION_LOG.md`.
- Sandbox is the default and primary mode; simulation must be selected explicitly per provider.
