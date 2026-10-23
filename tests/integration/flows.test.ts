import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { many, one, withTx } from "../../src/server/db/pool.js";
import { authorizeAfterApproval, markHandedOver, merchantConfirm, requestCancellation, startCheckout } from "../../src/server/services/payments.js";
import { acceptQuote } from "../../src/server/services/quotes.js";
import { cancelPurchase, reportMissing, selectCandidate, recomputeCase } from "../../src/server/services/recovery.js";
import { closeSession, loadSession } from "../../src/server/services/sessions.js";
import { confirmGoal } from "../../src/server/services/goals.js";
import { receivePayPalWebhook } from "../../src/server/services/webhooks.js";
import { referenceGoal } from "../../src/domain/catalog/fixtures.js";
import { acceptedQuote, authorizedPurchase, checkout, confirmReferenceGoal, drain, freshSession, FRIDAY_10AM_PT, opsOf, setup, START, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => { h = await setup(); });
afterAll(async () => { await h.db.end(); });
beforeEach(() => { h.clock.set(START); h.fake.captureStatus = "COMPLETED"; h.fake.refundStatus = "COMPLETED"; });

const caseOf = (intentId: string) => one<any>(h.db, "select * from recovery_cases where intent_id=$1 order by created_at desc limit 1", [intentId]);
const solveOf = (id: string) => one<any>(h.db, "select * from solve_runs where id=$1", [id]);

describe("A01 complete unchanged setup", () => {
  it("authorizes, captures the exact accepted total once, issues one ticket, and hands over", async () => {
    const p = await authorizedPurchase(h);
    expect(p.checkout.payment_state).toBe("AUTHORIZED");
    expect(p.checkout.release_by!.getTime() - START.getTime()).toBe(15 * 60_000); // test preset
    const after = await merchantConfirm(h.ctx, p.session, p.checkoutId);
    expect(after.payment_state).toBe("PAID");
    const ops = await opsOf(h, p.checkoutId);
    expect(ops.filter((o) => o.kind === "CAPTURE" && o.status === "SUCCEEDED")).toHaveLength(1);
    expect(h.fake.caps.get(after.capture_id!)!.amount).toBe("376.92");
    const t = await one<any>(h.db, "select state from fulfillment_tickets where checkout_id=$1", [p.checkoutId]);
    expect(t.state).toBe("READY_FOR_HANDOFF");
    await markHandedOver(h.ctx, p.session, p.checkoutId);
    const inv = await one<any>(h.db, "select on_hand from inventory where session_id=$1 and sku='IF-2C-LB'", [p.session.id]);
    expect(inv.on_hand).toBe(0);
  });
});

describe("A02/A03/A07 whole-bundle recovery (scenario A)", () => {
  it("voids the invalid hold, rebuilds with the adapter, and needs fresh consent and a new PayPal order", async () => {
    const p = await authorizedPurchase(h);
    const caseId = await reportMissing(h.ctx, p.session, { checkoutId: p.checkoutId, sku: "IF-2C-LB" });
    await drain(h);
    const old = await checkout(h, p.checkoutId);
    expect(old.payment_state).toBe("VOIDED");
    expect(h.fake.auths.get(old.authorization_id!)!.status).toBe("VOIDED");
    const rc = await caseOf(p.intentId);
    expect(rc.id).toBe(caseId);
    expect(rc.status).toBe("AWAITING_BUYER");
    const run = await solveOf(rc.solve_run_id);
    expect(run.status).toBe("FEASIBLE");
    const top = run.result.candidates[0];
    expect(top.totalCents).toBe(42228);
    expect(top.lines.map((l: any) => l.sku).sort()).toEqual(["ADP-AC", "CBL-BA-1", "CBL-XLR-3", "HP-CB-A", "IF-2B-LB", "MIC-DX-A", "STD-DK-A"]);
    expect(rc.detail.explanation.swaps.find((s: any) => s.sku === "IF-2C-NL").ok).toBe(false);
    // Retained microphones etc. are still held for this intent while the buyer decides.
    const held = await many<any>(h.db, "select sku, status, checkout_id from reservations where intent_id=$1 and status='RESERVED'", [p.intentId]);
    expect(held.every((r) => r.checkout_id === null)).toBe(true);
    // The old authorization is never reused: a new quote, new consent, and a new order are required.
    const q2 = await selectCandidate(h.ctx, p.session, { solveRunId: run.id, index: 0 });
    expect(q2.kind).toBe("REPLACEMENT");
    await expect(startCheckout(h.ctx, p.session, q2.id)).rejects.toMatchObject({ code: "quote_not_accepted" });
    await acceptQuote(h.db, { session: p.session, quoteId: q2.id, displayedHash: q2.hash });
    const co2 = await startCheckout(h.ctx, p.session, q2.id);
    expect(co2.orderId).not.toBe(p.orderId);
    h.fake.approve(co2.orderId!);
    await authorizeAfterApproval(h.ctx, p.session, co2.checkoutId, co2.orderId!);
    const paid = await merchantConfirm(h.ctx, p.session, co2.checkoutId);
    expect(paid.payment_state).toBe("PAID");
    expect(h.fake.caps.get(paid.capture_id!)!.amount).toBe("422.28");
    expect((await caseOf(p.intentId)).status).toBe("RESOLVED_RECOVERED");
    expect([...h.fake.caps.values()].filter((c) => c.authorizationId === old.authorization_id)).toHaveLength(0);
  });
});

