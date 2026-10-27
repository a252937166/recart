import { describe, expect, it } from "vitest";
import { PayPalStartError, startFailureText, startPayPal, stepLabel, type PayPalAuth, type PayPalSdk, type PayPalStep } from "../../src/web/lib/paypal.js";

// The checkout button starts PayPal's SDK in three steps. A request that never answers used to leave the page on
// "Loading PayPal Sandbox…" for good; each step now has a deadline and the page names the step that stopped.
const never = <T>() => new Promise<T>(() => {});
const sdk = (eligible = true, eligibility?: () => Promise<{ isEligible(m: string): boolean }>): PayPalSdk => ({
  findEligibleMethods: eligibility ?? (async () => ({ isEligible: (m) => eligible && m === "paypal" })),
  createPayPalOneTimePaymentSession: () => ({ start: async () => {} }),
});
const sdkError = (code: string) => Object.assign(new Error("sdk said no"), { code });

function start(over: { loadScript?: () => Promise<any>; createInstance?: (o: Record<string, unknown>) => Promise<PayPalSdk>; clientToken?: () => Promise<string>; auth?: PayPalAuth } = {}) {
  const steps: PayPalStep[] = [];
  const created: Record<string, unknown>[] = [];
  const createInstance = over.createInstance ?? (async () => sdk());
  const result = startPayPal({
    loadScript: over.loadScript ?? (async () => ({ createInstance: (o: Record<string, unknown>) => { created.push(o); return createInstance(o); } })),
    clientId: "client-id",
    clientToken: over.clientToken ?? (async () => "client-token"),
    ...(over.auth ? { auth: over.auth } : {}),
    onStep: (s) => steps.push(s),
    stepMs: 40,
  });
  return { result, steps, created };
}

const failureOf = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a failure"); }, (e) => e as PayPalStartError);

describe("starting PayPal's SDK", () => {
  it("runs the three steps and resolves to an instance", async () => {
    const run = start();
    await expect(run.result).resolves.toHaveProperty("createPayPalOneTimePaymentSession");
    expect(run.steps).toEqual(["script", "connect", "eligibility"]);
    expect(run.created).toEqual([{ clientId: "client-id", components: ["paypal-payments"], pageType: "checkout" }]);
  });

  it("stops each stalled step at its deadline and says which step it was", async () => {
    const stalledScript = await failureOf(start({ loadScript: never }).result);
    expect([stalledScript.step, stalledScript.kind]).toEqual(["script", "timeout"]);
    const stalledConnect = await failureOf(start({ createInstance: never }).result);
    expect([stalledConnect.step, stalledConnect.kind]).toEqual(["connect", "timeout"]);
    const stalledEligibility = await failureOf(start({ createInstance: async () => sdk(true, never) }).result);
    expect([stalledEligibility.step, stalledEligibility.kind]).toEqual(["eligibility", "timeout"]);
  });

  it("does not retry a refused client ID in the same document's potentially poisoned SDK", async () => {
    const run = start({ createInstance: async (o) => { if (o.clientId) throw sdkError("ERR_INVALID_CLIENT_ID"); return sdk(); } });
    const e = await failureOf(run.result);
    expect(e.code).toBe("ERR_INVALID_CLIENT_ID");
    expect(run.created.map((o) => Object.keys(o)[0])).toEqual(["clientId"]);
  });

  it("keeps a fresh document's token attempt inside the connect deadline", async () => {
    const run = start({ auth: "client-token", createInstance: async () => never<PayPalSdk>() });
    const e = await failureOf(run.result);
    expect([e.step, e.kind]).toEqual(["connect", "timeout"]);
  });

  it("reports the SDK's error code when a step fails outright", async () => {
    const blocked = await failureOf(start({ createInstance: async () => { throw sdkError("ERR_DEV_SCRIPT_LOAD_FAILED"); } }).result);
    expect([blocked.step, blocked.kind, blocked.code]).toEqual(["connect", "failed", "ERR_DEV_SCRIPT_LOAD_FAILED"]);
    const eligibility = await failureOf(start({ createInstance: async () => sdk(true, async () => { throw sdkError("ERR_INIT_FIND_ELIGIBLE_METHODS"); }) }).result);
    expect([eligibility.step, eligibility.kind, eligibility.code]).toEqual(["eligibility", "failed", "ERR_INIT_FIND_ELIGIBLE_METHODS"]);
    const noNamespace = await failureOf(start({ loadScript: async () => undefined }).result);
    expect([noNamespace.step, noNamespace.kind, noNamespace.code]).toEqual(["script", "failed", undefined]);
    const oddCode = await failureOf(start({ createInstance: async () => { throw sdkError("<b>not a code</b>"); } }).result);
    expect(oddCode.code).toBeUndefined();
  });

  it("does not show PayPal when PayPal says it cannot take the payment", async () => {
    const e = await failureOf(start({ createInstance: async () => sdk(false) }).result);
    expect([e.step, e.kind]).toEqual(["eligibility", "unavailable"]);
  });
});

describe("what the buyer sees", () => {
  it("names the step while it runs", () => {
    expect(stepLabel("script")).toBe("Loading PayPal Sandbox…");
    expect(stepLabel("connect")).toBe("Connecting to PayPal Sandbox…");
    expect(stepLabel("eligibility")).toBe("Checking that PayPal can take this payment…");
  });

  it("says which step stopped, that nothing was charged, and what to try", () => {
    const timeout = startFailureText(new PayPalStartError("eligibility", "timeout"));
    expect(timeout.title).toBe("PayPal did not finish loading");
    expect(timeout.detail).toMatch(/^PayPal did not answer within 20 seconds while checking that PayPal can take this payment\. Nothing was charged\. If it stops again after a reload,/);
    expect(timeout.detail).toMatch(/ad or tracking blocker/);
    expect(startFailureText(new PayPalStartError("connect", "failed", "ERR_DEV_SCRIPT_LOAD_FAILED")).detail).toMatch(/^PayPal stopped while connecting to PayPal \(ERR_DEV_SCRIPT_LOAD_FAILED\)\./);
    expect(startFailureText(new PayPalStartError("eligibility", "unavailable")).title).toBe("PayPal is not available here");
    expect(startFailureText(new Error("boom"))).toEqual({ title: "PayPal could not load", detail: "boom" });
  });
});
