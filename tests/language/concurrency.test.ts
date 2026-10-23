import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../../src/server/jobs/worker.js";
import { LanguageService } from "../../src/server/language/adapter.js";
import { ProviderError, type Completion, type LanguageProvider, type ProbeResult } from "../../src/server/language/providers.js";
import { setup, START, type Harness } from "../integration/harness.js";

// Stale asynchronous results must never clear, weaken or shorten a newer hold on the primary. Every Codex call and
// status probe below waits until the test settles it, so each interleaving is exact rather than timing-dependent.
const GOOD = JSON.stringify({ localPeople: { value: 2, span: "two of us" }, remoteGuests: { value: 1, span: "one remote guest" }, hostPort: { value: "usb-c", span: "USB-C" }, os: null, callApp: { value: "zoom", span: "Zoom" }, budgetCents: { value: 45000, span: "$450", allIn: true }, recordingDate: null, recordingTime: null, owned: { headphones: 0, micCables: 0, stands: 0 }, negations: [], unknowns: ["os"], conflicts: [], questions: [] });
const TEXT = "two of us and one remote guest on Zoom, USB-C laptop, $450.";

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
/** The primary: each call and probe is a promise the test resolves or rejects. */
function controlled() {
  const calls: Deferred<Completion>[] = [], probes: Deferred<ProbeResult>[] = [];
  const provider: LanguageProvider = {
    name: "codex", configured: true, maxSeconds: (b) => b + 1,
    complete: () => { const d = deferred<Completion>(); calls.push(d); return d.promise; },
    probe: () => { const d = deferred<ProbeResult>(); probes.push(d); return d.promise; },
  };
  return {
    provider, calls, probes,
    answer: (i: number) => calls[i]!.resolve({ content: GOOD, model: "gpt-6-luna", usage: null, durationMs: 5 }),
    fail: (i: number, e: unknown) => calls[i]!.reject(e),
  };
}
const backup = (): LanguageProvider => ({ name: "hosted", configured: true, maxSeconds: () => 15, async complete() { return { content: GOOD, model: "claude-haiku-4-5", usage: null, durationMs: 5 }; }, async probe() { return { reachable: true }; } });
const refusal = (retryAfterSeconds: number | null = null) => new ProviderError("codex HTTP 429: hourly limit reached for this key", 429, "rate_limit_error", { kind: "refused", retryAfterSeconds });
const unreachable = () => new ProviderError("codex unreachable: connect ECONNREFUSED", null, "unreachable", { kind: "network" });

async function until(cond: () => boolean, what: string, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 2)); }
}
/** A pending result that can be checked without awaiting it, so a wrong extra Codex call fails the test at once instead of hanging. */
function track<T>(promise: Promise<T>) { const t = { done: false, promise }; promise.then(() => { t.done = true; }, () => { t.done = true; }); return t; }

let h: Harness;
beforeAll(async () => { h = await setup(); });
afterAll(async () => { await h.db.end(); });
let n = 0;
const draft = (svc: LanguageService) => svc.extractGoal({ sessionId: null, intentId: null, text: `${TEXT} [c${++n}]`, referenceTime: START, timezone: "America/Los_Angeles" });
const service = (now: () => number) => { const c = controlled(); return { c, svc: new LanguageService(h.db, { primary: c.provider, backup: backup() }, { cooldownMs: 60_000, probeTtlMs: 30_000, now }) }; };

describe("the code under test", () => {
  it("is the implementation requested: the sources, or the compiled tree named by RECART_IMPL_DIR", async () => {
    const impl = process.env.RECART_IMPL_DIR;
    const file = (compiled: string, source: string) => (impl ? path.resolve(impl, "server", compiled) : path.resolve("src/server", source));
    const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
    // Loaded here, not at the top, so an older tree without fingerprints fails only this check.
    await import("../../src/server/shutdown.js");
    const loaded = (await import("../../src/server/build-info.js")).loadedModules();
    expect(loaded["language/adapter.js"]).toBe(sha(file("language/adapter.js", "language/adapter.ts")));
    expect(loaded["jobs/worker.js"]).toBe(sha(file("jobs/worker.js", "jobs/worker.ts")));
    expect(loaded["language/faults.js"]).toBe(sha(file("language/faults.js", "language/faults.ts")));
    expect(loaded["shutdown.js"]).toBe(sha(file("shutdown.js", "shutdown.ts")));
  });
});

