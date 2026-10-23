import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as C from "../../src/platform/contract.js";
import { referenceRecoveryRequest } from "../../src/platform/sandbox.js";
import { START } from "../integration/harness.js";
import { api, platformSetup, stable, type P } from "./helpers.js";

let p: P;
let A: ReturnType<typeof api>;
let base: string;
beforeAll(async () => {
  p = await platformSetup();
  A = api(p);
  await p.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(p.app.server.address() as any).port}`;
});
afterAll(async () => { await p.app.close(); await p.h.db.end(); });
beforeEach(() => { p.h.clock.set(START); });

async function connect(key: string) {
  const client = new Client({ name: "recart-test-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}

describe("remote MCP server (official SDK client over Streamable HTTP)", () => {
  it("lists the planning tools, none of which can approve, charge or change an order", async () => {
    const s = await A.sandbox();
    const client = await connect(s.api_key);
    expect(client.getServerVersion()?.name).toBe("recart");
    expect(client.getInstructions()).toContain("No tool can approve a proposal");
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["create_buyer_review_link", "create_recovery_proposal", "draft_requirements", "get_recovery_status", "list_catalog_products", "preview_recovery"]);
    expect(tools.every((t) => t.inputSchema.type === "object" && t.outputSchema)).toBe(true);
    expect(tools.some((t) => /approve|capture|charge|refund|pay/i.test(t.name))).toBe(false);
    await client.close();
  });

  it("returns the same proposal as REST for the same request", async () => {
    const s = await A.sandbox();
    const client = await connect(s.api_key);
    const body = referenceRecoveryRequest();
    const viaMcp = await client.callTool({ name: "preview_recovery", arguments: body });
    expect(viaMcp.isError).toBeFalsy();
    const viaRest = (await A.call("POST", "/v1/recovery-previews", s.api_key, body)).json();
    expect(stable(viaMcp.structuredContent)).toEqual(stable(viaRest));
    expect(C.RecoveryPreviewResult.parse(viaMcp.structuredContent).replacement!.totals.total_cents).toBe(42228);
    // A stored recovery created through MCP reads back identically through REST.
    const created = await client.callTool({ name: "create_recovery_proposal", arguments: { ...body, idempotency_key: "mcp-order-1001" } });
    const rec = C.Recovery.parse(created.structuredContent);
    const status = await client.callTool({ name: "get_recovery_status", arguments: { recovery_id: rec.id } });
    const rest = (await A.call("GET", `/v1/recoveries/${rec.id}`, s.api_key)).json();
    expect(status.structuredContent).toEqual(rest);
    // The idempotency key is shared with REST: the same request through REST replays the MCP result.
    const replay = await A.call("POST", "/v1/recoveries", s.api_key, body, { "idempotency-key": "mcp-order-1001" });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json().id).toBe(rec.id);
    await client.close();
  });

  it("creates a working buyer review link; approval still happens only on the review page", async () => {
    const s = await A.sandbox();
    const client = await connect(s.api_key);
    const rec = (await client.callTool({ name: "create_recovery_proposal", arguments: referenceRecoveryRequest() })).structuredContent as any;
    const link = C.ReviewLink.parse((await client.callTool({ name: "create_buyer_review_link", arguments: { recovery_id: rec.id, expires_in_minutes: 30 } })).structuredContent);
    const token = link.url.split("/review/")[1]!;
    const view = (await A.call("GET", `/api/review/${token}`)).json();
    expect(view.proposal.id).toBe(rec.proposal.id);
    expect(view.decisions).toContain("approve");
    await client.close();
  });

  it("enforces the same scopes and isolation as REST", async () => {
    const a = await A.sandbox("A");
    const b = await A.sandbox("B");
    const readOnly = (await A.call("POST", "/v1/api-keys", a.api_key, { label: "agent", scopes: ["recoveries:read"] })).json();
    const client = await connect(readOnly.key);
    const denied = await client.callTool({ name: "create_recovery_proposal", arguments: referenceRecoveryRequest() });
    expect(denied.isError).toBe(true);
    expect(JSON.parse((denied.content as any)[0].text).error.code).toBe("missing_scope");
    const rec = await A.createReference(b.api_key);
    const other = await client.callTool({ name: "get_recovery_status", arguments: { recovery_id: rec.id } });
    expect(JSON.parse((other.content as any)[0].text).error.code).toBe("recovery_not_found");
    const invalid = await client.callTool({ name: "preview_recovery", arguments: { currency: "USD" } });
    expect(JSON.parse((invalid.content as any)[0].text).error.code).toBe("validation_failed");
    await client.close();
  });

  it("rejects unauthenticated connections with HTTP 401", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain("Bearer");
    expect((await fetch(`${base}/mcp`)).status).toBe(405);
  });
});
