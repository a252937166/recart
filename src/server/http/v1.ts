import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getProduct, listInventory, listProducts, upsertInventory, upsertProducts } from "../../platform/catalog.js";
import { ApiError, newId, type PlatformCtx } from "../../platform/core.js";
import { assertDeliverableUrl, emitEvent, EVENT_TYPES, inboxUrl, listDeliveries, listEvents } from "../../platform/events.js";
import { withIdempotency } from "../../platform/idempotency.js";
import { listInbox, receiveInbox } from "../../platform/inbox.js";
import { authenticateKey, getMerchant, issueApiKey, listApiKeys, merchantView, reportIntegration, requireScope, revokeApiKey, setWebhookEndpoint, type Principal } from "../../platform/merchants.js";
import { describePack, PACK_ID } from "../../platform/pack.js";
import { MCP_TOOLS } from "../../platform/mcptools.js";
import { OUTCOMES } from "../../platform/planning.js";
import {
  acknowledgeExecution, buyerChangeRequirement, buyerDecision, buyerRefresh, cancelRecovery, createRecovery, createReviewLink, getRecovery,
  listProposals, listRecoveries, previewRecovery, replan, reviewView, startExecution,
} from "../../platform/recoveries.js";
import { draftRequirements } from "../../platform/requirements.js";
import { createSandboxMerchant } from "../../platform/sandbox.js";
import {
  ApiKeyCreate, BuyerBudget, BuyerDecision, CatalogUpsert, DraftRequest, ExecutionAcknowledge, ExecutionCreate, IntegrationReport, InventoryUpsert,
  RecoveryCreate, RecoveryPreview, RecoveryUpdate, ReviewLinkCreate, SandboxMerchantCreate, SCOPES, WebhookEndpointSet, type Scope,
} from "../../platform/schemas.js";
import { showcasePreview } from "../../platform/showcase.js";
import { integrationStatus } from "../../platform/status.js";
import { clock } from "../clock.js";
import type { Ctx } from "../context.js";
import { buildOpenApi } from "./openapi.js";

export const API_VERSION = "v1";
export const CONTRACT_VERSION = "2026-10-10";
export const LIMITS = { requestsPerMinute: 300, draftsPerHour: 30, catalogBatch: 500, inventoryBatch: 1000, bodyBytes: 2 * 1024 * 1024 };

declare module "fastify" { interface FastifyRequest { requestId?: string } }

/** The server context already satisfies the platform's needs; pass it through so configuration is read live. */
export const platformCtx = (ctx: Ctx): PlatformCtx => ctx;

/** Fixed-window limiter keyed by caller (merchant or IP). */
export function windowLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || h.reset < now) { if (hits.size > 10_000) hits.clear(); hits.set(key, { n: 1, reset: now + windowMs }); return { ok: true, retryAfter: 0, retryAt: new Date(now + windowMs).toISOString() }; }
    h.n++;
    return { ok: h.n <= limit, retryAfter: Math.max(1, Math.ceil((h.reset - now) / 1000)), retryAt: new Date(h.reset).toISOString() };
  };
}

export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new ApiError("invalid_request", "validation_failed", "The request does not match the schema. See details.issues.", { issues: r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) });
  return r.data;
}

/** Public error body: `{ error: { type, code, message, request_id, details } }`. */
export function apiErrorBody(err: unknown, requestId: string | undefined): { status: number; body: unknown; headers?: Record<string, string> } {
  if (err instanceof ApiError) return { status: err.status, body: { error: { type: err.type, code: err.code, message: err.message, request_id: requestId ?? null, details: err.details ?? null } }, ...(err.type === "rate_limited" && (err.details as any)?.retry_after_seconds ? { headers: { "retry-after": String((err.details as any).retry_after_seconds) } } : {}) };
  const e = err as any;
  if (e?.code === "invalid_json" || e?.statusCode === 400 || e?.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || e?.code === "FST_ERR_CTP_BODY_TOO_LARGE" || e?.statusCode === 413 || e?.statusCode === 415) {
    const status = e?.statusCode === 413 || e?.code === "FST_ERR_CTP_BODY_TOO_LARGE" ? 413 : e?.statusCode === 415 || e?.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? 415 : 400;
    return { status, body: { error: { type: "invalid_request", code: status === 413 ? "body_too_large" : status === 415 ? "unsupported_media_type" : "invalid_json", message: status === 413 ? "The request body is too large." : status === 415 ? "Send JSON with Content-Type: application/json." : "The body is not valid JSON.", request_id: requestId ?? null, details: null } } };
  }
  console.error("[v1] unhandled", e);
  return { status: 500, body: { error: { type: "internal_error", code: "internal_error", message: "Something went wrong on ReCart's side. Retrying with the same Idempotency-Key is safe.", request_id: requestId ?? null, details: null } } };
}

