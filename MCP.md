# Corgi MCP surface

The MCP server is a local stdio process backed by Corgi's server-only Supabase credentials. Start it with:

```bash
npm run mcp
```

The project-level `.codex/config.toml` also registers it as `corgi`. `npm run mcp:smoke` performs a protocol handshake and checks that all six tools are advertised.

## Human approval boundary

The sole write tool, `create_outbound_payment_request`, uses a fixed database actor whose kind is `AGENT`. `create_payment_request` enforces `requires_approval = true` for that actor in the database, regardless of amount. The response must be `PENDING_APPROVAL` or the MCP tool reports a safety failure. A different human must use the customer approval queue before any reservation or provider submission can occur.

Example arguments:

```json
{
  "beneficiary_id": "10000000-0000-4000-8000-000000000040",
  "amount_cents": 12500,
  "requested_execution_date": "2026-09-10",
  "memo": "Vendor invoice proposed by agent",
  "idempotency_key": "vendor-invoice-2026-09-10"
}
```

All amounts are integer USD cents. The caller must reuse the same idempotency key when retrying the same request.

## Operations never delegated to an autonomous agent

- Approve or reject a payment: separation of duties requires accountable human judgment, and an agent can never approve its own proposal.
- Submit a payment to Increase: this is the point at which an external money instruction is created.
- Post, reverse, delete, or edit ledger entries: only narrowly scoped, idempotent database commands may append financial events; corrections require human intent and an audit trail.
- Issue, unfreeze, or cancel a card: these actions change a regulated payment instrument and can immediately expose funds.
- Resolve reconciliation breaks: resolution can hide a real provider-versus-ledger discrepancy and needs evidence plus an accountable operator.
- Reveal PAN, CVC, bank credentials, access tokens, or provider secrets: the agent surface returns only masked operational data.
- Change KYB status or account restrictions: these are compliance decisions, not workflow automation.

The agent may read balances, beneficiaries, queues, delivery outcomes, and reconciliation breaks. It may propose a payment by creating an approval-queued request; it may not cause money movement autonomously.
