# Corgi neobank core loop

Corgi is a US business-banking sandbox demo. Sarah and John share a customer portal; Maya uses a separate Ops console. The login dropdown is intentionally simple demo authentication, but its cookie is signed and every page/action repeats its role check.

No deployment is included.

## Local setup

1. Copy `.env.example` to `.env` and replace every placeholder needed by the providers you use.
2. Apply `supabase-schema.sql` to a new Supabase project.
3. Apply `supabase-additive-migration.sql` after the main schema.
4. Run `npm run seed`. It is append-only and safe to repeat.
5. Run `npm run dev`, then open `http://localhost:3000/login`.
6. Run `npm run mcp:smoke` to verify the agent surface advertises its six tools.

After signing in, open `/core-loop`. It is the canonical seven-step journey and
only marks a provider step complete when its real sandbox record exists; seeded
simulator fixtures are deliberately ignored.

The seed prints actor IDs, the business account ID, balances, and useful demo URLs. It creates Acme Inc., cards, initial funding, a pending approval, card history, a current hold, standing orders, an NSF retry, provider evidence, and all three reconciliation cases.

Use these dropdown identities:

| Login | Role | Access |
| --- | --- | --- |
| `sarah@acme.com` | Owner | Full Acme portal and approvals |
| `john@acme.com` | Maker | His card/activity, payments, and standing orders |
| `admin@corgi.com` | Ops | Reconciliation, statements, provider log, Demo Lab |

## Provider configuration

All four providers default to `sandbox`. Missing sandbox credentials produce a clear setup error; code never turns an API failure into simulated success. To simulate only one service, set its mode to `simulated`, for example `STRIPE_MODE=simulated`.

`.env.example` documents:

- Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Demo security: `DEMO_SESSION_SECRET`, `CRON_SECRET`, `NEXT_PUBLIC_APP_URL`
- Persona: mode, API key, template ID, webhook secret
- Plaid: mode, client ID, sandbox secret, environment
- Stripe Issuing: mode, test secret key, webhook secret, and optional v2 Financial Account ID
- Increase: mode, sandbox API key/base URL/account ID/webhook secret

Only use sandbox identities and money. Do not enter real PII, PANs, or CVCs. The Plaid access token is written through a server-only SQL function into the private schema. Customer-visible rows retain masked details and opaque provider IDs.

### Stripe Issuing local setup

The application uses Stripe Issuing. Stripe currently provisions some sandboxes with a standalone Issuing balance and others with a v2 Financial Account; the adapter detects the model and keeps either provider balance separate from Corgi's ledger.

1. Create or select a Stripe sandbox and finish Card issuing activation. If its v2 Financial Account is still `pending`, Stripe will reject card creation until it becomes `open`.
2. Add test USD funds to the Card issuing funding source. Card authorization requires at least $73.40 so the demo can over-capture a $50.00 hold.
3. Set `STRIPE_MODE=sandbox` and put that sandbox's `sk_test_...` key in `STRIPE_SECRET_KEY`.
   Optionally set `STRIPE_FINANCIAL_ACCOUNT_ID`; otherwise Corgi discovers the first open v2 Financial Account when no standalone Issuing balance exists.
4. Forward Stripe sandbox events to `http://localhost:3000/api/webhooks/stripe` and put the resulting `whsec_...` value in `STRIPE_WEBHOOK_SECRET`.
5. Restart the app, sign in as Sarah, and issue a virtual card from `/app/cards`.
6. Sign in as Maya and use the direct `/core-loop` runbook to authorize $50.00, capture $73.40, and refund the capture.

The customer balance remains derived from Supabase journal entries. Stripe's Issuing or Financial Account balance is provider-side test liquidity only.

## MCP agent surface

`npm run mcp` starts the local stdio MCP server configured in `.codex/config.toml`. It exposes five read tools and one constrained write tool:

- `get_account_position`
- `list_beneficiaries`
- `list_payment_approval_queue`
- `list_provider_event_status`
- `list_reconciliation_breaks`
- `create_outbound_payment_request`

The write runs as an `AGENT` actor. The database therefore forces every amount into `PENDING_APPROVAL`, even below the normal threshold. It creates a request only: it cannot reserve funds, submit to Increase, or move money until a different human approves it.

