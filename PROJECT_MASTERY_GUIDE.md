# Corgi project mastery guide

This guide is the interview map for the repository as it exists on 10 September
2026. It separates proven behavior, live-provider evidence, simulator behavior,
and known v0 limitations. Do not claim a provider is live unless its sandbox API
call and signed webhook are visible in that provider's dashboard and in Corgi's
Ops event inbox.

## 1. The thirty-second explanation

Corgi is a USD business-current-account core. Next.js renders three demo roles and
orchestrates provider calls. Plaid links a bank, Increase moves ACH sandbox money,
Lithic issues cards and emits card-network events, and Persona sits behind a KYB
adapter but is currently simulated because access is sales-gated. Supabase
Postgres owns financial truth.

Provider facts first enter an immutable, signature-verified inbox. Application
code translates them into narrowly scoped Postgres RPCs. Those RPCs append domain
events and balanced journal entries inside transactions. Customer balances are
derived from journal postings; available balance is ledger balance minus active
card holds and approved-payment reservations. Nothing stores an editable balance.

The most important architectural sentence is:

> Providers report external facts; Postgres validates and records financial truth;
> views derive the customer and Ops projections.

## 2. What is proven right now

Automated verification currently passes:

- `npm test`: 14 unit tests.
- `npm run test:domain`: disposable PostgreSQL domain gauntlet, with rollback.
- `npm run lint`: no lint errors.
- `npm run build`: production build succeeds.
- `npm run smoke`: all 13 authenticated customer and Ops pages return 200 and
  contain the expected rendered content.

The hosted database was read after the hardening migration and currently shows:

- Ledger balance: 26,997,801 cents ($269,978.01).
- Card holds: 10,000 cents ($100.00).
- Payment reservations: 250,000 cents ($2,500.00).
- Available: 26,737,801 cents ($267,378.01), exactly ledger minus holds minus
  reservations.
- All three planted reconciliation breaks are visible.
- Recent signed provider inbox evidence is from Increase sandbox.
- The current card settlements are simulator records; there was no hosted Lithic
  authorization, settlement, or webhook evidence in the latest read.

This means the accounting core is proven, the Ops pages render, and Increase has
hosted webhook evidence. A live Lithic sandbox run and captured webhook evidence
are still required before claiming the issuing integration is demonstrated live.

## 3. The 80/20 repository map

Read these files in this order. They explain most of the project:

1. `track3-neobank.md`: the problem and hostile domain cases.
2. `README.md`: setup, provider labels, and the intended flow.
3. `src/app/actions.js`: UI orchestration and guided demo actions.
4. `src/lib/data.js`: how database projections become page data.
5. `src/lib/lithic-events.js`: provider snapshot to deterministic commands.
6. `src/app/api/webhooks/lithic/route.js`: signed webhook processing.
7. `src/lib/payments.js`: approval-to-Increase submission boundary.
8. `src/lib/increase-events.js`: Increase state to payment events.
9. `supabase-schema.sql`, functions `account_balance_as_of` and
   `statement_lines`: balances and statements.
10. `supabase-schema.sql`, functions `post_journal_entry` and
    `reverse_journal_entry`: journals and reversals.
11. `supabase-schema.sql`, the card command section: holds, settlements, and
    returns.
12. `supabase-schema.sql`, the payment command section: maker-checker and ACH
    lifecycle.
13. `supabase-schema.sql`, function `run_scheme_reconciliation`: reconciliation.
14. `supabase-domain-gauntlet.sql`: executable proof of the hard cases.

Everything else supports those files:

```text
src/
  app/
    actions.js                    server-side UI commands/orchestration
    app/                          Sarah/John customer portal
    ops/                          Maya operations portal
    core-loop/page.js             seven-step interview runbook
    api/
      webhooks/                   Persona, Plaid, Lithic, Increase consumers
      plaid/                      Link-token and public-token exchange
      cron/standing-orders/       secret-protected scheduler endpoint
  components/                     shared UI and client-side form behavior
  lib/
    data.js                       read models for pages
    supabase.js                   server-only PostgREST/RPC client
    session.js                    signed demo-session authorization
    money.js                      integer-cent parsing and formatting
    provider-events.js            durable webhook inbox/retry policy
    lithic-events.js              Lithic event classifier
    increase-events.js            Increase transfer classifier/orchestrator
    standing-orders.js            schedule and one-retry NSF worker
    providers/                    sandbox/simulator adapters
mcp/server.mjs                    five read tools and one queued write tool
supabase-schema.sql               schema, invariants, financial RPCs, grants
tests/core.test.mjs               pure JavaScript behavior tests
supabase-domain-gauntlet.sql      rollback-only accounting attack suite
scripts/domain-gauntlet.mjs       disposable PostgreSQL runner
scripts/seed.mjs                  repeatable demo workspace
scripts/smoke.mjs                 authenticated route render checks
```

## 4. The four layers

### Layer 1: pages and forms

Pages are server components. Customer and Ops layouts call `requireCustomer()` or
`requireOps()` before rendering. `ActionForm` is the small client boundary: it uses
React's `useActionState`, disables a pending submit, and displays the server
action's success or error.

### Layer 2: server orchestration

`src/app/actions.js` authenticates the actor, validates form input, calls provider
adapters and Postgres RPCs, then revalidates the affected pages. It must not invent
financial truth. For example, a failed Increase API call remains failed; it never
falls back silently to simulated success.

### Layer 3: provider adapters and webhooks

Files in `src/lib/providers/` hide provider-specific HTTP/SDK details. Webhook
routes verify the untouched raw body, store the verified delivery, process it,
and append an attempt outcome. A retry after a retryable failure processes the
stored event again; a retry after success is a no-op.

### Layer 4: Postgres command boundary

Security-definer RPCs validate state, take row locks where needed, apply
idempotency, append events, and post journals atomically. Tables are append-only;
views such as `business_account_balances` and `latest_reconciliation_breaks` are
rebuildable projections.

## 5. The ledger model

There are three different concepts. Never blur them in an interview:

- A **journal entry** is one business event: funding settled, card settled, ACH
  returned, or settlement reversed.
- A **journal posting** is one debit or credit line belonging to that entry.
- A **ledger account** is a bucket whose balance is the signed sum of postings.

`post_journal_entry` enforces at least two valid positive-cent lines and equal
total debits and credits. It calculates an idempotency fingerprint. Reusing a
posting key with identical content returns the first journal; reusing it with
different content throws.

For the customer deposit account, a credit increases the displayed balance and a
debit decreases it:

| Event | Debit | Credit | Customer effect |
| --- | --- | --- | --- |
| Inbound ACH settlement | ACH clearing | Customer deposit | Balance increases |
| Outbound ACH settlement | Customer deposit | ACH clearing | Balance decreases |
| Card settlement | Customer deposit | Card-network payable | Balance decreases |
| Reversal | Exact opposite of original | Exact opposite of original | Original effect undone |

The journal tables have update/delete rejection triggers. Corrections are new
equal-and-opposite entries linked by `reversal_of_entry_id`; history is never
rewritten.

## 6. Ledger balance versus available balance

The formula is:

```text
ledger balance
- sum(active card hold deltas)
- sum(active payment reservation deltas)
= available balance
```

Pending incoming ACH appears separately and is not spendable. This is the chosen
uncleared-credit policy.

The proof is in `business_account_balances`, not a `balance_cents` column on
`business_accounts`. `account_balance_as_of` derives ledger balance from postings
with two filters:

- `value_date <= requested financial date`
- `booked_at <= requested knowledge cutoff`

Example starting from $1,000:

| Action | Ledger | Hold | Reservation | Available |
| --- | ---: | ---: | ---: | ---: |
| Starting position | $1,000.00 | $0 | $0 | $1,000.00 |
| $50 card authorization | $1,000.00 | $50.00 | $0 | $950.00 |
| Final capture for $73.40 | $926.60 | $0 | $0 | $926.60 |
| Approve a $100 ACH | $926.60 | $0 | $100.00 | $826.60 |
| ACH settles | $826.60 | $0 | $0 | $826.60 |
| Card settlement reverses | $900.00 | $0 | $0 | $900.00 |