describe("A04 decision needed (scenario B)", () => {
  it("stops on the budget, and only proceeds after the buyer revises the goal", async () => {
    const p = await authorizedPurchase(h, "B");
    await reportMissing(h.ctx, p.session, { checkoutId: p.checkoutId, sku: "IF-2C-LB" });
    await drain(h);
    let rc = await caseOf(p.intentId);
    let run = await solveOf(rc.solve_run_id);
    expect(run.status).toBe("NO_FEASIBLE_SUPPORTED_BUNDLE");
    expect(run.result.nearMisses[0].requires.budgetCents).toBe(42228);
    await expect(selectCandidate(h.ctx, p.session, { solveRunId: run.id, index: 0 })).rejects.toMatchObject({ code: "no_such_option" });
    await withTx(h.db, (tx) => confirmGoal(tx, { sessionId: p.session.id, intentId: p.intentId, goal: { ...referenceGoal(FRIDAY_10AM_PT), budgetCents: 42500 } as any, source: "test" }));
    await recomputeCase(h.ctx, p.session, rc.id);
    rc = await caseOf(p.intentId);
    run = await solveOf(rc.solve_run_id);
    expect(run.status).toBe("FEASIBLE");
    expect(run.result.candidates[0].totalCents).toBe(42228);
  });
});

describe("A06 unable to fulfill (scenario C)", () => {
  it("completes the search, voids the authorization, and closes without a charge", async () => {
    const p = await authorizedPurchase(h, "C");
    await reportMissing(h.ctx, p.session, { checkoutId: p.checkoutId, sku: "IF-2C-LB" });
    await drain(h);
    const rc = await caseOf(p.intentId);
    const run = await solveOf(rc.solve_run_id);
    expect(run.status).toBe("NO_FEASIBLE_SUPPORTED_BUNDLE");
    expect(run.result.nearMisses).toHaveLength(0);
    expect((await checkout(h, p.checkoutId)).payment_state).toBe("VOIDED");
    await cancelPurchase(h.ctx, p.session, "no_supported_solution");
    expect((await caseOf(p.intentId)).status).toBe("CLOSED_NO_SOLUTION");
    const held = await many(h.db, "select 1 from reservations where intent_id=$1 and status in ('RESERVED','COMMITTED','FROZEN')", [p.intentId]);
    expect(held).toHaveLength(0);
    expect(h.fake.caps.size === 0 || ![...h.fake.caps.values()].some((c) => c.authorizationId === (p.checkout.authorization_id as string))).toBe(true);
  });
});

