import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

const IDS = {
  organization: "10000000-0000-4000-8000-000000000001",
  account: "10000000-0000-4000-8000-000000000002",
  agent: "10000000-0000-4000-8000-000000000014",
};

function configuration() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  return { url, key };
}

async function request(path, options = {}) {
  const { url, key } = configuration();
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Corgi data service ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

function selectRows(table, query = "") {
  return request(`${table}?${query}`);
}

function callRpc(name, parameters) {
  return request(`rpc/${name}`, { method: "POST", body: JSON.stringify(parameters) });
}

function result(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function safe(handler) {
  return async (input) => {
    try {
      return await handler(input);
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : "Corgi MCP tool failed." }],
      };
    }
  };
}

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export function createServer() {
  const server = new McpServer(
    { name: "corgi-neobank", version: "1.0.0" },
    {
      instructions: "Read Corgi state before proposing money movement. The only write tool creates an ACH payment request in the human approval queue. Agents cannot approve, submit, post ledger entries, or bypass maker-checker.",
    },
  );

  server.registerTool(
    "get_account_position",
    {
      title: "Get account position",
      description: "Read Corgi's derived USD ledger, holds, reservations, pending inbound funds, and available balance in integer cents.",
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    safe(async () => {
      const rows = await selectRows("business_account_balances", `business_account_id=eq.${IDS.account}`);
      if (!rows[0]) throw new Error("The demo business account has not been seeded.");
      return result({ currency: "USD", ...rows[0] });
    }),
  );

  server.registerTool(
    "list_beneficiaries",
    {
      title: "List beneficiaries",
      description: "List the masked ACH beneficiaries available to the demo organization.",
      inputSchema: z.object({}),
      annotations: readAnnotations,
    },
    safe(async () => {
      const rows = await selectRows(
        "beneficiaries",
        `select=id,display_name,bank_name,account_mask&organization_id=eq.${IDS.organization}&order=display_name.asc`,
      );
      return result({ beneficiaries: rows });
    }),
  );

  server.registerTool(
    "list_payment_approval_queue",
    {
      title: "List payment approval queue",
      description: "Read pending or approved outbound ACH requests without approving or submitting them.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(25) }),
      annotations: readAnnotations,
    },
    safe(async ({ limit }) => {
      const rows = await selectRows(
        "payment_request_status",
        `select=*&business_account_id=eq.${IDS.account}&status=in.(PENDING_APPROVAL,APPROVED)&order=created_at.desc&limit=${limit}`,
      );
      return result({ requests: rows });
    }),
  );

  server.registerTool(
    "list_provider_event_status",
    {
      title: "List provider event status",
      description: "Read verified provider deliveries with their latest processing outcome and retry count.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(25) }),
      annotations: readAnnotations,
    },
    safe(async ({ limit }) => {
      const [events, statuses] = await Promise.all([
        selectRows("provider_events", `select=id,provider_code,environment,external_event_id,event_type,provider_created_at,received_at,signature_verified&order=received_at.desc&limit=${limit}`),
        selectRows("current_provider_event_status", "select=*"),
      ]);
      const statusByEvent = new Map(statuses.map((item) => [item.provider_event_id, item]));
      return result({
        events: events.map((event) => {
          const processing = statusByEvent.get(event.id);
          return {
            ...event,
            processing_outcome: processing?.status || "RECEIVED",
            retry_count: Math.max(0, Number(processing?.attempt_number || 0) - 1),
            last_error: processing?.error_message || null,
          };
        }),
      });
    }),
  );

  server.registerTool(
    "list_reconciliation_breaks",
    {
      title: "List reconciliation breaks",
      description: "Read the latest unresolved provider-file versus Corgi-ledger differences.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).default(25) }),
      annotations: readAnnotations,
    },
    safe(async ({ limit }) => {
      const rows = await selectRows("latest_reconciliation_breaks", `select=*&order=age_days.desc&limit=${limit}`);
      return result({ breaks: rows });
    }),
  );

  server.registerTool(
    "create_outbound_payment_request",
    {
      title: "Create outbound payment request",
      description: "Create an ACH request as the AGENT principal. It always stops in PENDING_APPROVAL for a different human to review; it never sends money.",
      inputSchema: z.object({
        beneficiary_id: z.uuid().describe("ID returned by list_beneficiaries"),
        amount_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe("USD amount in integer cents"),
        requested_execution_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD"),
        memo: z.string().trim().min(1).max(240),
        idempotency_key: z.string().trim().min(8).max(200).describe("Stable unique key reused for retries of the same request"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    safe(async (input) => {
      const created = await callRpc("create_payment_request", {
        p_business_account_id: IDS.account,
        p_beneficiary_id: input.beneficiary_id,
        p_rail_code: "ACH",
        p_initiated_by_actor_id: IDS.agent,
        p_amount_cents: input.amount_cents,
        p_requested_execution_date: input.requested_execution_date,
        p_idempotency_key: `mcp:${input.idempotency_key}`,
        p_memo: input.memo,
      });
      const paymentRequest = Array.isArray(created) ? created[0] : created;
      if (!paymentRequest?.requires_approval || paymentRequest.request_state !== "PENDING_APPROVAL") {
        throw new Error("Safety invariant failed: an agent-created payment did not enter human approval.");
      }
      return result({
        ...paymentRequest,
        amount_cents: input.amount_cents,
        currency: "USD",
        message: "Request created. No money moved; a different human must approve it in Corgi.",
      });
    }),
  );

  return server;
}

void serveStdio(createServer);
console.error("Corgi MCP server listening on stdio");
