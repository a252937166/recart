import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSession } from "../../src/server/services/sessions.js";
import { sessionState } from "../../src/server/services/views.js";
import { reportMissing, selectCandidate, cancelPurchase } from "../../src/server/services/recovery.js";
import { acceptQuote } from "../../src/server/services/quotes.js";
import { authorizeAfterApproval, markHandedOver, merchantConfirm, startCheckout } from "../../src/server/services/payments.js";
import { authorizedPurchase, confirmReferenceGoal, drain, freshSession, setup, START, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => { h = await setup(); });
afterAll(async () => { await h.db.end(); });
beforeEach(() => { h.clock.set(START); h.fake.captureStatus = "COMPLETED"; });

const stageOf = async (sessionId: string) => (await sessionState(h.ctx, (await loadSession(h.db, sessionId))!)).stage;

describe("guided demo stage model", () => {
  it("scenario A walks requirements → quote → approval → store check → review → reapproval → confirm → recovered", async () => {
    const { session, intentId } = await freshSession(h, "A");
    let st = await stageOf(session.id);
    expect(st.current).toMatchObject({ id: "requirements", actor: "buyer", view: "buyer" });
    expect(st.stages.map((s) => s.id)).toEqual(["requirements", "quote", "approval", "store_check", "review", "reapproval", "confirm"]);
    await confirmReferenceGoal(h, session, intentId);
    expect((await stageOf(session.id)).current?.id).toBe("quote");
    const p = await authorizedPurchase(h, "A");
    st = await stageOf(p.session.id);
    expect(st.current).toMatchObject({ id: "store_check", actor: "store", view: "store" });
    await reportMissing(h.ctx, p.session, { checkoutId: p.checkoutId, sku: "IF-2C-LB" });
    await drain(h);
    st = await stageOf(p.session.id);
    expect(st.current).toMatchObject({ id: "review", view: "buyer" });
    const state = await sessionState(h.ctx, (await loadSession(h.db, p.session.id))!);
    const quote = await selectCandidate(h.ctx, p.session, { solveRunId: state.recoveryCase!.solve.id, index: 0 });
    await acceptQuote(h.db, { session: p.session, quoteId: quote.id, displayedHash: quote.hash });
    expect((await stageOf(p.session.id)).current?.id).toBe("reapproval");
    const co = await startCheckout(h.ctx, p.session, quote.id);
    h.fake.approve(co.orderId!);
    await authorizeAfterApproval(h.ctx, p.session, co.checkoutId, co.orderId!);
    expect((await stageOf(p.session.id)).current).toMatchObject({ id: "confirm", view: "store" });
    await merchantConfirm(h.ctx, p.session, co.checkoutId);
    await markHandedOver(h.ctx, p.session, co.checkoutId);
    st = await stageOf(p.session.id);
    expect(st.current).toBeNull();
    expect(st.ending?.kind).toBe("recovered");
    expect(st.stages.every((s) => s.status === "done")).toBe(true);
  });

  it("scenario C ends closed with nothing charged", async () => {
    const p = await authorizedPurchase(h, "C");
    await reportMissing(h.ctx, p.session, { checkoutId: p.checkoutId, sku: "IF-2C-LB" });
    await drain(h);
    expect((await stageOf(p.session.id)).current?.id).toBe("no_solution");
    await cancelPurchase(h.ctx, p.session, "no_supported_solution");
    const st = await stageOf(p.session.id);
    expect(st.current).toBeNull();
    expect(st.ending?.kind).toBe("closed_no_solution");
  });
});