describe("A08 expired quote", () => {
  it("rejects acceptance after the five-minute window", async () => {
    const { session, intentId } = await freshSession(h);
    await confirmReferenceGoal(h, session, intentId);
    const { runSolve } = await import("../../src/server/services/solving.js");
    const run = await runSolve(h.db, { sessionId: session.id, intentId, purpose: "initial" });
    const q = await selectCandidate(h.ctx, session, { solveRunId: run.id, index: 0 });
    h.clock.advanceMinutes(6);
    await expect(acceptQuote(h.db, { session, quoteId: q.id, displayedHash: q.hash })).rejects.toMatchObject({ code: "quote_expired" });
  });
  it("rejects consent when the displayed hash differs", async () => {
    const { session, intentId } = await freshSession(h);
    await confirmReferenceGoal(h, session, intentId);
    const { runSolve } = await import("../../src/server/services/solving.js");
    const run = await runSolve(h.db, { sessionId: session.id, intentId, purpose: "initial" });
    const q = await selectCandidate(h.ctx, session, { solveRunId: run.id, index: 0 });
    await expect(acceptQuote(h.db, { session, quoteId: q.id, displayedHash: "0".repeat(64) })).rejects.toMatchObject({ code: "quote_mismatch" });
  });
});

describe("A09/A10 stale and duplicate callbacks", () => {
  it("does not authorize an approval for a checkout that was closed", async () => {
    const { session, intentId } = await freshSession(h);
    await confirmReferenceGoal(h, session, intentId);
    const q = await acceptedQuote(h, session, intentId);
    const co = await startCheckout(h.ctx, session, q.id);
    await reportMissing(h.ctx, session, { checkoutId: co.checkoutId, sku: "IF-2C-LB" });
    h.fake.approve(co.orderId!);
    const before = h.fake.calls.length;
    await expect(authorizeAfterApproval(h.ctx, session, co.checkoutId, co.orderId!)).rejects.toMatchObject({ status: 409 });
    expect(h.fake.calls.slice(before).filter((c) => c === "authorizeOrder")).toHaveLength(0);
    expect((await checkout(h, co.checkoutId)).payment_state).toBe("CLOSED_NO_PAYMENT");
  });
  it("reuses the attempt on a double click and ignores a duplicate approval callback", async () => {
    const { session, intentId } = await freshSession(h);
    await confirmReferenceGoal(h, session, intentId);
    const q = await acceptedQuote(h, session, intentId);
    const a = await startCheckout(h.ctx, session, q.id);
    const b = await startCheckout(h.ctx, session, q.id);
    expect(b.checkoutId).toBe(a.checkoutId);
    h.fake.approve(a.orderId!);
    const before = h.fake.calls.length;
    await authorizeAfterApproval(h.ctx, session, a.checkoutId, a.orderId!);
    await authorizeAfterApproval(h.ctx, session, a.checkoutId, a.orderId!);
    expect(h.fake.calls.slice(before).filter((c) => c === "authorizeOrder")).toHaveLength(1);
  });
});

describe("A11/A12/A15 lost responses are recovered, never repeated", () => {
  it("A11: lost authorization response -> reconcile finds the authorization", async () => {
    const { session, intentId } = await freshSession(h);
    await confirmReferenceGoal(h, session, intentId);
    const q = await acceptedQuote(h, session, intentId);
    const co = await startCheckout(h.ctx, session, q.id);
    h.fake.approve(co.orderId!);
    h.paypal.dropNext("authorizeOrder");
    const c = await authorizeAfterApproval(h.ctx, session, co.checkoutId, co.orderId!);
    expect(c.payment_state).toBe("STATUS_UNKNOWN");
    h.clock.advanceMinutes(1);
    await drain(h);
    const after = await checkout(h, co.checkoutId);
    expect(after.payment_state).toBe("AUTHORIZED");
    expect([...h.fake.auths.values()].filter((a) => a.orderId === co.orderId)).toHaveLength(1);
  });
  it("A12: lost capture response -> same request ID returns the same capture; receipt once", async () => {
    const p = await authorizedPurchase(h);
    h.paypal.dropNext("captureAuthorization");
    const c = await merchantConfirm(h.ctx, p.session, p.checkoutId);
    expect(c.payment_state).toBe("STATUS_UNKNOWN");
    const frozen = await many<any>(h.db, "select status from reservations where checkout_id=$1", [p.checkoutId]);
    expect(frozen.every((r) => r.status === "FROZEN")).toBe(true); // A21: frozen while capture is unknown
    h.clock.advanceMinutes(1);
    await drain(h);
    const after = await checkout(h, p.checkoutId);
    expect(after.payment_state).toBe("PAID");
    expect([...h.fake.caps.values()].filter((x) => x.authorizationId === after.authorization_id)).toHaveLength(1);
    const tickets = await many(h.db, "select 1 from fulfillment_tickets where checkout_id=$1", [p.checkoutId]);
    expect(tickets).toHaveLength(1);
  });
  it("A15: lost void response -> confirm the resource before allowing a replacement", async () => {
    const p = await authorizedPurchase(h);
    h.paypal.dropNext("voidAuthorization");
    await requestCancellation(h.ctx, p.checkoutId, "BUYER");
    expect((await checkout(h, p.checkoutId)).payment_state).toBe("STATUS_UNKNOWN");
    h.clock.advanceMinutes(1);
    await drain(h);
    expect((await checkout(h, p.checkoutId)).payment_state).toBe("VOIDED");
  });
});

