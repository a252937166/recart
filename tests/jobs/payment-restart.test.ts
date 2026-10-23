import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueJob } from "../../src/server/context.js";
import { one, withTx } from "../../src/server/db/pool.js";
import { runOneJob, startWorker } from "../../src/server/jobs/worker.js";
import { merchantConfirm, reconcileCheckout, runOperation, type OpRow } from "../../src/server/services/payments.js";
import { authorizedPurchase, checkout, drain, setup, START, type Harness } from "../integration/harness.js";

// Real PostgreSQL and the real worker/payment services; PayPal is simulated. No webhook or browser wakes the job.
let h: Harness;
let refund: Harness["fake"]["refundCapture"];
beforeAll(async () => { h = await setup(); refund = h.fake.refundCapture.bind(h.fake); });
afterAll(async () => { await h.db.end(); });
beforeEach(async () => {
  h.clock.set(START);
  h.fake.refundCapture = refund;
  await h.db.query("update jobs set status='DONE', lease_owner=null, lease_until=null where status <> 'DONE'");
});

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > ms) throw new Error("refund did not enter the provider"); await new Promise((r) => setTimeout(r, 5)); }
};

/** An already-paid, unfulfilled purchase with a durable refund operation queued for its worker. */
async function queuedRefund() {
  const p = await authorizedPurchase(h);
  await merchantConfirm(h.ctx, p.session, p.checkoutId);
  await drain(h);
  const c = await checkout(h, p.checkoutId);
  expect(c.payment_state).toBe("PAID");
  const id = randomUUID(), requestId = randomUUID(), payload = { captureId: c.capture_id };
  await withTx(h.db, async (tx) => {
    await tx.query("update checkouts set payment_state='REFUND_IN_FLIGHT', cancel_intent='BUYER' where id=$1", [c.id]);
    await tx.query("update fulfillment_tickets set state='BLOCKED' where checkout_id=$1", [c.id]);
    await tx.query("insert into payment_operations(id,checkout_id,kind,request_id,payload_hash,payload,status,created_at,updated_at) values ($1,$2,'REFUND',$3,$4,$5,'PENDING',$6,$6)",
      [id, c.id, requestId, createHash("sha256").update(JSON.stringify(payload)).digest("hex"), JSON.stringify(payload), h.clock.now()]);
    await enqueueJob(tx, "run_operation", { opId: id }, h.clock.now(), `op:${id}`);
  });
  return {
    ...p, id, requestId, payload, captureId: c.capture_id,
    op: () => one<OpRow>(h.db, "select * from payment_operations where id=$1", [id]),
    job: () => one<any>(h.db, "select * from jobs where dedupe_key=$1", [`op:${id}`]),
  };
}

/** PayPal executes the first request, but its reply is held as if the original process lost it. */
function heldReply() {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const requests: { captureId: string; requestId: string; body: unknown }[] = [];
  h.fake.refundCapture = async (captureId, body, requestId) => {
    requests.push({ captureId, requestId, body });
    const response = await refund(captureId, body, requestId);
    if (requests.length === 1) await held;
    return response;
  };
  return { requests, release };
}

