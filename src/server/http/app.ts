import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SCENARIOS, type ScenarioId } from "../../domain/catalog/fixtures.js";
import { clock } from "../clock.js";
import { judgeBuyers, TIMING, trustProxySetting } from "../config.js";
import { AppError, type Ctx } from "../context.js";
import { maybeOne, withTx, many } from "../db/pool.js";
import { confirmGoal, parseGoal } from "../services/goals.js";
import { authorizeAfterApproval, markHandedOver, merchantConfirm, requestCancellation, startCheckout } from "../services/payments.js";
import { acceptQuote } from "../services/quotes.js";
import { cancelPurchase, recomputeCase, reportMissing, selectCandidate } from "../services/recovery.js";
import { closeSession, createSession, currentIntentId, loadSession, SESSION_HOURS, type SessionRow } from "../services/sessions.js";
import { runSolve } from "../services/solving.js";
import { sessionState } from "../services/views.js";
import { receivePayPalWebhook } from "../services/webhooks.js";
import { LostResponseInjector, PayPalRestClient } from "../paypal/client.js";
import { FakePayPal } from "../paypal/fake.js";
import { registerMcp } from "./mcp.js";
import { apiErrorBody, isPlatformUrl, registerPlatformRoutes } from "./v1.js";
import { MIGRATIONS } from "../db/migrations.js";
import { fingerprint, loadedModules, processStartedAt } from "../build-info.js";

fingerprint(import.meta.url, "http/app.js");

const COOKIE = "recart_sid";
declare module "fastify" { interface FastifyRequest { session: SessionRow | null; rawBody?: string } interface FastifyInstance { openEventStreams(): number } }

/** Tiny fixed-window limiter (per IP) protecting model credit and session creation; says when the window resets. */
function limiter(limit: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (key: string): { ok: boolean; retryAfterSeconds: number; retryAt: string } => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) { if (hits.size > 10_000) hits.clear(); h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
    h.n++;
    return { ok: h.n <= limit, retryAfterSeconds: Math.max(1, Math.ceil((h.reset - now) / 1000)), retryAt: new Date(h.reset).toISOString() };
  };
}
/** A 429 that says when to try again: in the message, in the body (`detail.retry_at`) and as Retry-After. */
function tooMany(code: string, message: string, r: { retryAfterSeconds: number; retryAt: string }) {
  const min = Math.max(1, Math.round(r.retryAfterSeconds / 60));
  return new AppError(429, code, `${message} Try again in ${min} minute${min === 1 ? "" : "s"}.`, { retry_after_seconds: r.retryAfterSeconds, retry_at: r.retryAt });
}

