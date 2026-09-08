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

## [T+4h] OUT OF ORDER:
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

## [T+4h] ACH Returns and Bounced Deposits:
- Post the reversal entry immediately (immutable ledger, new entry)
- Account goes negative
- Freeze the account from further spending
- Notify the customer
- The customer sees: A negative balance, a clear "ACH Return - R01 Insufficient Funds" entry, and a frozen card.

## [T+4h] FORCE POSTS:
- A merchant bypasses authorization entirely and submits a settlement directly. - Happens with:
    1. Offline card terminals (on planes, some transit systems)
    2. Certain fuel pumps
    3. Toll systems
- How to handle: 
    - Look for matching auth → not found
    - Not found? don't crash, post directly to ledger as `FORCE_POST` type
    - No hold to release (there wasn't one)