export const isPlatformUrl = (url: string) => url.startsWith("/v1/") || url === "/v1" || url.startsWith("/mcp") || url.startsWith("/api/review/") || url.startsWith("/api/showcase") || url.startsWith("/api/integrations");

/** The latest recorded real-store stock-change run (evidence/shopify), summarized for the merchants page. */
function stockChangeEvidence() {
  const dir = [path.resolve(process.cwd(), "evidence/shopify"), fileURLToPath(new URL("../../../../evidence/shopify", import.meta.url))].find((d) => existsSync(d));
  if (!dir) return null;
  const file = readdirSync(dir).filter((f) => /^stock-change-.*\.json$/.test(f)).sort().pop();
  if (!file) return null;
  try {
    const d = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    return {
      file: `evidence/shopify/${file}`, recorded_at: d.started_at, product: d.watched_product?.name ?? null,
      versions: (d.versions ?? []).map((v: any) => ({ observed_at: v.observed_at, version: v.version, outcome: v.outcome, available: v.watched_stock?.[0]?.available ?? null, total_cents: v.total_cents, difference_cents: v.difference_cents, added: v.added })),
      correction: d.correction?.detail ?? null,
    };
  } catch { return null; }
}

export async function authenticate(ctx: Ctx, req: FastifyRequest): Promise<Principal> {
  const h = req.headers.authorization;
  const raw = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
  return authenticateKey(ctx.db, raw);
}

const pageLimit = (v: unknown, max = 100, dflt = 20) => {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ApiError("invalid_request", "invalid_limit", `limit must be an integer from 1 to ${max}.`);
  return n;
};
const str = (v: unknown) => (typeof v === "string" && v.length ? v : undefined);

