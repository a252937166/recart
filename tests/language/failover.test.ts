import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LanguageService } from "../../src/server/language/adapter.js";
import { ProviderError, type FailureKind, type LanguageProvider } from "../../src/server/language/providers.js";
import { reportMissing } from "../../src/server/services/recovery.js";
import { one } from "../../src/server/db/pool.js";
import { authorizedPurchase, drain, setup, START, type Harness } from "../integration/harness.js";

// Codex first; the hosted endpoint only while Codex cannot answer; a bad answer is not a provider failure.
const GOOD = JSON.stringify({ localPeople: { value: 2, span: "two of us" }, remoteGuests: { value: 1, span: "one remote guest" }, hostPort: { value: "usb-c", span: "USB-C" }, os: null, callApp: { value: "zoom", span: "Zoom" }, budgetCents: { value: 45000, span: "$450", allIn: true }, recordingDate: null, recordingTime: null, owned: { headphones: 0, micCables: 0, stands: 0 }, negations: [], unknowns: ["os"], conflicts: [], questions: [] });
const TEXT = "two of us and one remote guest on Zoom, USB-C laptop, $450.";
type Script = { fail?: string; status?: number | null; kind?: FailureKind; retryAfter?: number; content?: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fake(name: "codex" | "hosted", model: string, script: Script[] = [], probes: boolean[] = [], o: { probeDelayMs?: number } = {}): LanguageProvider & { calls: number; probes: number } {
  return {
    name, configured: true, calls: 0, probes: 0,
    maxSeconds: (b) => b + 1,
    async complete() {
      this.calls++;
      const s = script.shift() ?? {};
      if (s.fail) throw new ProviderError(s.fail, s.status ?? null, "scripted", { ...(s.kind ? { kind: s.kind } : {}), retryAfterSeconds: s.retryAfter ?? null });
      return { content: s.content ?? GOOD, model, usage: null, durationMs: 5 };
    },
    async probe() { this.probes++; if (o.probeDelayMs) await sleep(o.probeDelayMs); return { reachable: probes.shift() ?? true, model }; },
  };
}
let h: Harness;
beforeAll(async () => { h = await setup(); });
afterAll(async () => { await h.db.end(); });
beforeEach(() => { h.clock.set(START); });
// The test clock pins every row to the same instant, so runs are told apart by a tag in the buyer text.
let n = 0;
const extract = (svc: LanguageService) => { const tag = `[t${++n}]`; return svc.extractGoal({ sessionId: null as any, intentId: null as any, text: `${TEXT} ${tag}`, referenceTime: START, timezone: "America/Los_Angeles" }); };
const lastRun = () => one<any>(h.db, "select status, model, request, error from language_runs where request->>'text' like $1", [`%[t${n}]`]);

describe("language failover", () => {
  it("uses Codex when it answers, and records which provider did", async () => {
    const codex = fake("codex", "gpt-6-luna"), hosted = fake("hosted", "claude-haiku-4-5");
    const r = await extract(new LanguageService(h.db, { primary: codex, backup: hosted }));
    expect(r).toMatchObject({ status: "OK", source: "model", model: "gpt-6-luna", provider: "codex", fallbackFrom: null });
    expect(hosted.calls).toBe(0);
    expect((await lastRun()).request).toMatchObject({ provider: "codex", fallback_from: null });
  });
  it("falls back when Codex is unreachable, keeps the backup during the cooldown, and a status probe that reaches the gateway ends it early", async () => {
    let t = 1_000_000;
    const codex = fake("codex", "gpt-6-luna", [{ fail: "codex unreachable: timed out" }], [false, true]);
    const hosted = fake("hosted", "claude-haiku-4-5");
    const svc = new LanguageService(h.db, { primary: codex, backup: hosted }, { cooldownMs: 60_000, probeTtlMs: 30_000, now: () => t });
    expect(await extract(svc)).toMatchObject({ model: "claude-haiku-4-5", provider: "hosted", fallbackFrom: "codex" });
    expect((await lastRun()).request).toMatchObject({ provider: "hosted", fallback_from: "codex", provider_errors: [expect.stringContaining("unreachable")] });
    // Within the cooldown: a status probe says "down", so the backup answers and Codex is not called.
    t += 10_000;
    expect((await extract(svc)).model).toBe("claude-haiku-4-5");
    expect(codex.probes).toBe(1);
    expect(codex.calls).toBe(1);
    // No probe is due yet (one per 30 s): straight to the backup.
    t += 25_000;
    expect((await extract(svc)).model).toBe("claude-haiku-4-5");
    expect(codex.probes).toBe(1);
    expect(codex.calls).toBe(1);
    // The next probe says "up": Codex is back before the 60 s cooldown ends.
    t += 10_000;
    expect((await extract(svc)).model).toBe("gpt-6-luna");
    expect(codex.probes).toBe(2);
    expect(codex.calls).toBe(2);
    const health = await svc.health();
    expect(health.active).toBe("codex");
    expect(health.providers?.codex).toMatchObject({ configured: true, reachable: true, coolingDown: false, cooldown: null });
  });
  it("comes back on its own after the cooldown", async () => {
    let t = 2_000_000;
    const codex = fake("codex", "gpt-6-luna", [{ fail: "fetch failed" }], [false, false, false]);
    const hosted = fake("hosted", "claude-haiku-4-5");
    const svc = new LanguageService(h.db, { primary: codex, backup: hosted }, { cooldownMs: 60_000, probeTtlMs: 30_000, now: () => t });
    expect((await extract(svc)).model).toBe("claude-haiku-4-5");
    t += 61_000;
    expect((await extract(svc)).model).toBe("gpt-6-luna");
  });
  it("a quota refusal keeps the backup for the whole cooldown: a 200 from the status URL does not bring Codex back, and Codex is not retried", async () => {
    let t = 3_000_000;
    const codex = fake("codex", "gpt-6-luna", [{ fail: "codex HTTP 429: hourly limit reached for this key", status: 429 }], [true, true, true, true]);
    const hosted = fake("hosted", "claude-haiku-4-5");
    const svc = new LanguageService(h.db, { primary: codex, backup: hosted }, { cooldownMs: 60_000, probeTtlMs: 30_000, now: () => t });
    expect((await extract(svc)).model).toBe("claude-haiku-4-5");
    // 100 ms later, with the gateway answering its status URL: still the backup, no retry, no probe.
    t += 100;
    expect((await extract(svc)).model).toBe("claude-haiku-4-5");
    expect(codex.calls).toBe(1);
    expect(codex.probes).toBe(0);
    // Past the probe interval it is still a refusal, so still no probe and no retry.
    t += 31_000;
    expect((await extract(svc)).model).toBe("claude-haiku-4-5");
    expect(codex.calls).toBe(1);
    expect(codex.probes).toBe(0);
    const health = await svc.health();
    expect(health.active).toBe("hosted");
    expect(health.providers?.codex).toMatchObject({ reachable: true, coolingDown: true, cooldown: { kind: "refused", reason: expect.stringContaining("429") } });
    // The configured cooldown ends: Codex is tried again.
    t += 29_000;
    expect((await extract(svc)).model).toBe("gpt-6-luna");
    expect(codex.calls).toBe(2);
  });
  it("a refusal from the gateway's queue holds the cooldown the same way, and a Retry-After longer than the cooldown is honoured", async () => {
    let t = 4_000_000;
    const codex = fake("codex", "gpt-6-luna", [{ fail: "codex HTTP 503: deadline cannot be met", status: 503, kind: "refused" }, { fail: "codex HTTP 429: daily cap", status: 429, retryAfter: 120 }], [true, true, true]);
    const hosted = fake("hosted", "claude-haiku-4-5");
    const svc = new LanguageService(h.db, { primary: codex, backup: hosted }, { cooldownMs: 60_000, probeTtlMs: 30_000, now: () => t });
    expect((await extract(svc)).model).toBe("claude-haiku-4-5");
    t += 45_000;
    expect((await extract(svc)).model).toBe("claude-haiku-4-5");
    expect(codex.probes).toBe(0);
    t += 16_000; // 61 s: the queue refusal has expired; the next failure carries Retry-After: 120
    expect((await extract(svc)).model).toBe("claude-haiku-4-5");
    expect(codex.calls).toBe(2);
    t += 61_000;
    expect((await extract(svc)).model).toBe("claude-haiku-4-5");
    expect(codex.calls).toBe(2);
    t += 60_000; // 121 s after the 429
    expect((await extract(svc)).model).toBe("gpt-6-luna");
  });
  it("three concurrent requests during a network cooldown share one recovery probe", async () => {
    let t = 5_000_000;
    const codex = fake("codex", "gpt-6-luna", [{ fail: "codex unreachable: connect ECONNREFUSED" }], [true], { probeDelayMs: 150 });
    const hosted = fake("hosted", "claude-haiku-4-5");
    const svc = new LanguageService(h.db, { primary: codex, backup: hosted }, { cooldownMs: 60_000, probeTtlMs: 30_000, now: () => t });
    expect((await extract(svc)).model).toBe("claude-haiku-4-5");
    t += 31_000;
    const results = await Promise.all([extract(svc), extract(svc), extract(svc)]);
    expect(results.map((r) => r.model)).toEqual(["gpt-6-luna", "gpt-6-luna", "gpt-6-luna"]);
    expect(codex.probes).toBe(1);
    expect(codex.calls).toBe(4);
  });
  it("does not fail over on a malformed answer: that is the rules fallback", async () => {
    const codex = fake("codex", "gpt-6-luna", [{ content: "{oops" }]), hosted = fake("hosted", "claude-haiku-4-5");
    const r = await extract(new LanguageService(h.db, { primary: codex, backup: hosted }));
    expect(r).toMatchObject({ status: "FALLBACK", source: "rules", provider: null });
    expect(hosted.calls).toBe(0);
    expect((await lastRun()).request).toMatchObject({ provider: "codex" });
  });
  it("uses the rules when both providers fail, and the hosted endpoint alone when Codex is not configured", async () => {
    const codex = fake("codex", "gpt-6-luna", [{ fail: "down" }]), hosted = fake("hosted", "claude-haiku-4-5", [{ fail: "also down" }]);
    const r = await extract(new LanguageService(h.db, { primary: codex, backup: hosted }));
    expect(r).toMatchObject({ status: "FALLBACK", source: "rules" });
    expect((await lastRun()).error).toMatch(/codex: down \| hosted: also down/);
    const only = await extract(new LanguageService(h.db, { backup: fake("hosted", "claude-haiku-4-5") }));
    expect(only.model).toBe("claude-haiku-4-5");
    expect((await new LanguageService(h.db, {}).health())).toMatchObject({ configured: false, active: "rules" });
  });
});

describe("the recovery explanation is a background job", () => {
  it("stores the template at once, then the model's text when the job has run", async () => {
    const p = await authorizedPurchase(h, "A");
    const original = h.ctx.language;
    h.ctx.language = { ...original, async extractGoal(a) { return original.extractGoal(a); }, async explainChange() { return { status: "OK", summary: "Model text about the rebuilt setup.", options: [], model: "fake-model", error: null }; }, async health() { return { configured: true, reachable: true }; } };
    try {
      await reportMissing(h.ctx, p.session, { checkoutId: p.checkoutId, sku: "IF-2C-LB" });
      let rc = await one<any>(h.db, "select * from recovery_cases where intent_id=$1", [p.intentId]);
      expect(rc.detail.explanation).toMatchObject({ source: "template", pending: true, model: null });
      expect(rc.detail.explanation.text.length).toBeGreaterThan(10);
      await drain(h);
      rc = await one<any>(h.db, "select * from recovery_cases where intent_id=$1", [p.intentId]);
      expect(rc.detail.explanation).toMatchObject({ source: "model", pending: false, model: "fake-model", text: "Model text about the rebuilt setup.", solveRunId: rc.solve_run_id });
      expect(rc.detail.explanation.swaps.length).toBeGreaterThan(0);
    } finally { h.ctx.language = original; }
  });
});
