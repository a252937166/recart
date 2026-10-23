#!/usr/bin/env node
// Working MCP client for ReCart's remote server (Streamable HTTP), using the official TypeScript SDK.
//   npm install && node client.mjs                         # creates a sandbox merchant on https://recart.axiqo.xyz
//   RECART_API_KEY=rk_test_... node client.mjs              # use your own key
//   RECART_BASE_URL=http://127.0.0.1:4060 node client.mjs   # local server
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = (process.env.RECART_BASE_URL ?? "https://recart.axiqo.xyz").replace(/\/$/, "");
let key = process.env.RECART_API_KEY;
let order = null;
if (!key) {
  const r = await fetch(`${BASE}/v1/sandbox/merchants`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "MCP client example" }) });
  const sandbox = await r.json();
  if (!r.ok) throw new Error(sandbox.error?.message ?? `HTTP ${r.status}`);
  key = sandbox.api_key;
  order = sandbox.try_next.body;
  console.log(`Created sandbox merchant ${sandbox.merchant.id}`);
}

const client = new Client({ name: "recart-example-client", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
console.log(`Connected to ${client.getServerVersion()?.title}`);
console.log(`Tools: ${(await client.listTools()).tools.map((t) => t.name).join(", ")}`);

const draft = await client.callTool({ name: "draft_requirements", arguments: { text: "Two of us record in the room and one remote guest joins on Zoom. MacBook with USB-C. All-in budget $450.", timezone: "America/Los_Angeles" } });
console.log("Draft (confirm with the buyer before use):", JSON.stringify(draft.structuredContent.requirements));

if (order) {
  const preview = await client.callTool({ name: "preview_recovery", arguments: order });
  console.log(`Preview: ${preview.structuredContent.outcome} — ${preview.structuredContent.summary}`);
  const created = await client.callTool({ name: "create_recovery_proposal", arguments: { ...order, idempotency_key: `mcp-example-${Date.now()}` } });
  const rec = created.structuredContent;
  console.log(`Recovery ${rec.id}: ${rec.status}; proposal v${rec.proposal.version} ${rec.proposal.outcome}`);
  const link = await client.callTool({ name: "create_buyer_review_link", arguments: { recovery_id: rec.id, expires_in_minutes: 60 } });
  console.log(`Give the buyer this link (approval happens only there): ${link.structuredContent.url}`);
  const status = await client.callTool({ name: "get_recovery_status", arguments: { recovery_id: rec.id } });
  console.log(`Next action: ${status.structuredContent.next_action.actor} → ${status.structuredContent.next_action.message}`);
}
await client.close();