The authorization never touches the ledger. Settlement moves actual money. This
is why the final amount may differ from the authorized amount without corrupting
the balance.

## 7. Card money flow under hostile sequencing

### Normal authorization

1. Lithic sends a transaction snapshot.
2. `lithicTransactionCommands` sorts all embedded events deterministically.
3. `AUTHORIZATION` becomes `AUTHORIZED` or `DECLINED`.
4. `record_authorization_event` creates/fetches the authorization, locks it, and
   appends the authorization event.
5. Desired hold is `authorized total - already posted capture total`.
6. A positive delta is appended to `card_hold_events`.
7. Ledger is unchanged; available balance falls.

### Incremental authorization

`AUTHORIZATION_ADVICE` becomes `INCREMENTED`. The input is a new total, not a
second independent hold. The database rejects a lower incremental total. If the
total rises from $50 to $75, it appends only a +$25 hold delta.

### Partial and multiple capture

Every clearing becomes its own settlement and journal. A non-final capture
releases `min(active hold, captured amount)`. A final capture releases the entire
remaining hold and marks the hold lifecycle terminal.

For a $75 hold captured as $30 + $20 + $25:

- after $30: hold is $45;
- after $20: hold is $25;
- after final $25: hold is $0 and terminal;
- three journals post exactly $75 in total.

Lithic's remaining hold tells the classifier whether the latest clearing is
terminal. Earlier clearing events in a replayed snapshot stay non-final.

### Over-capture

A $50 auth may settle for $73.40. The final capture posts the full $73.40 journal
and releases only the $50 that actually exists. It does not create a negative
hold. Available therefore moves from `ledger - $50` to `new ledger - $0`.

### Reversal and expiry before settlement

`AUTHORIZATION_REVERSAL` and `AUTHORIZATION_EXPIRY` append one terminal negative
delta equal to the remaining hold. Replayed terminal events cannot release twice.

### Settlement before authorization

`record_card_settlement` stores the settlement and marks it `UNMATCHED`; it posts
nothing. When the authorization later arrives, `record_authorization_event` finds
parked settlements by the provider authorization ID, posts them in order, and
marks the hold terminal before calculating a new hold. The result is one journal
and no stale hold.

### Force post

`FINANCIAL_AUTHORIZATION` is classified as an explicit force post. It has no
invented authorization ID, posts directly to the journal, and releases no hold.
Force posts can make available balance negative because they represent an
external fact that already occurred.

### Duplicate delivery

There are three defenses:

1. Provider inbox unique key: provider + account + environment + external event.
2. Domain-event idempotency keys based on provider event tokens.
3. Journal posting keys and one posting link per settlement.

A duplicate may be processed again after a retryable failure, but it cannot post
the same financial event twice.

### Card return

The webhook path requires an exact related clearing or transaction reference. If
an authorization has multiple captures, an authorization-level reference is
ambiguous and processing stays retryable. It never guesses “the latest settlement
on this card.” A valid return appends an equal-and-opposite journal.

## 8. Bitemporality

Two clocks answer two different questions:

- `value_date`: when the economic event belongs.
- `booked_at`: when Corgi learned and recorded it.

Suppose Tuesday's $73.40 settlement is learned Tuesday and reversed Thursday:

- original journal: value date Tuesday, booked Tuesday;
- reversal journal: value date Tuesday, booked Thursday.

A statement for Tuesday with a Wednesday knowledge cutoff shows the debit because
Corgi did not know about the reversal yet. The same Tuesday statement with a
Friday cutoff includes both rows and nets to zero. This preserves historical
knowledge while showing the corrected economic day.

`reverse_card_settlement` now enforces that the reversal value date equals the
original settlement value date. Callers cannot accidentally move the correction
to Thursday.

## 9. Outbound ACH and maker-checker

1. John submits the payment form.
2. `dollarsToCents` rejects floats, negatives, zero, or more than two decimals.
3. `create_payment_request` verifies the account is KYB-approved and transactable,
   the actor is an active member, and the beneficiary belongs to the organization.