describe("stale results and newer holds", () => {
  it("a recovery probe that answers healthy after a newer 429 does not lift the refusal", async () => {
    let t = 10_000_000;
    const { c, svc } = service(() => t);
    const x = draft(svc), y = draft(svc);
    await until(() => c.calls.length === 2, "two Codex calls");
    c.fail(1, unreachable());
    expect(await y).toMatchObject({ provider: "hosted", fallbackFrom: "codex" });
    // Past the probe interval, a draft probes for recovery from the network failure...
    t += 31_000;
    const r = track(draft(svc));
    await until(() => c.probes.length === 1, "the recovery probe");
    // ...and while that probe is out, the older call comes back refused.
    c.fail(0, refusal());
    expect(await x).toMatchObject({ provider: "hosted", fallbackFrom: "codex" });
    c.probes[0]!.resolve({ reachable: true, model: "gpt-6-luna" });
    await until(() => r.done || c.calls.length > 2, "the probing draft to finish");
    expect(c.calls.length).toBe(2);
    expect(await r.promise).toMatchObject({ provider: "hosted", fallbackFrom: null });
    // 100 ms later: still the backup, with no new probe and no Codex call.
    t += 100;
    const z = track(draft(svc));
    await until(() => z.done || c.calls.length > 2 || c.probes.length > 1, "the next draft");
    expect([c.calls.length, c.probes.length]).toEqual([2, 1]);
    expect(await z.promise).toMatchObject({ provider: "hosted" });
    expect(svc.diagnostics().cooldown).toMatchObject({ kind: "refused", reason: expect.stringContaining("429") });
  });

  it("an older successful answer that returns after a newer 429 keeps its own result but does not lift the refusal", async () => {
    let t = 20_000_000;
    const { c, svc } = service(() => t);
    const x = draft(svc), y = draft(svc);
    await until(() => c.calls.length === 2, "two Codex calls");
    c.fail(1, refusal());
    expect(await y).toMatchObject({ provider: "hosted", fallbackFrom: "codex" });
    c.answer(0);
    expect(await x).toMatchObject({ provider: "codex", model: "gpt-6-luna" });
    t += 100;
    const z = track(draft(svc));
    await until(() => z.done || c.calls.length > 2 || c.probes.length > 0, "the next draft");
    expect([c.calls.length, c.probes.length]).toEqual([2, 0]);
    expect(await z.promise).toMatchObject({ provider: "hosted" });
    expect(svc.diagnostics().cooldown).toMatchObject({ kind: "refused" });
  });

  it("an older network failure after a 429 with Retry-After: 120 neither weakens nor shortens the refusal", async () => {
    const t0 = 30_000_000;
    let t = t0;
    const { c, svc } = service(() => t);
    const x = draft(svc), y = draft(svc);
    await until(() => c.calls.length === 2, "two Codex calls");
    c.fail(1, refusal(120));
    await y;
    t += 1000;
    c.fail(0, unreachable());
    expect(await x).toMatchObject({ provider: "hosted", fallbackFrom: "codex" });
    // Past the point where a network hold from the older failure would have ended, and later still: no probe, no Codex.
    for (const at of [t0 + 62_000, t0 + 119_000]) {
      t = at;
      const z = track(draft(svc));
      await until(() => z.done || c.calls.length > 2 || c.probes.length > 0, `the draft at +${(at - t0) / 1000} s`);
      expect([c.calls.length, c.probes.length]).toEqual([2, 0]);
      expect(await z.promise).toMatchObject({ provider: "hosted" });
      expect(svc.diagnostics().cooldown).toEqual({ kind: "refused", until: t0 + 120_000, reason: expect.stringContaining("429") });
    }
    // The Retry-After has passed: Codex again.
    t = t0 + 121_000;
    const w = draft(svc);
    await until(() => c.calls.length === 3, "Codex after the Retry-After");
    c.answer(2);
    expect(await w).toMatchObject({ provider: "codex" });
    expect(svc.diagnostics().cooldown).toBeNull();
  });

  it("a healthy probe cached before a later network failure is not taken as recovery from it", async () => {
    let t = 40_000_000;
    const { c, svc } = service(() => t);
    const health = svc.health();
    await until(() => c.probes.length === 1, "the health probe");
    c.probes[0]!.resolve({ reachable: true, model: "gpt-6-luna" });
    expect((await health).active).toBe("codex");
    t += 1000;
    const x = draft(svc);
    await until(() => c.calls.length === 1, "a Codex call");
    c.fail(0, unreachable());
    expect(await x).toMatchObject({ provider: "hosted", fallbackFrom: "codex" });
    // The cached healthy result is 2 s old, inside the 30 s window, but it predates the failure: it is not used. And
    // since a probe started only 2 s ago, the interval forbids a new one yet: the backup answers without probing.
    t += 1000;
    const r = track(draft(svc));
    await until(() => r.done || c.probes.length > 1 || c.calls.length > 1, "the next draft");
    expect([c.calls.length, c.probes.length]).toEqual([1, 1]);
    expect(await r.promise).toMatchObject({ provider: "hosted", fallbackFrom: null });
    // Once the interval has passed, a fresh probe runs; its answer (still down) keeps the hold.
    t = 40_000_000 + 31_000;
    const q = track(draft(svc));
    await until(() => q.done || c.probes.length === 2 || c.calls.length > 1, "a fresh probe");
    expect(c.probes.length).toBe(2);
    c.probes[1]!.resolve({ reachable: false, detail: "connect ECONNREFUSED" });
    expect(await q.promise).toMatchObject({ provider: "hosted", fallbackFrom: null });
    // That fresh result is reused within the interval: no third probe, still the backup.
    t += 1000;
    expect(await draft(svc)).toMatchObject({ provider: "hosted" });
    expect([c.calls.length, c.probes.length]).toEqual([1, 2]);
  });
});