export function registerPlatformRoutes(app: FastifyInstance, ctx: Ctx) {
  const pctx = platformCtx(ctx);
  const perMerchant = windowLimiter(LIMITS.requestsPerMinute, 60_000);
  const drafts = windowLimiter(LIMITS.draftsPerHour, 3600_000);
  const sandboxSignup = windowLimiter(ctx.cfg.SANDBOX_SIGNUPS_PER_HOUR, 3600_000);
  const buyerLimiter = windowLimiter(120, 60_000);
  const limit = (check: { ok: boolean; retryAfter: number; retryAt: string }, what: string) => {
    if (!check.ok) throw new ApiError("rate_limited", "rate_limited", `Too many ${what}. Retry after ${check.retryAfter} seconds.`, { retry_after_seconds: check.retryAfter, retry_at: check.retryAt });
  };

  app.addHook("onRequest", async (req, reply) => {
    if (!isPlatformUrl(req.url)) return;
    req.requestId = newId("req");
    reply.header("recart-request-id", req.requestId);
    reply.header("cache-control", "no-store");
  });

  type Handler<B> = (a: { p: Principal; body: B; req: FastifyRequest; params: Record<string, string>; query: Record<string, unknown> }) => Promise<unknown>;
  /** One merchant route: authenticate, check scope and rate, validate, then (optionally) run under Idempotency-Key. */
  function merchantRoute<S extends z.ZodType | undefined>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, opts: { scope: Scope | null; body?: S; idempotent?: boolean; status?: number; bodyLimit?: number }, handler: Handler<S extends z.ZodType ? z.infer<S> : undefined>) {
    app.route({
      method, url, ...(opts.bodyLimit ? { bodyLimit: opts.bodyLimit } : {}),
      handler: async (req: FastifyRequest, reply: FastifyReply) => {
        const p = await authenticate(ctx, req);
        if (opts.scope) requireScope(p, opts.scope);
        limit(perMerchant(p.merchant.id), "requests for this merchant");
        const body = (opts.body ? parseBody(opts.body, req.body) : undefined) as any;
        const run = async () => ({ status: opts.status ?? 200, body: await handler({ p, body, req, params: req.params as Record<string, string>, query: req.query as Record<string, unknown> }) });
        const key = req.headers["idempotency-key"];
        const out = opts.idempotent ? await withIdempotency(ctx.db, p.merchant.id, typeof key === "string" ? key : undefined, `${method} ${req.url.split("?")[0]}`, body ?? null, run) : { ...(await run()), replayed: false };
        if (out.replayed) reply.header("idempotent-replayed", "true");
        return reply.status(out.status).send(out.body);
      },
    });
  }

  // ---------- discovery (public) ----------
  app.get("/v1/capabilities", async () => ({
    api_version: API_VERSION, contract_version: CONTRACT_VERSION, release: ctx.cfg.RELEASE_ID,
    domains: [{ id: PACK_ID, href: `/v1/domains/${PACK_ID}` }],
    authentication: { scheme: "bearer", key_prefixes: ["rk_test_", "rk_live_"], scopes: SCOPES },
    boundary: "ReCart plans recoveries and records the buyer's approval of an exact proposal version. Your systems own inventory, orders and checkout: you apply an approved version and acknowledge the outcome. ReCart's hosted PayPal Sandbox demo is a separate, self-contained execution path.",
    features: {
      catalog_sync: true, inventory_sync: true, recovery_previews: true, recoveries: true, buyer_review_links: true, executions: true,
      requirement_drafts: { available: true, model: ctx.cfg.LANGUAGE_URL ? "hosted" : "rules_only", note: "Drafts are never confirmations." },
      webhooks: { signature_header: "ReCart-Signature", scheme: "t=<unix>,v1=<hex HMAC-SHA256 of '<t>.<body>'>", tolerance_seconds: 300, retries: "30s, 2m, 10m, 30m, 2h, 6h", events: EVENT_TYPES },
      idempotency: { header: "Idempotency-Key", retention_hours: 24, scope: "per merchant" },
      mcp: { url: `${ctx.cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/mcp`, transport: "streamable-http", authentication: "Authorization: Bearer <API key>", stateless: true,
        tools: MCP_TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, scope: t.scope, read_only: !!t.annotations.readOnlyHint })) },
      sandbox_signup: ctx.cfg.SANDBOX_SIGNUP === "true",
    },
    outcomes: OUTCOMES,
    limits: { requests_per_minute: LIMITS.requestsPerMinute, requirement_drafts_per_hour: LIMITS.draftsPerHour, catalog_batch: LIMITS.catalogBatch, inventory_batch: LIMITS.inventoryBatch, body_bytes: LIMITS.bodyBytes },
    links: { openapi: "/v1/openapi.json", developer_guide: "/developers" },
  }));
  app.get(`/v1/domains/${PACK_ID}`, async () => describePack());
  app.get("/v1/openapi.json", async () => buildOpenApi(ctx.cfg.PUBLIC_BASE_URL));

  // ---------- sandbox ----------
  app.post("/v1/sandbox/merchants", async (req, reply) => {
    limit(sandboxSignup(req.ip), "sandbox merchants from this address");
    const body = parseBody(SandboxMerchantCreate, req.body);
    return reply.status(201).send(await createSandboxMerchant(pctx, body));
  });
  app.post("/v1/sandbox/inbox/:merchant_id", async (req, reply) => {
    const r = await receiveInbox(ctx.db, (req.params as any).merchant_id, req.headers as any, req.rawBody ?? "");
    return reply.status(r.status).send(r.body);
  });
  merchantRoute("GET", "/v1/sandbox/inbox", { scope: "events:read" }, async ({ p, query }) => {
    if (p.merchant.kind !== "sandbox") throw new ApiError("not_found", "no_inbox", "Only sandbox merchants have a hosted inbox.");
    return { data: await listInbox(ctx.db, p.merchant.id, pageLimit(query.limit, 100, 20)), inbox_url: inboxUrl(ctx.cfg, p.merchant.id) };
  });

  // ---------- merchant ----------
  merchantRoute("GET", "/v1/merchant", { scope: null }, async ({ p }) => ({ ...merchantView(p.merchant), key: { id: p.keyId, scopes: p.scopes } }));
  merchantRoute("GET", "/v1/merchant/status", { scope: null }, async ({ p }) => integrationStatus(ctx.db, p.merchant));
  merchantRoute("PUT", "/v1/merchant/integration", { scope: "settings:write", body: IntegrationReport }, async ({ p, body }) => {
    await reportIntegration(ctx.db, p.merchant.id, body);
    return integrationStatus(ctx.db, (await getMerchant(ctx.db, p.merchant.id))!);
  });

  // ---------- catalog and inventory ----------
  merchantRoute("GET", "/v1/catalog/products", { scope: "catalog:read" }, async ({ p, query }) => listProducts(ctx.db, p.merchant.id, { status: str(query.status), role: str(query.role), after: str(query.after), limit: pageLimit(query.limit, 500, 100) }));
  merchantRoute("POST", "/v1/catalog/products", { scope: "catalog:write", body: CatalogUpsert, idempotent: true, bodyLimit: LIMITS.bodyBytes }, async ({ p, body }) => upsertProducts(pctx, p.merchant, body.products as any));
  merchantRoute("GET", "/v1/catalog/products/:product_id", { scope: "catalog:read" }, async ({ p, params }) => getProduct(ctx.db, p.merchant.id, params.product_id!));
  merchantRoute("GET", "/v1/inventory/levels", { scope: "catalog:read" }, async ({ p, query }) => listInventory(ctx.db, p.merchant, { product_id: str(query.product_id), limit: pageLimit(query.limit, 1000, 200) }));
  merchantRoute("POST", "/v1/inventory/levels", { scope: "catalog:write", body: InventoryUpsert, idempotent: true, bodyLimit: LIMITS.bodyBytes }, async ({ p, body }) => upsertInventory(pctx, p.merchant, body.levels));

  // ---------- planning ----------
  merchantRoute("POST", "/v1/requirement-drafts", { scope: "recoveries:write", body: DraftRequest }, async ({ p, body }) => {
    limit(drafts(p.merchant.id), "requirement drafts this hour");
    return draftRequirements(pctx, p.merchant, body);
  });
  merchantRoute("POST", "/v1/recovery-previews", { scope: "recoveries:read", body: RecoveryPreview }, async ({ p, body }) => previewRecovery(pctx, p.merchant, body));
  merchantRoute("POST", "/v1/recoveries", { scope: "recoveries:write", body: RecoveryCreate, idempotent: true, status: 201 }, async ({ p, body }) => createRecovery(pctx, p.merchant, body));
  merchantRoute("GET", "/v1/recoveries", { scope: "recoveries:read" }, async ({ p, query }) => listRecoveries(pctx, p.merchant, { status: str(query.status), external_order_id: str(query.external_order_id), before: str(query.before), limit: pageLimit(query.limit) }));
  merchantRoute("GET", "/v1/recoveries/:id", { scope: "recoveries:read" }, async ({ p, params }) => getRecovery(pctx, p.merchant, params.id!));
  merchantRoute("GET", "/v1/recoveries/:id/proposals", { scope: "recoveries:read" }, async ({ p, params }) => listProposals(pctx, p.merchant, params.id!));
  merchantRoute("PUT", "/v1/recoveries/:id/requirements", { scope: "recoveries:write", body: RecoveryUpdate, idempotent: true }, async ({ p, params, body }) => {
    await getRecovery(pctx, p.merchant, params.id!);
    await replan(pctx, p.merchant.id, params.id!, "requirements_updated", { requirements: body.requirements, actor: "merchant" });
    return getRecovery(pctx, p.merchant, params.id!);
  });
  merchantRoute("POST", "/v1/recoveries/:id/recompute", { scope: "recoveries:write" }, async ({ p, params }) => {
    await getRecovery(pctx, p.merchant, params.id!);
    const r = await replan(pctx, p.merchant.id, params.id!, "merchant_recompute", { force: true });
    return { revised: r.changed, recovery: await getRecovery(pctx, p.merchant, params.id!) };
  });
  merchantRoute("POST", "/v1/recoveries/:id/cancel", { scope: "recoveries:write", idempotent: true }, async ({ p, params }) => cancelRecovery(pctx, p.merchant, params.id!));
  merchantRoute("POST", "/v1/recoveries/:id/review-links", { scope: "recoveries:write", body: ReviewLinkCreate, idempotent: true, status: 201 }, async ({ p, params, body }) => createReviewLink(pctx, p.merchant, params.id!, body.expires_in_minutes));
  merchantRoute("POST", "/v1/recoveries/:id/executions", { scope: "recoveries:write", body: ExecutionCreate, idempotent: true, status: 201 }, async ({ p, params, body }) => startExecution(pctx, p.merchant, params.id!, body));
  merchantRoute("POST", "/v1/recoveries/:id/executions/:execution_id/acknowledgement", { scope: "recoveries:write", body: ExecutionAcknowledge, idempotent: true }, async ({ p, params, body }) => acknowledgeExecution(pctx, p.merchant, params.id!, params.execution_id!, body));

  // ---------- events, callbacks and keys ----------
  merchantRoute("GET", "/v1/events", { scope: "events:read" }, async ({ p, query }) => listEvents(ctx.db, p.merchant.id, { after: str(query.after), type: str(query.type), limit: pageLimit(query.limit, 100, 50) }));
  merchantRoute("GET", "/v1/webhook-deliveries", { scope: "events:read" }, async ({ p, query }) => ({ data: await listDeliveries(ctx.db, p.merchant.id, pageLimit(query.limit, 100, 20)) }));
  merchantRoute("PUT", "/v1/webhook-endpoint", { scope: "settings:write", body: WebhookEndpointSet }, async ({ p, body, query }) => {
    if (!body.url.startsWith(inboxUrl(ctx.cfg, p.merchant.id))) await assertDeliverableUrl(body.url, ctx.cfg.WEBHOOK_ALLOW_LOOPBACK === "true");
    const r = await setWebhookEndpoint(ctx.db, p.merchant, body.url, query.rotate_secret === "true");
    return { url: r.url, secret: r.secret, secret_note: r.secret ? "Store this signing secret now; it is shown once." : "The existing signing secret is unchanged. Add ?rotate_secret=true to rotate it." };
  });
  merchantRoute("DELETE", "/v1/webhook-endpoint", { scope: "settings:write" }, async ({ p }) => { await setWebhookEndpoint(ctx.db, p.merchant, null); return { url: null }; });
  merchantRoute("POST", "/v1/webhook-endpoint/test", { scope: "settings:write" }, async ({ p }) => {
    const m = (await getMerchant(ctx.db, p.merchant.id))!;
    if (!m.webhook_url) throw new ApiError("conflict", "no_webhook_endpoint", "Set a webhook endpoint first.");
    return { event_id: await emitEvent(ctx.db, m, "webhook.test", { message: "Test notification from ReCart.", sent_at: clock.now().toISOString() }) };
  });
  merchantRoute("GET", "/v1/api-keys", { scope: "settings:write" }, async ({ p }) => ({ data: await listApiKeys(ctx.db, p.merchant.id) }));
  merchantRoute("POST", "/v1/api-keys", { scope: "settings:write", body: ApiKeyCreate, status: 201 }, async ({ p, body }) => {
    const k = await issueApiKey(ctx.db, p.merchant, body.label, body.scopes);
    return { id: k.id, key: k.key, prefix: k.prefix, scopes: k.scopes, note: "Store this key now; it is shown once." };
  });
  merchantRoute("DELETE", "/v1/api-keys/:key_id", { scope: "settings:write" }, async ({ p, params }) => { await revokeApiKey(ctx.db, p, params.key_id!); return { id: params.key_id, revoked: true }; });

  // ---------- buyer review (capability link, no account) ----------
  const buyer = (req: FastifyRequest) => { limit(buyerLimiter(req.ip), "review requests from this address"); return (req.params as any).token as string; };
  app.get("/api/review/:token", async (req) => reviewView(pctx, buyer(req)));
  app.post("/api/review/:token/decision", async (req) => buyerDecision(pctx, buyer(req), parseBody(BuyerDecision, req.body)));
  app.post("/api/review/:token/budget", async (req) => {
    const b = parseBody(BuyerBudget, req.body);
    return buyerChangeRequirement(pctx, buyer(req), { kind: "budget", proposal_id: b.proposal_id, max_total_cents: b.max_total_cents });
  });
  app.post("/api/review/:token/accept-later-time", async (req) => buyerChangeRequirement(pctx, buyer(req), { kind: "accept_later_time", proposal_id: parseBody(z.object({ proposal_id: z.string().min(1).max(64) }).strict(), req.body).proposal_id }));
  app.post("/api/review/:token/refresh", async (req) => buyerRefresh(pctx, buyer(req)));

  // ---------- public, aggregate-only pages ----------
  app.get("/api/showcase/preview", async () => showcasePreview(clock.now()));
  app.get("/api/integrations/reference", async () => {
    const ids = ctx.cfg.REFERENCE_MERCHANT_IDS.split(",").map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const id of ids) {
      const m = await getMerchant(ctx.db, id);
      if (!m) continue;
      const s = await integrationStatus(ctx.db, m);
      out.push({ name: m.name, integration: s.integration, catalog: s.catalog, inventory: s.inventory, recoveries: s.recoveries, webhooks: { endpoint_set: s.webhooks.endpoint_set, delivered: s.webhooks.delivered, failed: s.webhooks.failed }, health: s.health, warnings: s.warnings, notes: s.notes, checked_at: s.checked_at });
    }
    return { data: out, stock_change_evidence: stockChangeEvidence() };
  });
}