4. It snapshots the current approval threshold. Later threshold changes cannot
   rewrite the decision for this request.
5. Amounts strictly greater than the threshold require approval. Every AGENT
   request requires approval regardless of amount.
6. Sarah approves. The database rejects self-approval, non-human approval, a role
   outside Owner/Admin/Approver, and a second decision.
7. Approval rechecks available balance under an account row lock and creates a
   reservation.
8. Only after approval does `submitPaymentRequest` call Increase.
9. On settlement, the outbound journal debits the customer and the reservation is
   consumed. On failure/cancellation, the reservation is released.
10. If the provider API fails after approval, the request stays visibly APPROVED
    and reserved. Sarah can retry submission; no fake success is recorded.

The MCP write tool uses a fixed actor of kind `AGENT`. It can create only a queued
request. It cannot approve, submit, post journals, reveal secrets, issue cards, or
resolve breaks.

## 10. Bank linking and inbound funding

1. Sarah asks `/api/plaid/link-token` for a Link token.
2. Plaid Link returns a short-lived public token to the browser.
3. `/api/plaid/exchange` exchanges it server-side, retrieves ACH Auth details, and
   asks Increase to tokenize those details as an External Account.
4. The long-lived Plaid token is stored only in the private schema. Public tables
   keep masked metadata and opaque provider IDs.
5. Funding creates a negative Increase ACH amount because it is a pull from the
   linked bank; Corgi represents the customer-facing payment as positive inbound
   cents.
6. `SUBMITTED` is non-financial and appears as pending incoming money.
7. When Increase exposes `settlement.settled_at`, `record_payment_event(SETTLED)`
   credits the customer deposit ledger exactly once.
8. An inbound return becomes `RECALLED`, appends a reversal, and may restrict the
   account/freeze cards according to the current v0 handling.

## 11. Persona/KYB: exactly what is simulated

The abstraction exists:

- `startPersonaInquiry` has sandbox and simulated implementations.
- `/api/webhooks/persona` verifies Persona HMAC, maps Persona states to Corgi KYB
  events, stores the provider delivery, and opens the account only on APPROVED.
- Postgres blocks payment creation and card issuance unless current KYB is
  APPROVED and the account is open/unrestricted.

However, the configured trial decision is **simulated Persona**. The seed creates a
simulator KYB case, an APPROVED event, and an open account so the domain flows can
run. The provider mode must be labeled SIMULATED.

Current presentation limitation: simulated `startPersonaInquiry` creates an
inquiry object but does not append its simulated approval event, and `/core-loop`
queries only `provider_code=persona` and intentionally refuses to turn that step
green in simulated mode. Therefore do not say the guided Persona step is live or
complete. Say:

> Persona KYB is sales-gated and explicitly simulated. The database gate and the
> signed real-webhook adapter are implemented, while the submitted evidence uses
> a seeded simulated approval. Plaid/Increase/Lithic are the intended live slots.

## 12. ACH returns and recalls

- Outbound ACH bounce: `RETURNED`; append the reverse of its settled journal.
- Inbound ACH clawback: `RECALLED`; append the reverse of its settled journal.
- An unsettled payment cannot be returned or recalled.
- Return reason is retained, including mapped ACH codes such as R01.
- Provider return state takes precedence over the presence of an old settlement
  timestamp.
- A negative position after recall triggers database account restriction and card
  freeze events. The Increase orchestration also conservatively restricts/freezes
  on any inbound recall.

## 13. Standing orders

- Weekly means the weekday of `starts_on`.
- Monthly means the day-of-month of `starts_on`.
- `(standing order ID, scheduled date)` is unique, preventing two occurrences for
  one date.
- Each occurrence has initial attempt 1 and at most retry attempt 2.
- NSF posts no journal and schedules one retry at least 24 hours later.
- A second NSF appends FAILED and PAUSED.
- A funded occurrence creates a normal payment request, so maker-checker still
  applies above the threshold.

## 14. Scheme reconciliation

The CSV contract is exactly:

```csv
processor_reference,amount_cents,value_date
```

