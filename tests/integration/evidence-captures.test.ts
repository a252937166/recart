import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/server/http/app.js";
import { merchantConfirm } from "../../src/server/services/payments.js";
import { authorizedPurchase, drain, setup, START, type Harness } from "./harness.js";

// Signal Room review follow-up: "Captures completed" counted CAPTURE operations marked SUCCEEDED, but PayPal can accept
// a capture as PENDING, which is also recorded as a successful call. Only captures PayPal reports COMPLETED count.
let h: Harness;
let app: Awaited<ReturnType<typeof buildApp>>;
beforeAll(async () => { h = await setup(); app = await buildApp(h.ctx); });
afterAll(async () => { await app.close(); await h.db.end(); });
beforeEach(() => { h.clock.set(START); h.fake.captureStatus = "COMPLETED"; });
const live = async () => (await app.inject({ method: "GET", url: "/api/evidence" })).json().live;

describe("evidence: completed captures", () => {
  it("counts a capture PayPal accepted as pending only once it completes", async () => {
    const before = await live();
    const p = await authorizedPurchase(h);
    h.fake.captureStatus = "PENDING";
    const c = await merchantConfirm(h.ctx, p.session, p.checkoutId);
    expect(c.payment_state).toBe("CAPTURE_IN_FLIGHT");
    let now = await live();
    expect(now.captures).toBe(before.captures);
    expect(now.captures_pending).toBe(before.captures_pending + 1);

    h.fake.caps.get(c.capture_id!)!.status = "COMPLETED";
    h.clock.advanceMinutes(2);
    await drain(h);
    now = await live();
    expect(now.captures).toBe(before.captures + 1);
    expect(now.captures_pending).toBe(before.captures_pending);
  });

  it("counts a capture PayPal completes at once", async () => {
    const before = await live();
    const p = await authorizedPurchase(h);
    await merchantConfirm(h.ctx, p.session, p.checkoutId);
    const now = await live();
    expect(now.captures).toBe(before.captures + 1);
    expect(now.captures_pending).toBe(before.captures_pending);
  });
});
