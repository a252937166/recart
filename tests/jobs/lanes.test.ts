import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueJob } from "../../src/server/context.js";
import { maybeOne, one } from "../../src/server/db/pool.js";
import { leaseMs, runOneJob, startWorker, type Lane } from "../../src/server/jobs/worker.js";
import type { ExplainResult, LanguageAdapter } from "../../src/server/language/adapter.js";
import { recomputeCase, reportMissing } from "../../src/server/services/recovery.js";
import { spawn } from "node:child_process";
import { authorizedPurchase, checkout, setup, START, TEST_DB, type Harness } from "../integration/harness.js";

// Money runs on the core lane, model-bound jobs on the language lane; a held explanation never delays a payment job.
let h: Harness;
let original: LanguageAdapter;
beforeAll(async () => { h = await setup(); original = h.ctx.language; });
afterAll(async () => { await h.db.end(); });
beforeEach(() => { h.clock.set(START); });
afterEach(() => { h.ctx.language = original; });

/** A language adapter whose explanation waits until the test answers or fails it (one gate per call, in order). */
function heldExplanation() {
  const gates: { resolve: (r: ExplainResult) => void; reject: (e: unknown) => void }[] = [];
  h.ctx.language = { extractGoal: (a) => original.extractGoal(a), health: () => original.health(), explainChange: () => new Promise((resolve, reject) => gates.push({ resolve, reject })) };
  return {
    calls: () => gates.length,
    release: (i: number, summary: string) => gates[i]!.resolve({ status: "OK", summary, options: [], model: "fake-model", error: null }),
    fail: (i: number, e: unknown) => gates[i]!.reject(e),
  };
}
const explode = () => { h.ctx.language = { extractGoal: (a) => original.extractGoal(a), health: () => original.health(), async explainChange() { throw new Error("model exploded"); } }; };
const answered = (summary: string) => { h.ctx.language = { extractGoal: (a) => original.extractGoal(a), health: () => original.health(), async explainChange() { return { status: "OK", summary, options: [], model: "fake-model", error: null }; } }; };
const caseOf = (intentId: string) => one<any>(h.db, "select * from recovery_cases where intent_id=$1", [intentId]);
const explainJobOf = async (intentId: string) => { const rc = await caseOf(intentId); return maybeOne<any>(h.db, "select * from jobs where dedupe_key=$1", [`explain:${rc.id}:${rc.solve_run_id}`]); };
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 5000) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error("condition not met in time"); await new Promise((r) => setTimeout(r, 15)); } };
const drainLane = async (lane: Lane, owner = `test-${lane}`) => { let n = 0; while (await runOneJob(h.ctx, owner, lane)) if (++n > 300) throw new Error("lane did not drain"); return n; };
const openCase = async () => { const p = await authorizedPurchase(h, "A"); await reportMissing(h.ctx, p.session, { checkoutId: p.checkoutId, sku: "IF-2C-LB" }); return p; };
const keyOf = async (intentId: string) => { const rc = await caseOf(intentId); return `explain:${rc.id}:${rc.solve_run_id}`; };
/** Open a case whose explanation job is on its last attempt (four spent), with no other language job left to claim. */
const lastAttemptCase = async () => {
  const a = await openCase();
  const key = await keyOf(a.intentId);
  await h.db.query("update jobs set status='DONE', lease_owner=null, lease_until=null where kind='explain_case' and status in ('PENDING','RUNNING') and dedupe_key <> $1", [key]);
  await h.db.query("update jobs set attempts = 4 where dedupe_key = $1", [key]);
  return { a, key };
};
const poll = async <T,>(fn: () => Promise<T | null | undefined>, what: string, ms = 20_000, detail: () => string = () => "") => {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}${detail() ? `: ${detail()}` : ""}`); await new Promise((r) => setTimeout(r, 25)); }
};

describe("job lanes", () => {
  it("runs the hold release and a checkout reconciliation while an explanation is still waiting on the model", async () => {
    const held = heldExplanation();
    const a = await openCase();
    // The language runner takes the explanation and waits on the model.
    const explaining = runOneJob(h.ctx, "lang-1", "language");
    await waitFor(() => held.calls() === 1);
    expect(await explainJobOf(a.intentId)).toMatchObject({ status: "RUNNING", lease_owner: "lang-1" });
    // Meanwhile money work falls due: another purchase's hold passes its release deadline, and a reconciliation is requested.
    const b = await authorizedPurchase(h, "A");
    expect((await checkout(h, b.checkoutId)).payment_state).toBe("AUTHORIZED");
    h.clock.advanceMinutes(16);
    await enqueueJob(h.db, "reconcile_checkout", { checkoutId: b.checkoutId }, h.clock.now(), `lanes-reconcile:${b.checkoutId}`);
    const ran = await drainLane("core");
    expect(ran).toBeGreaterThan(0);
    expect((await checkout(h, b.checkoutId)).payment_state).toBe("VOIDED");
    expect((await one<any>(h.db, "select status from jobs where dedupe_key=$1", [`lanes-reconcile:${b.checkoutId}`])).status).toBe("DONE");
    // The model has still not answered, and the core lane never touched the language job (its lease had even expired).
    expect(held.calls()).toBe(1);
    expect(await explainJobOf(a.intentId)).toMatchObject({ status: "RUNNING", lease_owner: "lang-1" });
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: true, source: "template" });
    held.release(0, "Model text, after the money was settled.");
    await explaining;
    expect(await explainJobOf(a.intentId)).toMatchObject({ status: "DONE" });
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: false, source: "model", text: "Model text, after the money was settled." });
  });
  it("the core lane never claims a language job, and the language lane never claims a core job", async () => {
    answered("Quick model text.");
    const a = await openCase();
    await enqueueJob(h.db, "reconcile_checkout", { checkoutId: a.checkoutId }, h.clock.now(), `lanes-core-only:${a.checkoutId}`);
    await drainLane("core");
    expect(await explainJobOf(a.intentId)).toMatchObject({ status: "PENDING" });
    expect((await one<any>(h.db, "select status from jobs where dedupe_key=$1", [`lanes-core-only:${a.checkoutId}`])).status).toBe("DONE");
    await enqueueJob(h.db, "reconcile_checkout", { checkoutId: a.checkoutId }, h.clock.now(), `lanes-core-only-2:${a.checkoutId}`);
    expect(await drainLane("language")).toBe(1);
    expect(await explainJobOf(a.intentId)).toMatchObject({ status: "DONE" });
    expect((await one<any>(h.db, "select status from jobs where dedupe_key=$1", [`lanes-core-only-2:${a.checkoutId}`])).status).toBe("PENDING");
  });
  it("a language job whose runner died is taken over after its lease expires, clears pending, and the late runner cannot overwrite it", async () => {
    const held = heldExplanation();
    const a = await openCase();
    const dead = runOneJob(h.ctx, "lang-dead", "language");
    await waitFor(() => held.calls() === 1);
    // Nothing happens while the lease is valid.
    expect(await runOneJob(h.ctx, "lang-2", "language")).toBe(false);
    h.clock.advanceMinutes(Math.ceil(leaseMs(h.ctx, "language") / 60_000) + 1);
    const takeover = runOneJob(h.ctx, "lang-2", "language");
    await waitFor(() => held.calls() === 2);
    held.release(1, "Recovered after the restart.");
    expect(await takeover).toBe(true);
    expect(await explainJobOf(a.intentId)).toMatchObject({ status: "DONE", lease_owner: null });
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: false, source: "model", text: "Recovered after the restart." });
    // The runner that lost its lease finishes late: neither the case nor the job changes.
    held.release(0, "Late answer from the dead runner.");
    await dead;
    expect((await caseOf(a.intentId)).detail.explanation.text).toBe("Recovered after the restart.");
    expect(await explainJobOf(a.intentId)).toMatchObject({ status: "DONE", lease_owner: null });
  });
  it("a fresh process picks up a committed explanation job and clears pending", async () => {
    answered("Text from the process that started later.");
    const a = await openCase();
    expect(await explainJobOf(a.intentId)).toMatchObject({ status: "PENDING", attempts: 0 });
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: true });
    expect(await runOneJob(h.ctx, "after-restart", "language")).toBe(true);
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: false, source: "model", text: "Text from the process that started later." });
  });
  it("a runner that stops mid-job gives its lease back so the next process resumes at once", async () => {
    const held = heldExplanation();
    const a = await openCase();
    const worker = startWorker(h.ctx, { lane: "language", intervalMs: 20, owner: "lang-stopping" });
    await waitFor(() => held.calls() === 1);
    expect(await explainJobOf(a.intentId)).toMatchObject({ status: "RUNNING", lease_owner: "lang-stopping" });
    await worker.stop(100);
    expect(await explainJobOf(a.intentId)).toMatchObject({ status: "PENDING", lease_owner: null, lease_until: null });
    const next = runOneJob(h.ctx, "lang-next", "language");
    await waitFor(() => held.calls() === 2);
    held.release(1, "Resumed by the next process.");
    expect(await next).toBe(true);
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: false, text: "Resumed by the next process." });
    held.release(0, "Late answer from the stopped runner.");
    await new Promise((r) => setTimeout(r, 50));
    expect((await caseOf(a.intentId)).detail.explanation.text).toBe("Resumed by the next process.");
  });
});

describe("pending explanation and its job", () => {
  it("commit together: an enqueue failure leaves neither the pending state nor the job", async () => {
    answered("Text once the job could be queued.");
    const a = await authorizedPurchase(h, "A");
    await h.db.query("create or replace function lanes_fail_enqueue() returns trigger language plpgsql as $$ begin raise exception 'simulated enqueue failure'; end $$");
    await h.db.query("create trigger lanes_fail_enqueue before insert on jobs for each row when (new.kind = 'explain_case') execute function lanes_fail_enqueue()");
    try {
      await expect(reportMissing(h.ctx, a.session, { checkoutId: a.checkoutId, sku: "IF-2C-LB" })).rejects.toThrow(/simulated enqueue failure/);
      const rc = await caseOf(a.intentId);
      expect(rc.solve_run_id).toBeNull();
      expect(rc.detail.explanation).toBeUndefined();
      expect(await maybeOne(h.db, "select 1 from jobs where kind='explain_case' and payload->>'caseId'=$1", [rc.id])).toBeNull();
    } finally {
      await h.db.query("drop trigger if exists lanes_fail_enqueue on jobs");
      await h.db.query("drop function if exists lanes_fail_enqueue()");
    }
    // Once the queue accepts the job, both land, and the job settles the case.
    const rc = await caseOf(a.intentId);
    await recomputeCase(h.ctx, a.session, rc.id);
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: true, source: "template" });
    expect(await explainJobOf(a.intentId)).toMatchObject({ status: "PENDING" });
    await drainLane("language");
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: false, source: "model", text: "Text once the job could be queued." });
  });
  it("a job that fails for good settles the case: the template stays and pending is cleared with the error", async () => {
    h.ctx.language = { extractGoal: (a) => original.extractGoal(a), health: () => original.health(), async explainChange() { throw new Error("model exploded"); } };
    const a = await openCase();
    const templateText = (await caseOf(a.intentId)).detail.explanation.text;
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await runOneJob(h.ctx, "lang-x", "language")).toBe(true);
      const job = await explainJobOf(a.intentId);
      expect(job.attempts).toBe(attempt);
      expect(job.status).toBe(attempt < 5 ? "PENDING" : "FAILED");
      if (attempt < 5) expect((await caseOf(a.intentId)).detail.explanation.pending).toBe(true);
      h.clock.advanceMinutes(6);
    }
    expect(await runOneJob(h.ctx, "lang-x", "language")).toBe(false);
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: false, source: "template", model: null, error: expect.stringContaining("model exploded"), text: templateText });
  });
  it("an old explanation cannot overwrite a newer search result", async () => {
    const held = heldExplanation();
    const a = await openCase();
    const first = await caseOf(a.intentId);
    const run1 = runOneJob(h.ctx, "lang-1", "language");
    await waitFor(() => held.calls() === 1);
    // The buyer changes something: the case is searched again, with a new explanation job for the new result.
    await recomputeCase(h.ctx, a.session, first.id);
    const second = await caseOf(a.intentId);
    expect(second.solve_run_id).not.toBe(first.solve_run_id);
    expect(second.detail.explanation).toMatchObject({ pending: true, solveRunId: second.solve_run_id });
    held.release(0, "OLD text for the first search.");
    await run1;
    const after = await caseOf(a.intentId);
    expect(after.detail.explanation).toMatchObject({ pending: true, solveRunId: second.solve_run_id });
    expect(after.detail.explanation.text).not.toBe("OLD text for the first search.");
    const run2 = runOneJob(h.ctx, "lang-2", "language");
    await waitFor(() => held.calls() === 2);
    held.release(1, "NEW text for the second search.");
    await run2;
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: false, source: "model", text: "NEW text for the second search.", solveRunId: second.solve_run_id });
  });
});

describe("a job's last failed attempt and its cleanup", () => {
  it("a cleanup failure rolls back the FAILED state too, hands the job back, and a later runner fails it and settles the case in one commit", async () => {
    explode();
    const { a, key } = await lastAttemptCase();
    await h.db.query("create or replace function lanes_fail_cleanup() returns trigger language plpgsql as $$ begin raise exception 'simulated cleanup failure'; end $$");
    await h.db.query("create trigger lanes_fail_cleanup before update on recovery_cases for each row when ((old.detail->'explanation'->>'pending') = 'true' and (new.detail->'explanation'->>'pending') = 'false') execute function lanes_fail_cleanup()");
    try {
      expect(await runOneJob(h.ctx, "lang-cleanup", "language")).toBe(true);
      const job = await one<any>(h.db, "select * from jobs where dedupe_key=$1", [key]);
      expect(job).toMatchObject({ status: "PENDING", attempts: 5, lease_owner: null });
      expect(job.last_error).toMatch(/model exploded.*failure not recorded.*simulated cleanup failure/);
      expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: true, source: "template" });
    } finally {
      await h.db.query("drop trigger if exists lanes_fail_cleanup on recovery_cases");
      await h.db.query("drop function if exists lanes_fail_cleanup()");
    }
    // A restarted runner: the model still fails, so this time the job is failed for good and the case settled together.
    h.clock.advanceMinutes(2);
    expect(await runOneJob(h.ctx, "lang-restarted", "language")).toBe(true);
    expect(await one<any>(h.db, "select status, attempts, lease_owner from jobs where dedupe_key=$1", [key])).toMatchObject({ status: "FAILED", attempts: 6, lease_owner: null });
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: false, source: "template", model: null, error: expect.stringContaining("model exploded") });
  });

  it("a process killed between marking the job FAILED and settling the case commits neither; a restarted process recovers the job", async () => {
    explode();
    const { a, key } = await lastAttemptCase();
    const rc = await caseOf(a.intentId);
    // Hold the case row, so the other process stops inside its transaction: after its job update, before its cleanup.
    const locker = await h.db.connect();
    let blocked: number;
    let output = "";
    try {
      await locker.query("begin");
      await locker.query("select 1 from recovery_cases where id = $1 for update", [rc.id]);
      const child = spawn(process.execPath, ["--import", "tsx", "tests/jobs/crash-runner.ts"], { env: { ...process.env, TEST_DB, CLOCK: h.clock.now().toISOString(), OWNER: "killed-process" }, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (d) => { output += d; });
      child.stderr.on("data", (d) => { output += d; });
      const exited = new Promise((r) => child.on("exit", r));
      blocked = await poll(async () => (await h.db.query("select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'update recovery_cases%'")).rows[0]?.pid as number | undefined, "the other process to block in its cleanup", 30_000, () => output);
      child.kill("SIGKILL");
      await exited;
      await locker.query("rollback");
    } finally { locker.release(); }
    // PostgreSQL rolls the dead connection's transaction back; wait until its backend is gone.
    await poll(async () => ((await h.db.query("select 1 from pg_stat_activity where pid = $1", [blocked])).rowCount === 0 ? true : null), "the dead backend to exit", 15_000);
    expect(output).not.toMatch(/finished/);
    // Nothing from the killed transaction committed: still its RUNNING last attempt, and the case still waits.
    expect(await one<any>(h.db, "select status, attempts, lease_owner from jobs where dedupe_key=$1", [key])).toMatchObject({ status: "RUNNING", attempts: 5, lease_owner: "killed-process" });
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: true, source: "template" });
    // A restarted process takes the job over when the dead lease expires; the model answers this time.
    answered("Answered after the restart.");
    h.clock.advanceMinutes(7);
    expect(await runOneJob(h.ctx, "lang-after-restart", "language")).toBe(true);
    expect(await one<any>(h.db, "select status, attempts, lease_owner from jobs where dedupe_key=$1", [key])).toMatchObject({ status: "DONE", attempts: 6, lease_owner: null });
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: false, source: "model", text: "Answered after the restart." });
  });

  it("a runner whose lease was taken over and whose last attempt then fails changes nothing; the new owner's answer is saved", async () => {
    const held = heldExplanation();
    const { a, key } = await lastAttemptCase();
    const old = runOneJob(h.ctx, "lang-old", "language");
    await waitFor(() => held.calls() === 1);
    h.clock.advanceMinutes(Math.ceil(leaseMs(h.ctx, "language") / 60_000) + 1);
    const fresh = runOneJob(h.ctx, "lang-new", "language");
    await waitFor(() => held.calls() === 2);
    expect(await one<any>(h.db, "select status, attempts, lease_owner from jobs where dedupe_key=$1", [key])).toMatchObject({ status: "RUNNING", attempts: 6, lease_owner: "lang-new" });
    // The old runner's model call fails. By its own count this was the last attempt, but the job is no longer its own.
    held.fail(0, new Error("old runner's model call failed"));
    expect(await old).toBe(true);
    expect(await one<any>(h.db, "select status, lease_owner from jobs where dedupe_key=$1", [key])).toMatchObject({ status: "RUNNING", lease_owner: "lang-new" });
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: true });
    held.release(1, "Answer from the runner that took over.");
    expect(await fresh).toBe(true);
    expect(await one<any>(h.db, "select status from jobs where dedupe_key=$1", [key])).toMatchObject({ status: "DONE" });
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: false, source: "model", text: "Answer from the runner that took over." });
  });

  it("a last attempt that fails after a rerun was requested stays retryable and does not settle the case", async () => {
    const held = heldExplanation();
    const { a, key } = await lastAttemptCase();
    const fifth = runOneJob(h.ctx, "lang-5", "language");
    await waitFor(() => held.calls() === 1);
    // While the last attempt runs, the same explanation is requested again.
    const job = await one<any>(h.db, "select * from jobs where dedupe_key=$1", [key]);
    await enqueueJob(h.db, "explain_case", job.payload, h.clock.now(), key);
    expect((await one<any>(h.db, "select rerun_at from jobs where dedupe_key=$1", [key])).rerun_at).not.toBeNull();
    held.fail(0, new Error("last attempt failed"));
    expect(await fifth).toBe(true);
    expect(await one<any>(h.db, "select status, attempts, rerun_at, lease_owner from jobs where dedupe_key=$1", [key])).toMatchObject({ status: "PENDING", attempts: 5, rerun_at: null, lease_owner: null });
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: true });
    // The requested rerun runs at once, and its answer is saved.
    const sixth = runOneJob(h.ctx, "lang-6", "language");
    await waitFor(() => held.calls() === 2);
    held.release(1, "Answer from the requested rerun.");
    expect(await sixth).toBe(true);
    expect(await one<any>(h.db, "select status, attempts from jobs where dedupe_key=$1", [key])).toMatchObject({ status: "DONE", attempts: 6 });
    expect((await caseOf(a.intentId)).detail.explanation).toMatchObject({ pending: false, source: "model", text: "Answer from the requested rerun." });
  });
});