The server limits files to 1 MB, validates positive integer cents and ISO dates,
hashes the body, and sends rows atomically to Postgres. The database validates
that every row's value date equals the run date.

The three break types are:

- `IN_FILE_NOT_LEDGER`: processor row exists, but no matching posted journal.
  A parked settlement belongs here; a settlement table row alone is not ledger
  truth.
- `IN_LEDGER_NOT_FILE`: a posted settlement exists for provider/date but the file
  omitted it.
- `AMOUNT_MISMATCH`: both exist but amounts differ.

Fingerprints include provider, settlement date, direction, and reference. Aging
uses first detection. The displayed projection uses only the latest run for each
provider/date, so a clean rerun removes a stale current break without deleting
history.

## 15. Webhook policy

Every real webhook follows this shape:

```text
read untouched body
-> verify signature and timestamp
-> reject 401 if invalid
-> insert immutable provider event
-> if already succeeded, return replay success
-> if new or retryable, translate/process
-> append SUCCEEDED or RETRYABLE_FAILURE attempt
-> return 2xx or 5xx
```

Persona and Increase HMAC timestamps have a five-minute tolerance. Plaid verifies
its ES256 JWT, issue time, and request-body hash. Lithic uses its SDK parser with
the untouched body and subscription secret.

`provider_events` rejects unverified inserts and rejects reuse of the same external
event ID with a different payload. Ops shows provider, environment, signature,
latest outcome, error, and retry count.

## 16. Security and authorization policies

- Browser roles have no direct table privileges or RLS policies.
- Only server-side code holds the Supabase service-role key.
- Customer and Ops layouts enforce separate portals.
- Owner-only actions recheck `requireOwner`; hidden form fields are not trusted.
- Database payment commands independently validate membership and roles.
- Demo identities use an HTTP-only, SameSite=Lax, signed cookie. Signature compare
  is timing-safe. Production requires a configured secret.
- This is demo authentication, not production identity/authentication.
- Raw bank numbers are used transiently server-side and tokenized into Increase.
- PAN is retrieved only to call Lithic's simulator and is not persisted by Corgi.
- Plaid access tokens live in a private schema behind service-only RPCs.
- No provider adapter silently switches to simulated mode when sandbox calls fail.

## 17. Complete policy and edge-case matrix

| Concern | Enforced behavior | Proof location |
| --- | --- | --- |
| Currency | USD only, integer cents, positive financial amounts | `money.js`; SQL checks |
| Ledger integrity | At least two lines; debits equal credits | `post_journal_entry` |
| Immutability | Update/delete rejected on financial/domain tables | `reject_mutation` triggers |
| Balance truth | Sum journal postings; never stored | `account_balance_as_of` |
| Available truth | Ledger minus active holds/reservations | `business_account_balances` |
| Pending credits | Visible but excluded from available | balance view |
| Webhook authenticity | Raw-body signature and freshness checks | webhook routes/signature libs |
| Webhook replay | Store once; retry failures; no-op after success | provider inbox + attempts |
| Changed replay payload | Rejected | `ingest_provider_event` |
| Authorization | Hold only; no journal | `record_authorization_event` |
| Increment | New total cannot decrease previous total | same RPC |
| Partial capture | Release captured part; keep remainder | `apply_card_settlement` |
| Final capture | Release all remaining hold once | same RPC |
| Over-capture | Post actual amount; hold bottoms at zero | same RPC |
| Auth reversal/expiry | Terminal release exactly once | authorization RPC |
| Settlement before auth | Park, later auto-match, no stale hold | settlement/auth RPCs |
| Force post | Post with no invented auth/hold | settlement RPC |
| Ambiguous card return | Retryable; do not guess | Lithic webhook route |
| Card correction date | Must equal original settlement value date | reversal RPC |
| Maker-checker | Above threshold requires second human | payment RPCs |
| Agent money request | Always requires approval | `create_payment_request` |
| Self approval | Rejected | `decide_payment_request` |
| Approval race | Balance rechecked under account lock | same RPC |
| Approved payment | Funds reserved before provider submission | reservation events |
| Provider submission failure | Remains approved/retryable; no fake success | actions/payments |
| ACH settlement | Journal once; reservation consumed | payment-event RPC |
| ACH failure/cancel | Reservation released | payment-event RPC |
| ACH return/recall | Reverse settled journal; unsettled return rejected | payment-event RPC |
| Negative recalled funding | Restrict account and freeze cards | payment-event/Increase code |
| Standing order duplicate | One occurrence per order/date | unique key + RPC |
| Standing order NSF | One 24-hour retry, then pause | worker + RPC |
| Reconciliation replay | Same provider/file hash returns same run | reconciliation RPC |
| Parked reconciliation | File-not-ledger until posting link exists | reconciliation RPC |
| Clean rerun | Latest provider/date projection hides stale break | latest-break view |
| Provider outage | Keep last verified ledger state and show degradation | Ops read model |

