import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../../src/server/context.js";
import { one } from "../../src/server/db/pool.js";
import { startWorker } from "../../src/server/jobs/worker.js";
import { requestCancellation } from "../../src/server/services/payments.js";
import { authorizedPurchase, checkout, drain, opsOf, setup, START, type Harness } from "../integration/harness.js";

// A payment job that is running when the process shuts down: it gets its grace to finish and is then not handed back;
// if it is still running after the grace, it is handed back and running it again does no second PayPal operation.
let h: Harness;
let original: Ctx["paypal"];
let delayMs = 0;
beforeAll(async () => {
  h = await setup();
  original = h.ctx.paypal;
  // Every PayPal call waits delayMs first, so the reconciliation job below takes a known, real amount of time.
  h.ctx.paypal = new Proxy(original, { get(target, key) { const v = (target as any)[key]; return typeof v === "function" ? async (...args: unknown[]) => { if (delayMs) await new Promise((r) => setTimeout(r, delayMs)); return v.apply(target, args); } : v; } });
});
afterAll(async () => { h.ctx.paypal = original; await h.db.end(); });
beforeEach(() => { h.clock.set(START); delayMs = 0; });

const until = async (cond: () => Promise<boolean>, what: string, ms = 10_000) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 15)); } };
/** A purchase whose void reached PayPal but whose reply was lost: a reconciliation job must confirm it. */
async function unknownVoid() {
  const p = await authorizedPurchase(h);
  h.paypal.dropNext("voidAuthorization");
  await requestCancellation(h.ctx, p.checkoutId, "BUYER");
  expect((await checkout(h, p.checkoutId)).payment_state).toBe("STATUS_UNKNOWN");
  h.clock.advanceMinutes(1);
  return p;
}
const runningCoreJob = (owner: string) => one<any>(h.db, "select count(*)::int n from jobs where status = 'RUNNING' and lease_owner = $1", [owner]).then((r) => r.n > 0);

describe("a payment job running at shutdown", () => {
  it("finishes within the grace and is not handed back", async () => {
    const p = await unknownVoid();
    delayMs = 700;
    const w = startWorker(h.ctx, { lane: "core", intervalMs: 20, owner: "core-graceful" });
    await until(() => runningCoreJob("core-graceful"), "a running core job");
    const job = await one<any>(h.db, "select id from jobs where status = 'RUNNING' and lease_owner = 'core-graceful' limit 1");
    const t0 = Date.now();
    await w.stop(5000);
    const took = Date.now() - t0;
    // It waited for the job (at least one delayed PayPal call), not for the whole grace.
    expect(took).toBeGreaterThanOrEqual(300);
    expect(took).toBeLessThan(5000);
    expect(await one<any>(h.db, "select status, lease_owner from jobs where id = $1", [job.id])).toMatchObject({ status: "DONE", lease_owner: null });
    expect((await checkout(h, p.checkoutId)).payment_state).toBe("VOIDED");
    const voids = (await opsOf(h, p.checkoutId)).filter((o: any) => o.kind === "VOID");
    expect(voids).toHaveLength(1);
    expect(voids[0].status).toBe("SUCCEEDED");
  });

  it("is handed back if it outlasts the grace; its late finish changes nothing, and the rerun adds no second void", async () => {
    const p = await unknownVoid();
    delayMs = 1500;
    const w = startWorker(h.ctx, { lane: "core", intervalMs: 20, owner: "core-cut" });
    await until(() => runningCoreJob("core-cut"), "a running core job");
    const handedBefore = await one<any>(h.db, "select id, kind from jobs where status = 'RUNNING' and lease_owner = 'core-cut' limit 1");
    await w.stop(200);
    expect(await one<any>(h.db, "select status, lease_owner from jobs where id = $1", [handedBefore.id])).toMatchObject({ status: "PENDING", lease_owner: null });
    // The abandoned run is still going here. Let it finish: PayPal confirms the void, the checkout settles.
    await until(async () => (await checkout(h, p.checkoutId)).payment_state === "VOIDED", "the late run to settle the checkout");
    await new Promise((r) => setTimeout(r, 300));
    // Its own completion could not mark the job done: the lease was no longer its own.
    expect(await one<any>(h.db, "select status from jobs where id = $1", [handedBefore.id])).toMatchObject({ status: "PENDING" });
    // The next runner runs it again: a no-op, and still exactly one void.
    delayMs = 0;
    await drain(h);
    expect(await one<any>(h.db, "select status from jobs where id = $1", [handedBefore.id])).toMatchObject({ status: "DONE" });
    const voids = (await opsOf(h, p.checkoutId)).filter((o: any) => o.kind === "VOID");
    expect(voids).toHaveLength(1);
    expect(voids[0].status).toBe("SUCCEEDED");
    expect(h.fake.auths.get((await checkout(h, p.checkoutId)).authorization_id!)!.status).toBe("VOIDED");
  });
});