describe("A13/A16 provider-pending results", () => {
  it("A13: a pending capture never releases fulfillment until it completes", async () => {
    const p = await authorizedPurchase(h);
    h.fake.captureStatus = "PENDING";
    const c = await merchantConfirm(h.ctx, p.session, p.checkoutId);
    expect(c.payment_state).toBe("CAPTURE_IN_FLIGHT");
    expect(await many(h.db, "select 1 from fulfillment_tickets where checkout_id=$1", [p.checkoutId])).toHaveLength(0);
    h.fake.caps.get(c.capture_id!)!.status = "COMPLETED";
    h.clock.advanceMinutes(2);
    await drain(h);
    expect((await checkout(h, p.checkoutId)).payment_state).toBe("PAID");
  });
  it("A16: a pending refund stays visible and blocks replacement payment", async () => {
    const p = await authorizedPurchase(h);
    await merchantConfirm(h.ctx, p.session, p.checkoutId);
    h.fake.refundStatus = "PENDING";
    await requestCancellation(h.ctx, p.checkoutId, "BUYER");
    const c = await checkout(h, p.checkoutId);
    expect(c.payment_state).toBe("REFUND_IN_FLIGHT");
    expect(c.terminal).toBe(false);
    const t = await one<any>(h.db, "select state from fulfillment_tickets where checkout_id=$1", [p.checkoutId]);
    expect(t.state).toBe("BLOCKED");
  });
});

describe("A14/A20 cancellation and deadlines around capture", () => {
  it("A14: cancellation while capture outcome is unknown -> late capture is refunded, never handed over", async () => {
    const p = await authorizedPurchase(h);
    h.paypal.dropNext("captureAuthorization");
    await merchantConfirm(h.ctx, p.session, p.checkoutId);
    await requestCancellation(h.ctx, p.checkoutId, "BUYER");
    h.clock.advanceMinutes(1);
    await drain(h);
    const c = await checkout(h, p.checkoutId);
    expect(c.payment_state).toBe("REFUNDED");
    const t = await one<any>(h.db, "select state from fulfillment_tickets where checkout_id=$1", [p.checkoutId]);
    expect(["BLOCKED", "CANCELED"]).toContain(t.state);
    await expect(markHandedOver(h.ctx, p.session, p.checkoutId)).rejects.toMatchObject({ status: 409 });
  });
  it("A20/A27: the merchant-confirmation deadline voids an unconfirmed hold", async () => {
    const p = await authorizedPurchase(h);
    h.clock.advanceMinutes(16);
    await drain(h);
    const c = await checkout(h, p.checkoutId);
    expect(c.payment_state).toBe("VOIDED");
    expect(c.cancel_intent).toBe("TIMEOUT");
    await expect(merchantConfirm(h.ctx, p.session, p.checkoutId)).rejects.toMatchObject({ status: 409 });
  });
  it("A20: approval window expiry closes the attempt without money", async () => {
    const { session, intentId } = await freshSession(h);
    await confirmReferenceGoal(h, session, intentId);
    const q = await acceptedQuote(h, session, intentId);
    const co = await startCheckout(h.ctx, session, q.id);
    h.clock.advanceMinutes(16);
    await drain(h);
    expect((await checkout(h, co.checkoutId)).payment_state).toBe("CLOSED_NO_PAYMENT");
    h.fake.approve(co.orderId!);
    await expect(authorizeAfterApproval(h.ctx, session, co.checkoutId, co.orderId!)).rejects.toMatchObject({ status: 409 });
  });
});