export async function buildApp(ctx: Ctx) {
  // Only the configured proxies may set X-Forwarded-For; otherwise a caller could pick its own rate-limit identity.
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: trustProxySetting(ctx.cfg.TRUST_PROXY) });
  await app.register(cookie);
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : {}); } catch { done(new AppError(400, "invalid_json", "Malformed JSON body"), undefined); }
  });
  app.decorateRequest("session", null);

  const sessionLimiter = limiter(ctx.cfg.DEMO_SESSIONS_PER_HOUR, 60 * 60_000);
  const languageLimiter = limiter(ctx.cfg.LANGUAGE_CALLS_PER_HOUR, 60 * 60_000);

  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/")) return;
    req.session = await loadSession(ctx.db, req.cookies[COOKIE]);
    const mutating = req.method !== "GET" && req.method !== "HEAD";
    // Buyer review routes are authorized by their capability link, not by a demo session.
    const exempt = req.url.startsWith("/api/webhooks/") || req.url.startsWith("/api/review/") || (req.url === "/api/sessions" && req.method === "POST");
    if (mutating && !exempt) {
      if (!req.session) throw new AppError(401, "no_session", "This purchase cannot be opened here. Return to the original browser profile, or start a separate demo.");
      if (req.headers["x-recart-csrf"] !== req.session.csrf_token) throw new AppError(403, "csrf", "Missing or invalid request token. Reload the page.");
    }
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (isPlatformUrl(req.url)) {
      const out = apiErrorBody(err, req.requestId);
      if (out.headers) reply.headers(out.headers);
      return reply.status(out.status).send(out.body);
    }
    if (err instanceof AppError) {
      const retry = err.status === 429 ? (err.detail as any)?.retry_after_seconds : undefined;
      if (retry) reply.header("retry-after", String(retry));
      return reply.status(err.status).send({ error: err.code, message: err.message, detail: err.detail ?? null });
    }
    if (err?.validation) return reply.status(400).send({ error: "bad_request", message: err.message });
    if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: "bad_request", message: err.message });
    console.error("[http] unhandled", err);
    return reply.status(500).send({ error: "internal", message: "Something went wrong. Your payment state is preserved on the server; reload to see it." });
  });

  const need = (req: FastifyRequest): SessionRow => {
    if (!req.session) throw new AppError(401, "no_session", "This purchase cannot be opened here. Return to the original browser profile, or start a separate demo.");
    return req.session;
  };
  const state = async (s: SessionRow) => sessionState(ctx, (await loadSession(ctx.db, s.id))!);
  const ip = (req: FastifyRequest) => req.ip;

  // ---------- public ----------
  app.get("/api/health", async () => {
    const db = await ctx.db.query("select 1").then(() => true).catch(() => false);
    const migration = await ctx.db.query("select max(version) v from schema_migrations").then((r) => r.rows[0]?.v ?? null).catch(() => null);
    return { ok: db, db, release: ctx.cfg.RELEASE_ID, migration, expectedMigration: MIGRATIONS[MIGRATIONS.length - 1]!.version, paypalMode: ctx.paypal.mode, language: await ctx.language.health(), build: { pid: process.pid, startedAt: processStartedAt, modules: loadedModules() }, time: clock.now().toISOString() };
  });

  app.get("/api/config", async () => ({
    paypal: { clientId: ctx.cfg.PAYPAL_CLIENT_ID, sdkUrl: `${ctx.cfg.PAYPAL_SDK_ORIGIN}/web-sdk/v6/core`, mode: ctx.paypal.mode, environment: "sandbox" },
    judgeBuyers: judgeBuyers(ctx.cfg),
    scenarios: Object.values(SCENARIOS).map((s) => ({ id: s.id, title: s.title, ending: s.ending, description: s.description, budgetCents: s.budgetCents })),
    timing: TIMING[ctx.cfg.TIMING_PRESET], preset: ctx.cfg.TIMING_PRESET, sessionHours: SESSION_HOURS,
    repoUrl: ctx.cfg.REPO_URL, videoUrl: ctx.cfg.VIDEO_URL, publicBaseUrl: ctx.cfg.PUBLIC_BASE_URL, release: ctx.cfg.RELEASE_ID,
  }));

  app.post("/api/sessions", async (req, reply) => {
    const quota = sessionLimiter(ip(req));
    if (!quota.ok) throw tooMany("too_many_sessions", `Too many new demos from this address (${ctx.cfg.DEMO_SESSIONS_PER_HOUR} per hour).`, quota);
    const body = (req.body ?? {}) as { scenario?: string; timezone?: string };
    const scenario = (["A", "B", "C"].includes(body.scenario ?? "") ? body.scenario : "A") as ScenarioId;
    if (req.session && req.session.status === "ACTIVE") await closeSession(ctx, req.session.id);
    const s = await createSession(ctx, { scenario, ...(body.timezone ? { buyerTimezone: body.timezone } : {}) });
    reply.setCookie(COOKIE, s.id, { path: "/", httpOnly: true, sameSite: "lax", secure: ctx.cfg.COOKIE_SECURE === "true", maxAge: SESSION_HOURS * 3600 });
    const row = (await loadSession(ctx.db, s.id))!;
    return { csrf: s.csrf, state: await sessionState(ctx, row) };
  });

  app.get("/api/state", async (req, reply) => {
    if (!req.session) return reply.send({ csrf: null, state: null });
    return { csrf: req.session.csrf_token, state: await sessionState(ctx, req.session) };
  });

  // Open event streams. Each one never ends on its own, so shutdown ends them explicitly (preClose, before the server
  // waits for in-flight requests); otherwise one open browser tab would hold the close, and the job runners, forever.
  const streams = new Set<() => void>();
  app.addHook("preClose", (done) => { for (const end of [...streams]) end(); done(); });
  app.decorate("openEventStreams", () => streams.size);

  app.get("/api/events", async (req, reply) => {
    const s = need(req);
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    reply.raw.write(`retry: 3000\nevent: hello\ndata: {"session":"${s.id}"}\n\n`);
    const onChange = (e: { sessionId: string; reason: string }) => { if (e.sessionId === s.id) reply.raw.write(`event: changed\ndata: ${JSON.stringify({ reason: e.reason })}\n\n`); };
    ctx.events.on("changed", onChange);
    const ping = setInterval(() => reply.raw.write(`: ping\n\n`), 20_000);
    let open = true;
    const cleanup = () => { if (!open) return; open = false; clearInterval(ping); ctx.events.off("changed", onChange); streams.delete(end); };
    // Server shutdown: say so (the browser reconnects after `retry`), finish the response, and do not keep its connection.
    const end = () => {
      if (!open) return;
      cleanup();
      reply.raw.once("finish", () => req.raw.socket?.destroy());
      reply.raw.end(`event: shutdown\ndata: {}\n\n`);
    };
    streams.add(end);
    req.raw.on("close", cleanup);
    return reply;
  });

  app.post("/api/sessions/close", async (req, reply) => {
    const s = need(req);
    await closeSession(ctx, s.id);
    reply.clearCookie(COOKIE, { path: "/" });
    return { closed: true };
  });

  // ---------- buyer ----------
  app.post("/api/goal/extract", async (req) => {
    const s = need(req);
    const text = String((req.body as any)?.text ?? "").trim();
    if (!text) throw new AppError(400, "empty", "Describe what you need to record.");
    if (text.length > 1500) throw new AppError(400, "too_long", "Please keep the request under 1,500 characters.");
    const quota = languageLimiter(ip(req));
    if (!quota.ok) throw tooMany("language_rate", `The AI helper is busy from this address (${ctx.cfg.LANGUAGE_CALLS_PER_HOUR} draft${ctx.cfg.LANGUAGE_CALLS_PER_HOUR === 1 ? "" : "s"} per hour); the form below still works.`, quota);
    const intentId = await currentIntentId(ctx.db, s.id);
    const result = await ctx.language.extractGoal({ sessionId: s.id, intentId, text, referenceTime: clock.now(), timezone: s.buyer_timezone });
    ctx.events.changed(s.id, "extraction");
    return { result, state: await state(s) };
  });

  app.post("/api/goal/confirm", async (req) => {
    const s = need(req);
    const goal = parseGoal((req.body as any)?.goal);
    const intentId = await currentIntentId(ctx.db, s.id);
    const intent = await maybeOne<any>(ctx.db, "select status from intents where id=$1", [intentId]);
    if (intent?.status !== "OPEN") throw new AppError(409, "intent_closed", "This purchase is closed. Start a separate demo.");
    await withTx(ctx.db, (tx) => confirmGoal(tx, { sessionId: s.id, intentId, goal, source: String((req.body as any)?.source ?? "form") }));
    const openCase = await maybeOne<{ id: string }>(ctx.db, "select id from recovery_cases where intent_id=$1 and status in ('AWAITING_BUYER','RECONCILING')", [intentId]);
    if (openCase) await recomputeCase(ctx, s, openCase.id);
    else await runSolve(ctx.db, { sessionId: s.id, intentId, purpose: "initial" });
    ctx.events.changed(s.id, "goal");
    return { state: await state(s) };
  });

  app.post("/api/quotes", async (req) => {
    const s = need(req);
    const b = req.body as { solveRunId?: string; index?: number };
    await selectCandidate(ctx, s, { solveRunId: String(b.solveRunId), index: Number(b.index ?? 0) });
    ctx.events.changed(s.id, "quote");
    return { state: await state(s) };
  });

  app.post("/api/quotes/:id/accept", async (req) => {
    const s = need(req);
    await acceptQuote(ctx.db, { session: s, quoteId: (req.params as any).id, displayedHash: String((req.body as any)?.hash ?? "") });
    ctx.events.changed(s.id, "consent");
    return { state: await state(s) };
  });

  app.post("/api/checkout", async (req) => {
    const s = need(req);
    const out = await startCheckout(ctx, s, String((req.body as any)?.quoteId ?? ""));
    return { ...out, state: await state(s) };
  });

  app.post("/api/checkout/:id/approved", async (req) => {
    const s = need(req);
    await authorizeAfterApproval(ctx, s, (req.params as any).id, String((req.body as any)?.orderId ?? ""));
    return { state: await state(s) };
  });

  app.post("/api/checkout/:id/cancel", async (req) => {
    const s = need(req);
    const c = await maybeOne<any>(ctx.db, "select c.id from checkouts c join intents i on i.id=c.intent_id where c.id=$1 and i.session_id=$2", [(req.params as any).id, s.id]);
    if (!c) throw new AppError(404, "checkout_not_found", "Checkout not found");
    await requestCancellation(ctx, c.id, "BUYER");
    return { state: await state(s) };
  });

  app.post("/api/purchase/cancel", async (req) => {
    const s = need(req);
    const reason = (req.body as any)?.reason === "no_supported_solution" ? "no_supported_solution" : "buyer_cancelled";
    await cancelPurchase(ctx, s, reason);
    return { state: await state(s) };
  });

  app.get("/api/case/:id", async (req, reply) => {
    const generic = { error: "case_unavailable", message: "This purchase cannot be opened here. Return to the original browser profile, or start a separate demo." };
    if (!req.session) return reply.status(404).send(generic);
    const rc = await maybeOne<any>(ctx.db, "select id, session_id from recovery_cases where id=$1", [(req.params as any).id]);
    if (!rc || rc.session_id !== req.session.id) return reply.status(404).send(generic);
    await ctx.db.query("update notifications set read_at=coalesce(read_at,$2) where case_id=$1", [rc.id, clock.now()]);
    return { csrf: req.session.csrf_token, state: await sessionState(ctx, req.session) };
  });

  app.post("/api/inbox/:id/read", async (req) => {
    const s = need(req);
    await ctx.db.query("update notifications set read_at=coalesce(read_at,$3) where id=$1 and session_id=$2", [(req.params as any).id, s.id, clock.now()]);
    return { ok: true };
  });

  // ---------- simulated merchant (same isolated session) ----------
  app.post("/api/merchant/checkouts/:id/confirm", async (req) => {
    const s = need(req);
    await merchantConfirm(ctx, s, (req.params as any).id);
    return { state: await state(s) };
  });
  app.post("/api/merchant/checkouts/:id/report-missing", async (req) => {
    const s = need(req);
    const caseId = await reportMissing(ctx, s, { checkoutId: (req.params as any).id, sku: String((req.body as any)?.sku ?? "") });
    return { caseId, state: await state(s) };
  });
  app.post("/api/merchant/checkouts/:id/handover", async (req) => {
    const s = need(req);
    await markHandedOver(ctx, s, (req.params as any).id);
    return { state: await state(s) };
  });

  // ---------- PayPal ----------
  app.post("/api/webhooks/paypal", async (req, reply) => {
    const r = await receivePayPalWebhook(ctx, req.headers as any, req.rawBody ?? "");
    return reply.status(r.status).send(r.body);
  });
  app.get("/api/paypal/client-token", async (req) => {
    need(req);
    const rest = ctx.paypal instanceof LostResponseInjector ? ctx.paypal.inner : ctx.paypal;
    if (!(rest instanceof PayPalRestClient)) throw new AppError(400, "not_available", "Client token is only available in Sandbox mode");
    const host = new URL(ctx.cfg.PUBLIC_BASE_URL).host;
    const t = await rest.clientToken([host]);
    return { clientToken: t.token, expiresIn: t.expiresIn };
  });
  if (ctx.paypal instanceof LostResponseInjector) {
    // Local PP04 recording only (PAYPAL_FAULT_INJECTION=1 on a loopback server): discard the next real PayPal response
    // for one operation so the run shows ReCart recovering from a lost response by reconciliation.
    const injector = ctx.paypal;
    const ops = ["createOrder", "authorizeOrder", "captureAuthorization", "voidAuthorization", "refundCapture"] as const;
    app.post("/api/dev/drop-next", async (req) => {
      need(req);
      const op = String((req.body as any)?.op ?? "");
      if (!(ops as readonly string[]).includes(op)) throw new AppError(400, "invalid_op", "Unknown PayPal operation");
      injector.dropNext(op as (typeof ops)[number]);
      return { armed: op };
    });
  }
  if (ctx.paypal instanceof FakePayPal) {
    // Offline mode only (PAYPAL_MODE=fake): stands in for the buyer's PayPal approval. Never present in Sandbox mode.
    const fake = ctx.paypal;
    app.post("/api/dev/fake-approve", async (req) => { need(req); fake.approve(String((req.body as any)?.orderId ?? "")); return { approved: true }; });
  }
  app.get("/paypal/return", async (_req, reply) => reply.redirect("/demo"));
  app.get("/paypal/cancel", async (_req, reply) => reply.redirect("/demo"));

  // ---------- merchant planning platform (REST v1, buyer review links, MCP) ----------
  registerPlatformRoutes(app, ctx);
  registerMcp(app, ctx);

  // ---------- evidence (public, aggregate only) ----------
  app.get("/api/evidence", async () => {
    const spikePath = fileURLToPath(new URL("../../../../evidence/sandbox/spike-pp01-pp03.json", import.meta.url));
    const spikeAlt = path.resolve(process.cwd(), "evidence/sandbox/spike-pp01-pp03.json");
    const file = [spikePath, spikeAlt].find((p) => existsSync(p));
    const counts = await maybeOne<any>(ctx.db, `select
      (select count(*)::int from demo_sessions) sessions,
      (select count(*)::int from payment_operations where kind='AUTHORIZE' and status='SUCCEEDED') authorizations,
      -- A capture counts as completed once PayPal reports it COMPLETED: the checkout reached PAID (or was refunded after).
      -- PayPal can also accept a capture as PENDING; that is a successful call but not yet money captured.
      (select count(*)::int from checkouts where capture_id is not null and payment_state in ('PAID','REFUND_IN_FLIGHT','REFUNDED')) captures,
      (select count(*)::int from checkouts where capture_id is not null and payment_state='CAPTURE_IN_FLIGHT') captures_pending,
      (select count(*)::int from payment_operations where kind='VOID' and status='SUCCEEDED') voids,
      (select count(*)::int from payment_operations where kind='REFUND' and status='SUCCEEDED') refunds,
      (select count(*)::int from webhook_events where verification='SUCCESS') webhooks_verified,
      (select count(*)::int from webhook_events where verification<>'SUCCESS') webhooks_rejected,
      (select count(*)::int from webhook_events where status='PROCESSED') webhooks_processed,
      (select count(*)::int from webhook_events where status='IGNORED') webhooks_ignored,
      (select count(*)::int from recovery_cases) recovery_cases,
      (select count(*)::int from language_runs where status='OK') language_ok,
      (select count(*)::int from language_runs where status='FALLBACK') language_fallback,
      (select coalesce(json_agg(json_build_object('model', t.model, 'n', t.n) order by t.n desc), '[]'::json) from (select model, count(*)::int n from language_runs where status='OK' and model is not null group by model) t) language_models,
      (select count(*)::int from language_runs where error like 'ungrounded:%') language_ungrounded,
      (select coalesce(percentile_cont(0.5) within group (order by duration_ms), 0)::int from language_runs where status='OK') language_p50_ms,
      (select coalesce(percentile_cont(0.95) within group (order by duration_ms), 0)::int from language_runs where status='OK') language_p95_ms`);
    const recentWebhooks = await many<any>(ctx.db, "select event_type, verification, status, received_at from webhook_events order by received_at desc limit 10");
    const evidenceDir = [path.resolve(process.cwd(), "evidence"), fileURLToPath(new URL("../../../../evidence", import.meta.url))].find((p) => existsSync(p));
    const readJson = (name: string) => { try { return evidenceDir && existsSync(path.join(evidenceDir, name)) ? JSON.parse(readFileSync(path.join(evidenceDir, name), "utf8")) : null; } catch { return null; } };
    const benchmarkRuns = ([["v1", "benchmark/summary.json"], ["v2", "benchmark/v2/summary.json"], ["v3", "benchmark/v3/summary.json"], ["v4", "benchmark/v4/summary.json"], ["holdout-v1", "benchmark/holdout-v1/summary.json"]] as const)
      .map(([id, f]) => ({ id, summary: readJson(f) })).filter((r) => r.summary);
    return { spike: file ? JSON.parse(readFileSync(file, "utf8")) : null, live: counts, recentWebhooks, sandboxMatrix: readJson("sandbox/matrix.json"), tests: readJson("tests/summary.json"), benchmark: readJson("benchmark/summary.json"), benchmarkRuns };
  });

  // ---------- static web ----------
  const webDir = [path.resolve(process.cwd(), "dist/web"), fileURLToPath(new URL("../../../web", import.meta.url))].find((p) => existsSync(path.join(p, "index.html")));
  if (webDir) {
    // Content-hashed build assets never change, so browsers may keep them for a year. index.html (also served for app
    // routes) is revalidated on every visit, so returning visitors get a new release at once; unchanged pages are 304s.
    const cachePolicy = (reply: FastifyReply, file: string) => {
      const rel = path.relative(webDir, file).split(path.sep).join("/");
      reply.header("cache-control", rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : rel.endsWith(".html") ? "no-cache" : "public, max-age=3600");
    };
    await app.register(fastifyStatic, { root: webDir, prefix: "/", wildcard: true, index: ["index.html"], setHeaders: cachePolicy });
    app.setNotFoundHandler((req, reply: FastifyReply) => {
      if (isPlatformUrl(req.url)) return reply.status(404).send({ error: { type: "not_found", code: "route_not_found", message: `No route ${req.method} ${req.url.split("?")[0]}. See /v1/openapi.json.`, request_id: req.requestId ?? null, details: null } });
      if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "not_found" });
      return reply.type("text/html").sendFile("index.html");
    });
  }
  if (!webDir) app.setNotFoundHandler((req, reply: FastifyReply) => reply.status(404).send(isPlatformUrl(req.url) ? { error: { type: "not_found", code: "route_not_found", message: `No route ${req.method} ${req.url.split("?")[0]}. See /v1/openapi.json.`, request_id: req.requestId ?? null, details: null } } : { error: "not_found" }));
  return app;
}
