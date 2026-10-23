import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LanguageService } from "../../src/server/language/adapter.js";
import { clearFault, languageFaultSchema, listFaults, setFault } from "../../src/server/language/faults.js";
import { ProviderError, type LanguageProvider } from "../../src/server/language/providers.js";
import { one } from "../../src/server/db/pool.js";
import { freshSession, setup, START, type Harness } from "../integration/harness.js";

// An operator can delay or fail the providers for one session or one merchant, to prove timeouts and failover in
// production. Nobody else is affected: other scopes keep the real providers and the shared cooldown is untouched.
const GOOD = JSON.stringify({ localPeople: { value: 2, span: "two of us" }, remoteGuests: { value: 1, span: "one remote guest" }, hostPort: { value: "usb-c", span: "USB-C" }, os: null, callApp: { value: "zoom", span: "Zoom" }, budgetCents: { value: 45000, span: "$450", allIn: true }, recordingDate: null, recordingTime: null, owned: { headphones: 0, micCables: 0, stands: 0 }, negations: [], unknowns: ["os"], conflicts: [], questions: [] });
const TEXT = "two of us and one remote guest on Zoom, USB-C laptop, $450.";
function fake(name: "codex" | "hosted", model: string): LanguageProvider & { calls: number; probes: number } {
  return { name, configured: true, calls: 0, probes: 0, maxSeconds: (b) => b + 1, async complete() { this.calls++; return { content: GOOD, model, usage: null, durationMs: 5 }; }, async probe() { this.probes++; return { reachable: true, model }; } };
}
let h: Harness;
beforeAll(async () => { h = await setup(); });
afterAll(async () => { await h.db.end(); });
beforeEach(async () => { h.clock.set(START); await h.db.query("delete from language_faults"); });
// Rows share the pinned test clock, so each call's text carries a tag; merchant calls keep only its SHA-256.
let n = 0, lastText = "";
const extract = (svc: LanguageService, scope: { sessionId?: string; merchantId?: string } = {}) => {
  lastText = `${TEXT} [f${++n}]`;
  return svc.extractGoal({ sessionId: scope.sessionId ?? null, intentId: null, merchantId: scope.merchantId ?? null, text: lastText, referenceTime: START, timezone: "America/Los_Angeles" });
};
const lastRun = () => one<any>(h.db, "select status, model, request, error from language_runs where request->>'text' = $1 or request->>'textSha256' = $2", [lastText, createHash("sha256").update(lastText).digest("hex")]);
const inTen = () => new Date(START.getTime() + 600_000);
// Session scopes must be real demo sessions (language_runs references them); merchant scopes are plain ids.
const sid = async () => (await freshSession(h)).session.id;