describe("one recovery probe shared by concurrent drafts", () => {
  const recovering = async (t: { v: number }) => {
    const { c, svc } = service(() => t.v);
    const x = draft(svc);
    await until(() => c.calls.length === 1, "a Codex call");
    c.fail(0, unreachable());
    await x;
    t.v += 31_000;
    const three = [draft(svc), draft(svc), draft(svc)];
    await until(() => svc.diagnostics().probeWaiters === 3, "three drafts waiting on one probe");
    expect(c.probes.length).toBe(1);
    return { c, svc, three };
  };
  it("an unhealthy answer sends all three to the backup", async () => {
    const t = { v: 50_000_000 };
    const { c, svc, three } = await recovering(t);
    c.probes[0]!.resolve({ reachable: false, detail: "connect ECONNREFUSED" });
    expect((await Promise.all(three)).map((r) => r.provider)).toEqual(["hosted", "hosted", "hosted"]);
    expect([c.calls.length, c.probes.length]).toEqual([1, 1]);
    expect(svc.diagnostics()).toMatchObject({ probeInFlight: false, probeWaiters: 0, cooldown: { kind: "network" } });
  });
  it("a healthy answer sends all three to Codex and lifts the network hold", async () => {
    const t = { v: 60_000_000 };
    const { c, svc, three } = await recovering(t);
    c.probes[0]!.resolve({ reachable: true, model: "gpt-6-luna" });
    await until(() => c.calls.length === 4, "three Codex calls");
    c.answer(1); c.answer(2); c.answer(3);
    expect((await Promise.all(three)).map((r) => r.provider)).toEqual(["codex", "codex", "codex"]);
    expect(c.probes.length).toBe(1);
    expect(svc.diagnostics()).toMatchObject({ probeInFlight: false, probeWaiters: 0, cooldown: null });
  });
});