See `MCP.md` for the autonomy boundary and a sample call.

Configure provider dashboards to call:

```text
POST /api/webhooks/stripe
POST /api/webhooks/persona
POST /api/webhooks/plaid
POST /api/webhooks/increase
```

The scheduler calls `POST /api/cron/standing-orders` with `Authorization: Bearer <CRON_SECRET>`. Locally, Ops can use **Run due standing orders** and **Run NSF retry** in Demo Lab.

## Code tour

The code deliberately keeps orchestration visible and uses the SQL functions as the financial command boundary.

### Card authorization and settlement

1. Stripe sends an Issuing event to `src/app/api/webhooks/stripe/route.js`.
2. The route verifies the signature against the untouched request body.
3. `src/lib/provider-events.js` persists the verified delivery before processing, so failures remain visible and the external event ID deduplicates replays.
4. A retryable failure returns an error to the provider. Re-delivery processes the stored payload again and appends another attempt; successful events become no-op replays.
5. An authorization calls `record_authorization_event`, creating a computed hold. A capture calls `record_card_settlement`, which posts the journal and releases the hold once.
6. A settlement that precedes authorization is parked by the SQL function. A later authorization matches it without leaving a stale hold. A force post is explicitly marked and posts without a hold.

### Outbound ACH and maker-checker

1. `src/app/app/payments/page.js` submits to `createPaymentAction` in `src/app/actions.js`.
2. The action validates dollars into integer cents, checks the signed customer identity, then calls `create_payment_request`.
3. The database snapshots the approval threshold. Above-threshold or agent-created requests wait for a different human; an approval reserves available funds before provider submission.
4. `src/lib/payments.js` sends the approved transfer through `src/lib/providers/increase.js`, then records `SUBMITTED` with `record_payment_event`.
5. The Increase webhook appends settlement/return events. A failed sandbox call remains visibly approved and retryable; it is never reported as simulated success.

### Bank funding

1. Plaid Link exchanges its short-lived public token on the server and retrieves Auth details.
2. Increase tokenizes those routing/account details as an external account.
3. The owner funding form creates a negative Increase ACH transfer (a pull from the linked bank), while Corgi records a positive inbound amount. Seeded simulated banks are excluded from this real sandbox form.
4. The Linked banks page exposes pending sandbox pulls so the owner can settle them through Increase's simulation API. Increase keeps the transfer status as `submitted`, so Corgi detects settlement from `settlement.settled_at` and posts the signed provider result exactly once.
5. A later funding recall reverses the immutable entry, restricts the account, and freezes its cards.

### Standing orders

1. `src/lib/standing-orders.js` finds weekly/monthly orders due today.
2. `create_standing_order_occurrence` uses `order ID + date` as a deterministic key, so restarts cannot fire a date twice.
3. Available balance is calculated from settled ledger balance minus live card holds and payment reservations; it is not stored.
4. NSF creates no journal. Exactly one retry is scheduled at least 24 hours later. A second NSF appends `FAILED` and pauses the order.
5. A funded occurrence creates a normal payment request, so an above-threshold occurrence still enters maker-checker.

## Reconciliation and bitemporal statements

Ops can upload the sample at `public/sample-scheme-file.csv`. The additive migration processes a file atomically and projects `IN_FILE_NOT_LEDGER`, `IN_LEDGER_NOT_FILE`, and `AMOUNT_MISMATCH` with first-seen aging. Duplicate file hashes return the original run.

Statements use `value_date` for the corrected financial day and `booked_at` for the `knowledge_cutoff`. Moving the cutoff backward shows what the system knew before a later reversal arrived.

## Verification

```bash
npm test
npm run lint
npm run build
```

With the local server running, `npm run smoke` verifies that all 13 authenticated customer and Ops pages finish rendering seeded data.

Database/provider integration tests require an applied Supabase schema and sandbox credentials. The Ops Demo Lab covers authorization, `$73.40` over-capture, reversal, settlement-before-auth, force post, duplicate webhook, ACH return, provider delay, standing-order execution, and NSF retry.