describe("scoped language faults", () => {
  it("delay the primary for that session only, and say so in the recorded run", async () => {
    const codex = fake("codex", "gpt-6-luna"), hosted = fake("hosted", "claude-haiku-4-5");
    const svc = new LanguageService(h.db, { primary: codex, backup: hosted });
    const slow = await sid(), other = await sid();
    await setFault(h.db, `session:${slow}`, { primary: { delay_ms: 300 } }, inTen());
    let t0 = Date.now();
    expect(await extract(svc, { sessionId: slow })).toMatchObject({ provider: "codex", model: "gpt-6-luna" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    expect((await lastRun()).request).toMatchObject({ provider: "codex", simulated_fault: { primary: { delay_ms: 300 } } });
    t0 = Date.now();
    expect(await extract(svc, { sessionId: other })).toMatchObject({ provider: "codex" });
    expect(Date.now() - t0).toBeLessThan(200);
    expect((await lastRun()).request.simulated_fault).toBeUndefined();
  });
  it("fail the primary for one merchant so the backup answers, without touching the shared cooldown", async () => {
    const codex = fake("codex", "gpt-6-luna"), hosted = fake("hosted", "claude-haiku-4-5");
    const svc = new LanguageService(h.db, { primary: codex, backup: hosted });
    await setFault(h.db, "merchant:m-fail", { primary: { outcome: "refused", status: 503, message: "simulated gateway refusal" } }, inTen());
    expect(await extract(svc, { merchantId: "m-fail" })).toMatchObject({ provider: "hosted", fallbackFrom: "codex", model: "claude-haiku-4-5" });
    expect((await lastRun()).request).toMatchObject({ provider: "hosted", fallback_from: "codex", provider_errors: [expect.stringContaining("simulated gateway refusal")] });
    expect(codex.calls).toBe(0);
    // Another caller right away: Codex, no cooldown, no probe.
    expect(await extract(svc, { merchantId: "m-other" })).toMatchObject({ provider: "codex" });
    expect(codex.calls).toBe(1);
    expect(codex.probes).toBe(0);
    expect((await svc.health()).providers?.codex).toMatchObject({ coolingDown: false, cooldown: null });
    // An unreachable primary after a delay: the slow failure, then the backup.
    await setFault(h.db, "merchant:m-fail", { primary: { delay_ms: 100, outcome: "unreachable" } }, inTen());
    const t0 = Date.now();
    expect(await extract(svc, { merchantId: "m-fail" })).toMatchObject({ provider: "hosted", fallbackFrom: "codex" });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
    expect((await svc.health()).providers?.codex).toMatchObject({ coolingDown: false });
  });
  it("can target the backup, one task only, and expire", async () => {
    const codex = fake("codex", "gpt-6-luna"), hosted = fake("hosted", "claude-haiku-4-5");
    const svc = new LanguageService(h.db, { primary: codex, backup: hosted });
    const task = await sid(), gone = await sid(), both = await sid();
    await setFault(h.db, `session:${task}`, { task: "explain_change", primary: { outcome: "unreachable" } }, inTen());
    expect(await extract(svc, { sessionId: task })).toMatchObject({ provider: "codex" });
    await setFault(h.db, `session:${gone}`, { primary: { outcome: "unreachable" } }, new Date(START.getTime() - 1000));
    expect(await extract(svc, { sessionId: gone })).toMatchObject({ provider: "codex" });
    await setFault(h.db, `session:${both}`, { primary: { outcome: "unreachable" }, backup: { outcome: "refused", status: 502 } }, inTen());
    expect(await extract(svc, { sessionId: both })).toMatchObject({ status: "FALLBACK", source: "rules", provider: null });
    expect((await lastRun()).error).toMatch(/codex: codex unreachable: simulated extract_goal fault \| hosted: hosted HTTP 502/);
    expect((await listFaults(h.db)).map((f) => f.scope).sort()).toEqual([`session:${both}`, `session:${gone}`, `session:${task}`].sort());
    await clearFault(h.db, `session:${both}`);
    expect(await extract(svc, { sessionId: both })).toMatchObject({ provider: "codex" });
  });
  it("rejects malformed faults and scopes", async () => {
    expect(languageFaultSchema.safeParse({}).success).toBe(false);
    expect(languageFaultSchema.safeParse({ primary: { delay_ms: 10_000_000 } }).success).toBe(false);
    expect(languageFaultSchema.safeParse({ primary: { outcome: "explode" } }).success).toBe(false);
    expect(languageFaultSchema.safeParse({ primary: { delay_ms: 5 }, extra: 1 }).success).toBe(false);
    expect(languageFaultSchema.safeParse({ task: "extract_goal", backup: { outcome: "refused", status: 429 } }).success).toBe(true);
    await expect(setFault(h.db, "everyone", { primary: { delay_ms: 1 } }, inTen())).rejects.toThrow(/session:<id> or merchant:<id>/);
  });
});

describe("a simulated delay counts against the provider's own time bound", () => {
  /** A primary as slow as a busy gateway: it uses its whole bound for the budget it is given, then times out. */
  function slowPrimary() {
    const budgets: number[] = [];
    const p: LanguageProvider & { budgets: number[] } = {
      name: "codex", configured: true, budgets, maxSeconds: (b) => b + 1,
      async complete(a) { budgets.push(a.budgetSeconds); await new Promise((r) => setTimeout(r, (a.budgetSeconds + 1) * 1000)); throw new ProviderError("codex unreachable: timed out", null, "unreachable", { kind: "network" }); },
      async probe() { return { reachable: true }; },
    };
    return p;
  }
  const timed = async <T,>(fn: () => Promise<T>) => { const t0 = Date.now(); const out = await fn(); return { out, ms: Date.now() - t0 }; };

  it("a delay followed by a slow real call ends at the primary's bound, not delay plus bound", async () => {
    const primary = slowPrimary(), hosted = fake("hosted", "claude-haiku-4-5");
    // Budget 1 s, so the primary's bound is 2 s; the delay takes 1.5 s of it.
    const svc = new LanguageService(h.db, { primary, backup: hosted }, { extractBudgetSeconds: 1 });
    const session = await sid();
    await setFault(h.db, `session:${session}`, { primary: { delay_ms: 1500 } }, inTen());
    const { out, ms } = await timed(() => extract(svc, { sessionId: session }));
    expect(out).toMatchObject({ status: "OK", provider: "hosted", fallbackFrom: "codex" });
    expect(primary.budgets).toEqual([1]);
    expect(ms).toBeGreaterThanOrEqual(1900);
    expect(ms).toBeLessThan(2600);
    expect((await lastRun()).request.provider_errors[0]).toMatch(/codex unreachable: timed out \(simulated extract_goal fault: 2 s of the 2 s bound/);
    expect((await svc.health()).providers?.codex).toMatchObject({ coolingDown: false });
  });
  it("a delay longer than the bound is cut at the bound, and the real call is never made", async () => {
    const primary = slowPrimary(), hosted = fake("hosted", "claude-haiku-4-5");
    const svc = new LanguageService(h.db, { primary, backup: hosted }, { extractBudgetSeconds: 1 });
    const session = await sid();
    await setFault(h.db, `session:${session}`, { primary: { delay_ms: 5000 } }, inTen());
    const { out, ms } = await timed(() => extract(svc, { sessionId: session }));
    expect(out).toMatchObject({ provider: "hosted", fallbackFrom: "codex" });
    expect(primary.budgets).toEqual([]);
    expect(ms).toBeGreaterThanOrEqual(1900);
    expect(ms).toBeLessThan(2600);
  });
  it("the real call after a delay gets only what is left of the budget", async () => {
    const budgets: number[] = [];
    const quick: LanguageProvider = { name: "codex", configured: true, maxSeconds: (b) => b + 1, async complete(a) { budgets.push(a.budgetSeconds); return { content: GOOD, model: "gpt-6-luna", usage: null, durationMs: 5 }; }, async probe() { return { reachable: true }; } };
    const svc = new LanguageService(h.db, { primary: quick, backup: fake("hosted", "claude-haiku-4-5") }, { extractBudgetSeconds: 10 });
    const session = await sid();
    await setFault(h.db, `session:${session}`, { primary: { delay_ms: 300 } }, inTen());
    expect(await extract(svc, { sessionId: session })).toMatchObject({ provider: "codex", model: "gpt-6-luna" });
    expect(budgets).toEqual([9]);
  });
});