describe("unfinished payments across an immediate restart", () => {
  it("hands a running refund back, keeps its retry beyond the exact fence, and replays the same request once without a webhook", async () => {
    const p = await queuedRefund();
    const held = heldReply();
    const old = startWorker(h.ctx, { lane: "core", owner: "old-core", intervalMs: 10 });
    try {
      await waitFor(() => held.requests.length === 1);
      expect(await p.op()).toMatchObject({ status: "IN_FLIGHT", attempts: 1 });
      expect(await p.job()).toMatchObject({ status: "RUNNING", lease_owner: "old-core" });
      await old.stop(20);
      expect(await p.job()).toMatchObject({ status: "PENDING", lease_owner: null });

      expect(await runOneJob(h.ctx, "replacement", "core")).toBe(true);
      const retry = await p.job();
      expect(retry.status).toBe("PENDING");
      expect(new Date(retry.run_at).getTime()).toBe(START.getTime() + 60_001);
      expect(await p.op()).toMatchObject({ status: "IN_FLIGHT", request_id: p.requestId, attempts: 1 });
      expect((await h.db.query("select 1 from jobs where kind='reconcile_checkout' and status in ('PENDING','RUNNING') and payload->>'checkoutId'=$1", [p.checkoutId])).rowCount).toBe(0);

      for (const elapsed of [59_999, 60_000]) {
        h.clock.set(new Date(START.getTime() + elapsed));
        expect(await runOneJob(h.ctx, "replacement", "core")).toBe(false);
        await runOperation(h.ctx, p.id); // A concurrent caller must also respect the fence, including equality.
        expect(held.requests).toHaveLength(1);
      }
      h.clock.set(new Date(START.getTime() + 60_001));
      expect(await runOneJob(h.ctx, "replacement", "core")).toBe(true);
      expect(await p.op()).toMatchObject({ status: "SUCCEEDED", request_id: p.requestId, payload: p.payload, attempts: 2 });
      expect(await p.job()).toMatchObject({ status: "DONE", lease_owner: null });
      expect((await checkout(h, p.checkoutId)).payment_state).toBe("REFUNDED");
      expect(held.requests.map((r) => r.requestId)).toEqual([p.requestId, p.requestId]);
      expect([...h.fake.refunds.values()].filter((r) => r.captureId === p.captureId)).toHaveLength(1);
      expect((await h.db.query("select 1 from payment_operations where checkout_id=$1 and kind='REFUND'", [p.checkoutId])).rowCount).toBe(1);
    } finally { held.release(); await old.stop(1000); h.fake.refundCapture = refund; }
  });

  it("a synchronous original call and concurrent fresh skips leave one future job, then a late success makes that job a harmless no-op", async () => {
    const p = await queuedRefund();
    const held = heldReply();
    const original = runOperation(h.ctx, p.id);
    try {
      await waitFor(() => held.requests.length === 1);
      await Promise.all([runOperation(h.ctx, p.id), runOneJob(h.ctx, "replacement", "core")]);
      expect(await p.job()).toMatchObject({ status: "PENDING", rerun_at: null });
      expect(new Date((await p.job()).run_at).getTime()).toBe(START.getTime() + 60_001);
      expect(await drain(h)).toBe(0); // No busy loop while the original call still runs.
      expect((await h.db.query("select 1 from jobs where dedupe_key=$1", [`op:${p.id}`])).rowCount).toBe(1);
      held.release();
      await original;
      expect(await p.op()).toMatchObject({ status: "SUCCEEDED", attempts: 1 });
      h.clock.set(new Date(START.getTime() + 60_001));
      await drain(h);
      expect(await p.job()).toMatchObject({ status: "DONE" });
      expect(held.requests).toHaveLength(1);
      expect((await checkout(h, p.checkoutId)).payment_state).toBe("REFUNDED");
    } finally { held.release(); await original; h.fake.refundCapture = refund; }
  });

  it("a resumed job and reconciliation racing after the fence still produce only one refund", async () => {
    const p = await queuedRefund();
    const held = heldReply();
    const original = runOperation(h.ctx, p.id);
    try {
      await waitFor(() => held.requests.length === 1);
      await runOneJob(h.ctx, "replacement", "core");
      h.clock.set(new Date(START.getTime() + 60_001));
      await Promise.all([runOneJob(h.ctx, "replacement", "core"), reconcileCheckout(h.ctx, p.checkoutId)]);
      expect(await p.op()).toMatchObject({ status: "SUCCEEDED", request_id: p.requestId, attempts: 2 });
      expect((await checkout(h, p.checkoutId)).payment_state).toBe("REFUNDED");
      expect([...h.fake.refunds.values()].filter((r) => r.captureId === p.captureId)).toHaveLength(1);
      expect(held.requests.map((r) => r.requestId)).toEqual([p.requestId, p.requestId]);
      // A loser may have scheduled a retry before the winner finished. It must become a no-op, not a new refund.
      h.clock.advanceMinutes(2);
      await drain(h);
      expect(await p.job()).toMatchObject({ status: "DONE" });
      expect(held.requests).toHaveLength(2);
    } finally { held.release(); await original; h.fake.refundCapture = refund; }
  });

  it.each(["SUCCEEDED", "FAILED"])("does not reschedule a %s operation", async (status) => {
    const p = await queuedRefund();
    await h.db.query("update payment_operations set status=$2 where id=$1", [p.id, status]);
    const calls = h.fake.calls.filter((c) => c === "refundCapture").length;
    expect(await runOneJob(h.ctx, "replacement", "core")).toBe(true);
    expect(await p.job()).toMatchObject({ status: "DONE", rerun_at: null });
    expect(h.fake.calls.filter((c) => c === "refundCapture")).toHaveLength(calls);
  });

  it("does not create a retry for an operation that does not exist", async () => {
    const id = randomUUID();
    await runOperation(h.ctx, id);
    expect((await h.db.query("select 1 from jobs where dedupe_key=$1", [`op:${id}`])).rowCount).toBe(0);
  });
});
