import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { LanguageService, plannedWorstCaseSeconds } from "../../src/server/language/adapter.js";
import { CodexProvider, CODEX_GRACE_SECONDS, HostedProvider, PROBE_TIMEOUT_MS } from "../../src/server/language/providers.js";
import { OVERHEAD_SECONDS } from "../../src/server/language/adapter.js";
import { api, platformSetup, type P } from "../platform/helpers.js";

// Every route that waits on the language providers must be given time for the worst case: a status probe, the
// primary up to its deadline plus transport grace, then the backup, then recording and answering.
const conf = readFileSync(new URL("../../deploy/nginx-recart.conf", import.meta.url), "utf8");
const tls = conf.slice(conf.indexOf("listen 443")); // the serving block; the port-80 block only redirects
const block = (location: string) => { const m = new RegExp(`location\\s+(?:=\\s*)?${location.replace(/[/.]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(tls); if (!m) throw new Error(`no location ${location}`); return m[1]!; };
const readTimeout = (body: string) => Number(/proxy_read_timeout\s+(\d+)s/.exec(body)?.[1] ?? NaN);
const GOOD = JSON.stringify({ localPeople: { value: 2, span: "two of us" }, remoteGuests: { value: 1, span: "one remote guest" }, hostPort: { value: "usb-c", span: "USB-C" }, os: null, callApp: { value: "zoom", span: "Zoom" }, budgetCents: { value: 45000, span: "$450", allIn: true }, recordingDate: null, recordingTime: null, owned: { headphones: 0, micCables: 0, stands: 0 }, negations: [], unknowns: ["os"], conflicts: [], questions: [] });
const TEXT = "two of us and one remote guest on Zoom, USB-C laptop, $450.";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("proxy read timeouts", () => {
  it("cover the worst-case draft on /api/, /v1/ and /mcp, computed from the same budgets the service uses", () => {
    const cfg = loadConfig({});
    const worst = plannedWorstCaseSeconds(cfg, "extract_goal");
    expect(worst).toBe(PROBE_TIMEOUT_MS / 1000 + cfg.CODEX_DEADLINE_SECONDS + CODEX_GRACE_SECONDS + 15 + OVERHEAD_SECONDS);
    expect(worst).toBe(140);
    for (const location of ["/api/", "/v1/", "/mcp"]) expect(readTimeout(block(location)), location).toBeGreaterThanOrEqual(worst);
    // The default location is not the one that drafts: /api/goal/extract must match the /api/ block, not inherit 60 s.
    expect(readTimeout(block("/"))).toBe(60);
    expect(tls.indexOf("location /api/ {")).toBeGreaterThan(-1);
    // The event stream keeps its own, longer, unbuffered location; it is a longer prefix than /api/, so it still wins.
    const events = block("/api/events");
    expect(readTimeout(events)).toBe(3600);
    expect(events).toMatch(/proxy_buffering off/);
    // The explanation runs in a background job with its own deadline and lease, not behind the proxy.
    expect(plannedWorstCaseSeconds(cfg, "explain_change")).toBe(cfg.CODEX_EXPLAIN_DEADLINE_SECONDS + CODEX_GRACE_SECONDS + 5 + 15 + OVERHEAD_SECONDS);
  });
});

describe("a slow or failed primary followed by a successful backup", () => {
  let p: P;
  let key: string;
  let merchantId: string;
  beforeAll(async () => {
    p = await platformSetup();
    const s = await api(p).sandbox("Timeout store");
    key = s.api_key; merchantId = s.merchant.id;
  });
  afterAll(async () => { await p.app.close(); await p.h.db.end(); });

  /** The primary hangs until its own deadline aborts the call; the backup answers at once. Budgets are scaled down for the test. */
  const fresh = () => {
    const hang = ((_u: any, init: any) => new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))) as unknown as typeof fetch;
    const codex = new CodexProvider({ url: "http://codex.test", key: "k", fetchFn: hang, graceSeconds: 0.5 });
    const hosted = new HostedProvider("http://hosted.test", "t", { timeoutMs: 2000, fetchFn: (async (_u: any, init: any) => json(200, { ok: true, requestId: JSON.parse(String(init.body)).requestId, model: "claude-haiku-4-5", content: GOOD })) as typeof fetch });
    const svc = new LanguageService(p.h.db, { primary: codex, backup: hosted }, { extractBudgetSeconds: 1, explainBudgetSeconds: 1 });
    p.h.ctx.language = svc;
    return { worstMs: svc.worstCaseSeconds("extract_goal") * 1000, primaryMs: codex.maxSeconds(1) * 1000 };
  };
  const timed = async <T,>(fn: () => Promise<T>) => { const t0 = Date.now(); const out = await fn(); return { out, ms: Date.now() - t0 }; };

  it("finishes within the worst case on /api/goal/extract", async () => {
    const { worstMs, primaryMs } = fresh();
    const s = await p.app.inject({ method: "POST", url: "/api/sessions", remoteAddress: "127.0.0.1", headers: { "content-type": "application/json" }, payload: { scenario: "A" } });
    const cookie = s.cookies.find((c) => c.name === "recart_sid")!.value;
    const { out, ms } = await timed(() => p.app.inject({ method: "POST", url: "/api/goal/extract", remoteAddress: "127.0.0.1", headers: { "content-type": "application/json", "x-recart-csrf": s.json().csrf }, cookies: { recart_sid: cookie }, payload: { text: TEXT } }));
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json().result).toMatchObject({ status: "OK", source: "model", provider: "hosted", fallbackFrom: "codex", model: "claude-haiku-4-5" });
    expect(ms).toBeGreaterThanOrEqual(primaryMs - 50);
    expect(ms).toBeLessThanOrEqual(worstMs);
    expect(out.json().state.extraction).toMatchObject({ provider: "hosted", fallback_from: "codex" });
  });
  it("finishes within the worst case on POST /v1/requirement-drafts", async () => {
    const { worstMs, primaryMs } = fresh();
    const { out, ms } = await timed(() => api(p).call("POST", "/v1/requirement-drafts", key, { text: TEXT, timezone: "America/Los_Angeles" }));
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json()).toMatchObject({ object: "requirement_draft", source: "model", provider: "hosted", model: "claude-haiku-4-5" });
    expect(ms).toBeGreaterThanOrEqual(primaryMs - 50);
    expect(ms).toBeLessThanOrEqual(worstMs);
  });
  it("finishes within the worst case on the MCP draft_requirements tool", async () => {
    const { worstMs, primaryMs } = fresh();
    const { out, ms } = await timed(() => p.app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "draft_requirements", arguments: { text: TEXT, timezone: "America/Los_Angeles" } } } }));
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json().result.structuredContent).toMatchObject({ object: "requirement_draft", source: "model", provider: "hosted" });
    expect(ms).toBeGreaterThanOrEqual(primaryMs - 50);
    expect(ms).toBeLessThanOrEqual(worstMs);
    expect(merchantId).toMatch(/^mch_/);
  });
  it("a primary that fails at once goes straight to the backup", async () => {
    const codex = new CodexProvider({ url: "http://codex.test", key: "k", fetchFn: (async () => json(503, { error: { type: "deadline_unreachable", message: "deadline cannot be met" } })) as typeof fetch });
    const hosted = new HostedProvider("http://hosted.test", "t", { timeoutMs: 2000, fetchFn: (async (_u: any, init: any) => json(200, { ok: true, requestId: JSON.parse(String(init.body)).requestId, model: "claude-haiku-4-5", content: GOOD })) as typeof fetch });
    p.h.ctx.language = new LanguageService(p.h.db, { primary: codex, backup: hosted }, { extractBudgetSeconds: 1 });
    const { out, ms } = await timed(() => api(p).call("POST", "/v1/requirement-drafts", key, { text: TEXT, timezone: "America/Los_Angeles" }));
    expect(out.statusCode, out.body).toBe(200);
    expect(out.json()).toMatchObject({ source: "model", provider: "hosted" });
    expect(ms).toBeLessThan(1000);
  });
});