## 18. Known v0 limitations: say these before they discover them

These are not reasons to distrust the tested accounting core, but they are honest
cuts or follow-ups:

1. Persona is simulated, and the guided `/core-loop` cannot turn the Persona step
   green in simulated mode.
2. Hosted data currently lacks Lithic sandbox transaction/webhook evidence. Run one
   authorization/clearing and verify `/ops/events` before claiming it live.
3. The guided return action chooses the latest Lithic settlement. That is safe for
   its single-settlement scripted path, but a general UI should require the exact
   settlement selection. The webhook path itself already refuses ambiguity.
4. Payment return value dates are provider/caller supplied and are not constrained
   in Postgres as tightly as card reversal value dates. The current Increase helper
   prefers `settlement.settled_at`; a production return model should use the
   provider's actual return effective date.
5. The Increase handler conservatively freezes/restricts after every inbound recall,
   while the database's built-in restriction condition is negative available
   balance. This policy should be unified.
6. There is no real-time card authorization decision endpoint or card-control
   engine. Corgi records issuer-approved facts; it does not currently approve or
   decline Lithic authorizations itself.
7. A standing-order process crash after occurrence creation but before completion
   can strand that occurrence. Production needs a lease/outbox/recovery scan.
8. Monthly orders on days 29-31 skip shorter months; holidays, bank calendars,
   time zones, notifications, edit/cancel operations, and backfill are week-two
   work.
9. `statement_versions` exists, but immutable PDF/CSV artifact generation is cut.
   The bitemporal statement query is implemented and tested.
10. Reconciliation break acknowledge/resolve actions are modeled but not exposed
    in the UI.
11. Plaid webhooks are verified and audited, but the current Link flow performs the
    actual account setup synchronously; the Plaid webhook route has no richer
    domain transitions.
12. Demo auth, hard-coded Acme IDs, one currency, and one tenant flow are explicit
    work-trial cuts, not production architecture.
13. The unit tests cover pure classifiers/signatures; the SQL gauntlet covers core
    accounting. There is no automated end-to-end test against real provider
    sandboxes because that requires credentials and webhook infrastructure.

## 19. What to test manually before recording

Do not click randomly. Record a before/after table for every money action.

### A. Fast automated gate

```bash
npm test
npm run test:domain
npm run lint
npm run build
```

With the local app already running:

```bash
npm run smoke
npm run mcp:smoke
```

### B. Customer access

1. Log in as John. Confirm he sees only his cards/payment activity and cannot open
   the owner approval or linked-bank pages.
2. Log in as Sarah. Confirm she sees ledger, available, holds, reservations, banks,
   and approvals.
3. Log in as Maya. Confirm Ops pages load and customer pages redirect away.

### C. Derived balance proof

1. On Sarah's overview, write down ledger, available, holds, and reservations.
2. Check with a calculator: `ledger - holds - reservations = available`.
3. Explain that the four numbers come from one SQL view over events/journals.

### D. Card proof

Use a Lithic sandbox card if available; otherwise use Demo Lab and say SIMULATED.

1. Authorize $50. Expected: ledger unchanged, holds +$50, available -$50.
2. Clear $73.40. Expected: ledger -$73.40, hold -$50 to zero, available equals
   original available -$73.40. Repeating delivery must not change it again.
