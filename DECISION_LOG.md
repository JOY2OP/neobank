# [T+0h] TECH STACK
| Component                       | Use                                   |
| ------------------------------- | ------------------------------------- |
| **Frontend + API Routes**       | Next.js                               |
| **Database (Ledger)**           | Supabase (Postgres)                   |
| **Card Issuing**                | Stripe Issuing (Test Mode)            |
| **KYB / Business Verification** | Persona (Sandbox)                     |
| **Bank Linking**                | Plaid (Sandbox)                       |
| **ACH Transfers**               | Increase (Sandbox)                    |
| **Deployment**                  | Vercel (Free, Instant)                |
| **MCP Server**                  | Node.js + `@modelcontextprotocol/sdk` |


## [T+4h] CORE RULES
- Money is always integers in cents.
- Available balance is never stored (computed on the fly).
- Don't release a hold twice.
- Polling is a fallback, not the design.
- Reconciliation is a feature, not a chore

## [T+4h] Insufficent balance policy: 
- Fail the payment, notify the customer, retry in 24h (SHOULD BE VISIBLE TO USERS)

## [T+4h] POLICY- OUT OF ORDER:
- settlement arrives with no auth => PARK IT 
- When the auth webhook arrives later:
    1. Before creating the hold, check `unmatched_settlements` for this `auth_id`. 
    2. If found, skip the hold entirely and go straight to posting the ledger entry. 
    3. Mark the settlement as matched.

## [T+4h] Idempotency part 
- Stripe will replay webhooks. If a settlement webhook arrives twice, you must not post two ledger entries. Check if you've already processed this `event_id` before doing anything:

Table:
`processed_webhook_events`:
  `stripe_event_id`  -- primary key
  `processed_at`

- On every webhook: check this table first. If the event_id exists, return 200 and do nothing.

## [T+4h] POLICY- ACH Returns and Bounced Deposits:
- Post the reversal entry immediately (immutable ledger, new entry)
- Account goes negative
- Freeze the account from further spending
- Notify the customer
- The customer sees: A negative balance, a clear "ACH Return - R01 Insufficient Funds" entry, and a frozen card.

## [T+4h] POLICY- FORCE POSTS:
- A merchant bypasses authorization entirely and submits a settlement directly. - Happens with:
    1. Offline card terminals (on planes, some transit systems)
    2. Certain fuel pumps
    3. Toll systems
- How to handle: 
    - Look for matching auth → not found
    - Not found? don't crash, post directly to ledger as `FORCE_POST` type
    - No hold to release (there wasn't one)

## [T+8h] HOLD:
- This is the reserved money. Always compute - never store in DB.
- Terminal states can go from `ACTIVE` to:
    1. `RELEASED`
    2. `EXPIRED`
    3. `REVERSED`

## [T+20h] POLICY- STANDING ORDER:
- Scheduled payments must fire once and only once across restarts and retries.
- NSF (Insufficient Funds) Rule: If the available balance cannot cover the payment amount, do not overdraft and do not post the ledger entry
- Mark the execution status and surface an alert to the customer UI.
- Queue exactly one retry attempt for 24 hours later. If the retry fails, pause the standing order.
- REASON of 1 retry:
    1. Customer abandoning
    2. Providers monitor NSF(Non sufficient fund) rates


## [T+20h] FLOW:
- 3 personas:
    1. Business owner
    2. Employee
    3. Neobank admin

## [T+20h] POLICY- BITEMPORALITY:
- In case of settlement reversal - A correction that undoes a prior entry with new one
- There should be 2 dates for each transaction:
    1. Booking Date: When you learned about the transaction
    2. Value Date: When it happened

## [T+20h] POLICY- SCHEME RECONCILIATION
- Nightly file from the processor against your ledger
    1. in-file-not-ledger
    2. in-ledger-not-file
    3. amount mismatch

- Breaks screen with aging

## [T+20h] SANDBOX-FIRST CORE LOOP
- Persona, Plaid, Stripe Issuing, and Increase default to sandbox mode.
- A provider may be changed independently to `simulated`; sandbox errors are returned and never trigger simulated success.
- Standing orders remain in the core loop with one deterministic occurrence per date and exactly one NSF retry after 24 hours.
- The three dropdown identities are demo authentication; signed cookies and server-side role checks enforce portal isolation.

## [T+22h] SETTING UP
- setting up credentials for the services for both local and prod
- using ngrok for localhost webhook

## [T+24h] Persona KYB is sales gated, going with simulated env

## [T+25h] Stripe `treasury card` feature shows "We're setting up your account. We'll email you when it's ready" error. 
- Going with simulated with this one too.