describe("one status probe at a time, across failure generations", () => {
  it("a second failure while a probe is pending starts no second probe; the stale answer unlocks nothing; probing resumes after the interval", async () => {
    const t0 = 70_000_000;
    let t = t0;
    const { c, svc } = service(() => t);
    const x = draft(svc), y = draft(svc);
    await until(() => c.calls.length === 2, "two Codex calls");
    c.fail(1, unreachable());
    await y;
    // 31 s on, a draft starts the recovery probe for that first failure, and it stays out.
    t = t0 + 31_000;
    const d1 = track(draft(svc));
    await until(() => c.probes.length === 1, "the first recovery probe");
    // A second failure arrives while that probe is pending: a new generation.
    c.fail(0, unreachable());
    await x;
    // Drafts and a health check now: no second probe starts beside the first, and the drafts do not wait on it.
    const d2 = track(draft(svc));
    const health = track(svc.health());
    await until(() => d2.done || c.probes.length > 1, "the draft after the second failure");
    expect(c.probes.length).toBe(1);
    expect(await d2.promise).toMatchObject({ provider: "hosted", fallbackFrom: null });
    expect(d1.done || health.done).toBe(false);
    expect(svc.diagnostics()).toMatchObject({ generation: 2, probeInFlight: true, probeGeneration: 1 });
    // The pending probe answers healthy. It started before the second failure, so it unlocks nothing.
    c.probes[0]!.resolve({ reachable: true, model: "gpt-6-luna" });
    expect(await d1.promise).toMatchObject({ provider: "hosted", fallbackFrom: null });
    expect((await health.promise).providers?.codex).toMatchObject({ reachable: true, coolingDown: true });
    expect(c.calls.length).toBe(2);
    expect(svc.diagnostics()).toMatchObject({ probeInFlight: false, cooldown: { kind: "network" } });
    // Right after: that answer is from the older generation, and a probe started under 30 s ago, so no new probe yet.
    t = t0 + 32_000;
    expect(await draft(svc)).toMatchObject({ provider: "hosted" });
    expect([c.calls.length, c.probes.length]).toEqual([2, 1]);
    // The interval has passed: a fresh probe for the current generation runs, answers healthy, and Codex is back.
    t = t0 + 62_000;
    const d4 = track(draft(svc));
    await until(() => c.probes.length === 2, "the fresh probe");
    c.probes[1]!.resolve({ reachable: true, model: "gpt-6-luna" });
    await until(() => c.calls.length === 3, "Codex again");
    c.answer(2);
    expect(await d4.promise).toMatchObject({ provider: "codex" });
    expect(svc.diagnostics()).toMatchObject({ probeInFlight: false, cooldown: null });
  });

  it("a refusal while a probe is pending: the probe's healthy answer lifts nothing, and no probe runs during the refusal", async () => {
    const t0 = 80_000_000;
    let t = t0;
    const { c, svc } = service(() => t);
    const x = draft(svc), y = draft(svc);
    await until(() => c.calls.length === 2, "two Codex calls");
    c.fail(1, unreachable());
    await y;
    t = t0 + 31_000;
    const d1 = track(draft(svc));
    await until(() => c.probes.length === 1, "the recovery probe");
    c.fail(0, refusal(90));
    await x;
    c.probes[0]!.resolve({ reachable: true, model: "gpt-6-luna" });
    expect(await d1.promise).toMatchObject({ provider: "hosted" });
    for (const at of [t0 + 62_000, t0 + 120_000]) {
      t = at;
      expect(await draft(svc)).toMatchObject({ provider: "hosted" });
      expect([c.calls.length, c.probes.length]).toEqual([2, 1]);
    }
    expect(svc.diagnostics().cooldown).toMatchObject({ kind: "refused", until: t0 + 31_000 + 90_000 });
  });

  it("a probe that never answers is cut at the probe timeout: the waiting drafts go to the backup in time, and the slot frees", async () => {
    let t = 90_000_000;
    const c = controlled();
    // A 120 s hold, so it is still in force when the next probe is due at +62 s.
    const svc = new LanguageService(h.db, { primary: c.provider, backup: backup() }, { cooldownMs: 120_000, probeTtlMs: 30_000, probeTimeoutMs: 150, now: () => t });
    const x = draft(svc);
    await until(() => c.calls.length === 1, "a Codex call");
    c.fail(0, unreachable());
    await x;
    t += 31_000;
    const started = Date.now();
    const pair = track(Promise.all([draft(svc), draft(svc)]));
    await until(() => pair.done, "the drafts waiting on the probe to go to the backup", 1500);
    const both = await pair.promise;
    const waited = Date.now() - started;
    expect(both.map((r) => r.provider)).toEqual(["hosted", "hosted"]);
    expect(waited).toBeGreaterThanOrEqual(140);
    expect(waited).toBeLessThan(1500);
    expect(c.probes.length).toBe(1);
    expect(svc.diagnostics()).toMatchObject({ probeInFlight: false, probeWaiters: 0 });
    // The provider never settled its promise, yet once the interval passes a new probe can start.
    t += 31_000;
    const next = track(draft(svc));
    await until(() => c.probes.length === 2, "the next probe");
    c.probes[1]!.resolve({ reachable: true, model: "gpt-6-luna" });
    await until(() => c.calls.length === 2, "Codex again");
    c.answer(1);
    expect(await next.promise).toMatchObject({ provider: "codex" });
    // The declared worst case counts this bound, not a fixed one.
    expect(svc.worstCaseSeconds("extract_goal")).toBe(0.15 + 51 + 15 + 5);
  });
});
