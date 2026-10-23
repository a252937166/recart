import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ApiError, type PlatformCtx } from "../../platform/core.js";
import { requireScope, type Principal } from "../../platform/merchants.js";
import { MCP_INSTRUCTIONS, MCP_SERVER_INFO, MCP_TOOLS } from "../../platform/mcptools.js";
import type { Ctx } from "../context.js";
import { apiErrorBody, authenticate, LIMITS, parseBody, platformCtx, windowLimiter } from "./v1.js";

const jsonSchema = (s: z.ZodType, io: "input" | "output") => { const j = z.toJSONSchema(s, { io, unrepresentable: "any" }) as any; delete j.$schema; return j; };

/** One MCP server per request (stateless Streamable HTTP), bound to the caller's merchant and key scopes. */
export function buildMcpServer(pctx: PlatformCtx, p: Principal) {
  const server = new Server(MCP_SERVER_INFO, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: MCP_TOOLS.map((t) => ({ name: t.name, title: t.title, description: `${t.description} Requires the ${t.scope} scope.`, inputSchema: jsonSchema(t.input, "input"), outputSchema: jsonSchema(t.output, "output"), annotations: { title: t.title, ...t.annotations } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = MCP_TOOLS.find((t) => t.name === req.params.name);
    const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify(apiErrorBody(e, undefined).body) }] });
    if (!tool) return fail(new ApiError("not_found", "unknown_tool", `No tool named ${req.params.name}.`));
    try {
      requireScope(p, tool.scope);
      const args = parseBody(tool.input, req.params.arguments ?? {});
      const result = (await tool.run(pctx, p, args)) as Record<string, unknown>;
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
    } catch (e) { return fail(e); }
  });
  return server;
}

export function registerMcp(app: FastifyInstance, ctx: Ctx) {
  const pctx = platformCtx(ctx);
  const perMerchant = windowLimiter(LIMITS.requestsPerMinute, 60_000);
  const rpcError = (code: number, message: string) => ({ jsonrpc: "2.0", error: { code, message }, id: null });
  app.post("/mcp", async (req, reply) => {
    let p: Principal;
    try { p = await authenticate(ctx, req); } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Authentication failed.";
      return reply.status(401).header("www-authenticate", 'Bearer realm="recart"').send(rpcError(-32001, msg));
    }
    if (!perMerchant(p.merchant.id).ok) return reply.status(429).send(rpcError(-32002, "Too many requests for this merchant. Retry in a minute."));
    const server = buildMcpServer(pctx, p);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v); else if (Array.isArray(v)) headers.set(k, v.join(", "));
      const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, { method: "POST", headers, body: req.rawBody ?? JSON.stringify(req.body ?? {}) });
      const res = await transport.handleRequest(request, { parsedBody: req.body });
      reply.status(res.status);
      res.headers.forEach((v, k) => { if (k !== "content-length") reply.header(k, v); });
      return reply.send(await res.text());
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
  const notAllowed = async (_req: unknown, reply: any) => reply.status(405).header("allow", "POST").send(rpcError(-32000, "This stateless MCP server accepts POST only."));
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
