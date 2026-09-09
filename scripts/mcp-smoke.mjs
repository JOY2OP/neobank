import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["mcp/server.mjs"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const messages = new Map();

function waitFor(id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for MCP response ${id}.`)), timeoutMs);
    messages.set(id, (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });
}

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const resolve = messages.get(message.id);
    if (resolve) {
      messages.delete(message.id);
      resolve(message);
    }
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

try {
  const initialized = waitFor(1);
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "corgi-smoke", version: "1.0.0" },
    },
  });
  const initResponse = await initialized;
  if (initResponse.error) throw new Error(initResponse.error.message);
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  const listed = waitFor(2);
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsResponse = await listed;
  const names = toolsResponse.result?.tools?.map((tool) => tool.name) || [];
  const expected = [
    "get_account_position",
    "list_beneficiaries",
    "list_payment_approval_queue",
    "list_provider_event_status",
    "list_reconciliation_breaks",
    "create_outbound_payment_request",
  ];
  for (const name of expected) {
    if (!names.includes(name)) throw new Error(`MCP tool missing: ${name}`);
  }
  console.log(`MCP smoke passed: ${names.length} tools advertised.`);
} finally {
  child.kill();
}