3. Reverse. Expected: original journal remains, opposite journal appears, current
   ledger returns +$73.40, and both rows have the original value date.
4. In Statements, choose a cutoff before the reversal booking time: see the debit.
   Choose a cutoff after it: see debit plus reversal, net zero for that purchase.
5. Demo Lab out-of-order: one parked settlement is later posted and no active hold
   remains.
6. Demo Lab duplicate: one provider inbox row and one journal posting.
7. Demo Lab force post: ledger decreases with no authorization/hold.
8. Demo Lab provider delay: Ops shows RETRYABLE_FAILURE and money does not move.

### E. Maker-checker proof

1. John creates a payment over $1,000 (the seeded 100,000-cent threshold).
2. Confirm it is PENDING_APPROVAL and no Increase transfer exists yet.
3. John cannot access owner approvals; the database also rejects initiator
   self-approval.
4. Sarah approves. Expected: reservation increases immediately; only then does
   Increase receive the transfer.
5. If Increase fails, show APPROVED/retryable state instead of fake success.

### F. Reconciliation proof

1. Open Ops reconciliation and show the seeded three breaks.
2. Explain each row using file truth versus a posted journal link.
3. Reconcile an exact row from the latest Lithic settlement. Expected: no current
   break for that reference.
4. Re-uploading identical content returns the same run.
5. A file row with a date different from the selected run date must fail atomically.

### G. Provider evidence

1. Open `/ops/events`.
2. Show SANDBOX, VERIFIED, external event ID, SUCCEEDED, and attempt count.
3. Cross-check at least one delivery in the provider dashboard.
4. Capture screenshots of the provider dashboard and Corgi row.
5. Do not use simulator rows as evidence of a live integration.

## 20. How to explain the important code line by line

### `src/lib/lithic-events.js`

- Lines 1-2 define the only provider event families the classifier understands.
- Lines 4-8 normalize signed provider amounts to positive customer-facing cents.
- Lines 10-23 read event amount and remaining hold from supported Lithic shapes.
- Lines 25-34 extract only explicit return correlations and remove duplicates.
- Lines 36-46 sort the snapshot by time/token and find its last clearing.
- Lines 48-62 map auth/advice to authorized, incremented, or declined commands.
- Lines 64-72 map terminal auth reversal/expiry commands.
- Lines 74-87 map every clearing independently; force post has no auth, and only a
  last clearing with zero remaining hold is final.
- Lines 90-97 emit return commands with exact references.
- Unknown provider events produce no financial command.

### `src/app/api/webhooks/lithic/route.js`

- Lines 7-11 bind the provider card token to one local card.
- Lines 13-47 resolve a return exactly and throw on missing/ambiguous correlation.
- Lines 49-98 replay deterministic commands into idempotent Postgres RPCs.
- Lines 100-110 read the raw body and verify Lithic's signature before parsing.
- Lines 112-126 establish an external ID, persist first, and skip successful replay.
- Lines 128-137 process supported events and append success/failure attempts.

### `post_journal_entry`

- Validate posting key, entry kind, value date, description, metadata, and at least
  two posting lines.
- Parse JSON lines and verify every account is a valid USD ledger account.
- Sum debits and credits; reject inequality.
- Verify any reversal target exists.
- Hash all journal content into an idempotency fingerprint.
- Insert the header by unique posting key.
- On replay, return the old ID only if the fingerprint matches.
- Insert ordered posting lines and return the journal ID.

### `record_authorization_event`

- Validate state and cents.
- Return safely on duplicate event key.
- Create/fetch the provider authorization and lock it.
- Reject a card mismatch or decreasing increment.
- Append the authorization event.
- If approved/incremented, first post any parked settlements.
- Compute captures already posted and current hold deltas.
- Append only the delta needed to reach `authorization total - captures`.
- On reversal/expiry, append one terminal release of the remaining hold.

### `apply_card_settlement`

- Lock the settlement and return an existing posting link on replay.
- Validate the authorization belongs to the same card and is not rematched.
- Reject a non-force-post settlement without a match.
- Resolve customer-deposit and card-payable ledger accounts.
- Post actual settlement cents as a balanced journal.
- Add the one POSTING link.
- Release part or all of the hold according to final-capture status.
- Append POSTED and return the journal.

