import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { many, one } from "../../src/server/db/pool.js";
import { markHandedOver, merchantConfirm, reconcileCheckout, requestCancellation } from "../../src/server/services/payments.js";
import { authorizedPurchase, checkout, drain, setup, START, type Harness } from "./harness.js";

// Regressions for the three defects in "ReCart Independent Readiness Review 2026-10-09".
let h: Harness;
beforeAll(async () => { h = await setup(); });
afterAll(async () => { await h.db.end(); });
beforeEach(() => { h.clock.set(START); h.fake.captureStatus = "COMPLETED"; h.fake.refundStatus = "COMPLETED"; });

const reconcileJob = (checkoutId: string) => one<any>(h.db, "select status, run_at from jobs where dedupe_key=$1", [`reconcile:${checkoutId}`]);
const ticketState = async (checkoutId: string) => (await one<any>(h.db, "select state from fulfillment_tickets where checkout_id=$1", [checkoutId])).state;
const stockTotal = async (sessionId: string) => Number((await one<any>(h.db, "select sum(on_hand)::int n from inventory where session_id=$1", [sessionId])).n);

describe("R1 provider-pending polling keeps its next run", () => {
  it("a capture that stays pending for several polls is still reconciled when PayPal completes it", async () => {
    const p = await authorizedPurchase(h);
    h.fake.captureStatus = "PENDING";
    const c = await merchantConfirm(h.ctx, p.session, p.checkoutId);
    expect(c.payment_state).toBe("CAPTURE_IN_FLIGHT");
    for (let poll = 0; poll < 3; poll++) {
      h.clock.advanceMinutes(2);
      await drain(h);
      expect((await checkout(h, p.checkoutId)).payment_state).toBe("CAPTURE_IN_FLIGHT");
      const job = await reconcileJob(p.checkoutId);
      expect(job.status).toBe("PENDING"); // the follow-up poll survived the run that scheduled it
      expect(new Date(job.run_at).getTime()).toBeGreaterThan(h.clock.now().getTime());
    }
    h.fake.caps.get(c.capture_id!)!.status = "COMPLETED";
    h.clock.advanceMinutes(2);
    await drain(h);
    expect((await checkout(h, p.checkoutId)).payment_state).toBe("PAID");
    expect(await ticketState(p.checkoutId)).toBe("READY_FOR_HANDOFF");
  });

  it("a refund that stays pending for several polls still reaches REFUNDED", async () => {
    const p = await authorizedPurchase(h);
    await merchantConfirm(h.ctx, p.session, p.checkoutId);
    h.fake.refundStatus = "PENDING";
    await requestCancellation(h.ctx, p.checkoutId, "BUYER");
    const c = await checkout(h, p.checkoutId);
    expect(c.payment_state).toBe("REFUND_IN_FLIGHT");
    for (let poll = 0; poll < 3; poll++) {
      h.clock.advanceMinutes(6);
      await drain(h);
      expect((await checkout(h, p.checkoutId)).payment_state).toBe("REFUND_IN_FLIGHT");
      expect((await reconcileJob(p.checkoutId)).status).toBe("PENDING");
    }
    h.fake.refunds.get(c.refund_id!)!.status = "COMPLETED";
    h.clock.advanceMinutes(6);
    await drain(h);
    expect((await checkout(h, p.checkoutId)).payment_state).toBe("REFUNDED");
  });
});

describe("R2 a capture confirmed after release_by never releases goods", () => {
  it("capture starts 0.6 s before the deadline and its reply lands 0.6 s after: refunded, not handed over", async () => {
    const p = await authorizedPurchase(h);
    const releaseBy = p.checkout.release_by!.getTime();
    h.clock.set(new Date(releaseBy - 600));
    const original = h.fake.captureAuthorization.bind(h.fake);
    h.fake.captureAuthorization = async (...args: Parameters<typeof original>) => { const r = await original(...args); h.clock.set(new Date(releaseBy + 600)); return r; };
    try { await merchantConfirm(h.ctx, p.session, p.checkoutId); } finally { h.fake.captureAuthorization = original; }
    let c = await checkout(h, p.checkoutId);
    expect(c.cancel_intent).toBe("TIMEOUT");
    expect(await ticketState(p.checkoutId)).not.toBe("READY_FOR_HANDOFF");
    await drain(h);
    c = await checkout(h, p.checkoutId);
    expect(c.payment_state).toBe("REFUNDED");
    expect(c.capture_id).not.toBeNull(); // the late capture stays on record
    await expect(markHandedOver(h.ctx, p.session, p.checkoutId)).rejects.toMatchObject({ status: 409 });
    expect([...h.fake.refunds.values()].filter((r) => r.captureId === c.capture_id)).toHaveLength(1);
  });

  it("a pending capture that completes after release_by is refunded even if reconciliation runs before the deadline job", async () => {
    const p = await authorizedPurchase(h);
    const releaseBy = p.checkout.release_by!.getTime();
    h.clock.set(new Date(releaseBy - 600));
    h.fake.captureStatus = "PENDING";
    const c = await merchantConfirm(h.ctx, p.session, p.checkoutId);
    h.fake.caps.get(c.capture_id!)!.status = "COMPLETED";
    h.clock.set(new Date(releaseBy + 600));
    await reconcileCheckout(h.ctx, p.checkoutId); // e.g. a webhook-triggered reconcile wins the race with the deadline job
    const after = await checkout(h, p.checkoutId);
    expect(after.cancel_intent).toBe("TIMEOUT");
    expect(await ticketState(p.checkoutId)).not.toBe("READY_FOR_HANDOFF");
    await drain(h);
    expect((await checkout(h, p.checkoutId)).payment_state).toBe("REFUNDED");
  });

  it("a capture confirmed before release_by is kept: the pre-capture timer no longer cancels it", async () => {
    const p = await authorizedPurchase(h);
    h.clock.set(new Date(p.checkout.release_by!.getTime() - 600));
    await merchantConfirm(h.ctx, p.session, p.checkoutId);
    h.clock.advanceMinutes(5);
    await drain(h);
    const c = await checkout(h, p.checkoutId);
    expect(c.payment_state).toBe("PAID");
    expect(c.cancel_intent).toBeNull();
    expect(await ticketState(p.checkoutId)).toBe("READY_FOR_HANDOFF");
  });
});

describe("R3 a recovered capture consumes inventory at handoff", () => {
  it("lost capture reply -> reconciled PAID -> handoff reduces stock by the bundle", async () => {
    const p = await authorizedPurchase(h);
    const units = p.quote.data.lines.reduce((n: number, l: any) => n + l.qty, 0);
    const before = await stockTotal(p.session.id);
    h.paypal.dropNext("captureAuthorization");
    await merchantConfirm(h.ctx, p.session, p.checkoutId);
    h.clock.advanceMinutes(1);
    await drain(h);
    expect((await checkout(h, p.checkoutId)).payment_state).toBe("PAID");
    const held = await many<any>(h.db, "select status from reservations where checkout_id=$1", [p.checkoutId]);
    expect(held.every((r) => r.status === "COMMITTED")).toBe(true);
    await markHandedOver(h.ctx, p.session, p.checkoutId);
    expect(await stockTotal(p.session.id)).toBe(before - units);
    const done = await many<any>(h.db, "select status from reservations where checkout_id=$1", [p.checkoutId]);
    expect(done.every((r) => r.status === "FULFILLED")).toBe(true);
  });
});