describe("A17/A18 webhooks", () => {
  const body = (id: string, resourceId: string) => JSON.stringify({ id, event_type: "PAYMENT.CAPTURE.COMPLETED", resource_type: "capture", resource: { id: resourceId, status: "COMPLETED" } });
  it("A18: a forged event is quarantined and moves nothing", async () => {
    const r = await receivePayPalWebhook(h.ctx, { "paypal-transmission-sig": "forged" }, body("WH-EVT-FORGED", "X"));
    expect(r.status).toBe(400);
    const row = await one<any>(h.db, "select verification, status from webhook_events where event_id='WH-EVT-FORGED'");
    expect(row).toMatchObject({ verification: "FAILURE", status: "QUARANTINED" });
  });
  it("A17: duplicates are harmless", async () => {
    const p = await authorizedPurchase(h);
    const c = await merchantConfirm(h.ctx, p.session, p.checkoutId);
    const first = await receivePayPalWebhook(h.ctx, { "paypal-transmission-sig": "valid-signature" }, body("WH-EVT-1", c.capture_id!));
    const second = await receivePayPalWebhook(h.ctx, { "paypal-transmission-sig": "valid-signature" }, body("WH-EVT-1", c.capture_id!));
    expect(first.body.status).toBe("PROCESSED");
    expect(second.body.duplicate).toBe(true);
    await drain(h);
    expect((await checkout(h, p.checkoutId)).payment_state).toBe("PAID");
  });
});

describe("A28 demo reset fences the old session", () => {
  it("a late approval for a closing session is not authorized", async () => {
    const { session, intentId } = await freshSession(h);
    await confirmReferenceGoal(h, session, intentId);
    const q = await acceptedQuote(h, session, intentId);
    const co = await startCheckout(h.ctx, session, q.id);
    await closeSession(h.ctx, session.id);
    const closing = (await loadSession(h.db, session.id))!;
    h.fake.approve(co.orderId!);
    await expect(authorizeAfterApproval(h.ctx, closing, co.checkoutId, co.orderId!)).rejects.toMatchObject({ code: "session_closing" });
  });
});

describe("A30 stock change during quote review", () => {
  it("revalidation at checkout supersedes the stale quote", async () => {
    const { session, intentId } = await freshSession(h);
    await confirmReferenceGoal(h, session, intentId);
    const q = await acceptedQuote(h, session, intentId);
    await h.db.query("update inventory set on_hand=0 where session_id=$1 and sku='IF-2C-LB'", [session.id]);
    await expect(startCheckout(h.ctx, session, q.id)).rejects.toMatchObject({ code: "quote_invalid" });
    expect((await one<any>(h.db, "select status from quotes where id=$1", [q.id])).status).toBe("SUPERSEDED");
  });
});

describe("A22/S07 ownership-aware stock", () => {
  it("only one of two intents gets the last unit; recovery keeps this intent's own microphones", async () => {
    const p = await authorizedPurchase(h);
    // A second intent in the same store competes for the remaining stock.
    const { randomUUID } = await import("node:crypto");
    const other = randomUUID();
    await h.db.query("insert into intents(id,session_id) values ($1,$2)", [other, p.session.id]);
    const { availabilityFor } = await import("../../src/server/services/inventory.js");
    const forOther = await availabilityFor(h.db, p.session.id, other);
    expect(forOther["IF-2C-LB"]).toBe(0); // the only unit is reserved by the first intent
    expect(forOther["MIC-DX-A"]).toBe(2); // 4 on hand, 2 reserved by the first intent
    await reportMissing(h.ctx, p.session, { checkoutId: p.checkoutId, sku: "IF-2C-LB" });
    await drain(h);
    const mine = await availabilityFor(h.db, p.session.id, p.intentId);
    expect(mine["MIC-DX-A"]).toBe(4); // own retained units count for this intent's recovery
    const theirs = await availabilityFor(h.db, p.session.id, other);
    expect(theirs["MIC-DX-A"]).toBe(2); // and are still excluded for the other intent
  });
});