### `create_payment_request` / `decide_payment_request`

- Validate amount/rail and idempotency content.
- Lock account, enforce KYB/account/member/beneficiary boundaries.
- Snapshot threshold; agents or over-threshold amounts require approval.
- Reserve immediately only for a request that does not require approval.
- On decision, lock the request, reject self/non-human/wrong-role/duplicate approval,
  recheck available balance, then append approval and reservation.

### `run_scheme_reconciliation`

- Require a JSON array and return an existing run for the same file hash.
- Insert run and all source rows in one transaction.
- Reject any row whose value date differs from the run date.
- Left-join file rows to settlements and POSTING links for missing/mismatch cases.
- Join posted settlements back to absent file rows for ledger-only cases.
- Use stable provider/date/reference fingerprints and return the run ID.

## 21. Five-minute video script

### 0:00-0:35 — architecture

“Next.js orchestrates three roles and four provider adapters. Verified provider
facts enter an immutable inbox. Postgres RPCs are the financial command boundary.
All customer money is derived from balanced, append-only journals.”

### 0:35-1:10 — balance truth

Show Sarah's four cards. Calculate ledger minus hold minus reservation. State that
pending inbound ACH is not spendable.

### 1:10-2:20 — card hostile sequence

Show $50 authorization then $73.40 capture. Narrate that auth changes only the
hold, settlement posts actual cents, and final capture releases the hold once.
Mention partial/multiple capture, overcapture, force post, and out-of-order tests.

### 2:20-3:05 — bitemporal correction

Reverse the settlement. Show the same value date and later booking time. Move the
statement knowledge cutoff before and after the reversal.

### 3:05-3:45 — maker-checker ACH

John creates an over-threshold request; Sarah approves. Show the reservation before
settlement and explain that agent-created requests always stop here too.

### 3:45-4:25 — reconciliation and provider failure

Show the three break types and aging. Show an Ops event with signature/outcome.
Run provider-delay and explain that Corgi retains last verified ledger truth.

### 4:25-5:00 — reality and cuts

State exactly which integrations have live evidence. Say Persona is simulated due
to gating. End with the known cuts: production auth/multitenancy, card controls,
standing-order calendars/recovery, and statement artifacts.

## 22. Interview answers worth memorizing

**Why isn't available balance stored?**  Because it is a projection of settled
journals and active reservations. Storing it separately creates two truths that
can drift after retries, late events, or corrections.

**Why are holds not journal entries?**  An authorization reserves spending power
but does not move settled money. It affects available balance, not ledger balance.

**How do you prevent a double release?**  Hold changes are idempotent deltas; a
terminal event is append-only and the active-hold projection excludes any
authorization with a terminal event.

**Why park settlement-before-auth?**  A non-force settlement claims an auth
relationship that has not arrived. Posting immediately would invent a match;
failing permanently would not tolerate provider ordering. Parking preserves the
fact until correlation arrives.

**Why does a force post work differently?**  The provider explicitly says money
moved without authorization. There is no hold or auth to invent, but the ledger
must still reflect the external fact.

**What makes this bitemporal?**  Every journal has economic time (`value_date`) and
knowledge time (`booked_at`). Queries filter both dimensions.

**How can history be corrected if it is immutable?**  Append the exact opposite
journal linked to the original. Never update or delete the old row.

**Where is maker-checker enforced?**  In Postgres, not only the UI: distinct human
actor, permitted role, threshold snapshot, approval event, and reservation.

**Why store a webhook before processing?**  If processing fails, the exact verified
payload remains visible and replayable. Otherwise an outage can erase the fact
that a provider delivery occurred.

**Why can a clean reconciliation rerun remove a break without deleting it?**  The
historical result remains append-only; the current projection selects the latest
run for the provider/date.

**What would you build next?**  First close evidence and recovery gaps: live Lithic
webhook proof, simulated Persona completion UX, standing-order leases/recovery,
provider-accurate ACH return effective dates, then production auth/multitenancy.
