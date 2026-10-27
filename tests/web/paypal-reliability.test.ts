import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPayPalStartManager, createPayPalTokenReconnect, PayPalStartError, readPayPalAuth, rememberPayPalTokenRetry,
  startPayPal, TOKEN_RETRY_MS, type PayPalAuth, type PayPalSdk, type RetryStorage, type StartOptions,
} from "../../src/web/lib/paypal.js";

const never = <T>() => new Promise<T>(() => {});
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((a) => { resolve = a; }); return { promise, resolve }; };
const sdk = (): PayPalSdk => ({
  findEligibleMethods: vi.fn(async () => ({ isEligible: (method: string) => method === "paypal" })),
  createPayPalOneTimePaymentSession: vi.fn(),
});
const failureOf = (p: Promise<unknown>) => p.then(() => { throw new Error("expected failure"); }, (e) => e as PayPalStartError);
const flush = () => vi.advanceTimersByTimeAsync(0);
function options(over: Partial<StartOptions> & { createInstance?: (o: Record<string, unknown>) => Promise<PayPalSdk> } = {}) {
  const created: Record<string, unknown>[] = [], create = over.createInstance ?? (async () => sdk());
  const config: StartOptions = {
    loadScript: async () => ({ createInstance: (o) => { created.push(o); return create(o); } }),
    clientId: "client-id", clientToken: vi.fn(async () => "client-token"), stepMs: 40, ...over,
  };
  return { config, created };
}
const observer = () => ({ onStep: vi.fn(), onReady: vi.fn(), onError: vi.fn() });
function storage() {
  const values = new Map<string, string>();
  const store: RetryStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); }, removeItem: (k) => { values.delete(k); } };
  return { store, values };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("cancelled or late SDK work", () => {
  it("a fresh token attempt never supplies clientId or creates a client-ID instance first", async () => {
    const run = options({ auth: "client-token" });
    await startPayPal(run.config);
    expect(run.created).toEqual([{ clientToken: "client-token", components: ["paypal-payments"], pageType: "checkout" }]);
    expect(run.config.clientToken).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });

  it("late client-ID success after timeout cannot start eligibility or a same-page token attempt", async () => {
    const pending = deferred<PayPalSdk>(), late = sdk(), run = options({ createInstance: () => pending.promise });
    const failure = failureOf(startPayPal(run.config));
    await vi.advanceTimersByTimeAsync(40); expect((await failure).kind).toBe("timeout");
    pending.resolve(late); await flush();
    expect(late.findEligibleMethods).not.toHaveBeenCalled(); expect(run.config.clientToken).not.toHaveBeenCalled();
    expect(run.created).toHaveLength(1);
  });

  it("a connect deadline aborts token fetch and prevents a late token creating an instance", async () => {
    const token = deferred<string>(); let signal!: AbortSignal;
    const run = options({ auth: "client-token", clientToken: (s) => { signal = s; return token.promise; } });
    const failure = failureOf(startPayPal(run.config)); await vi.advanceTimersByTimeAsync(40);
    expect([(await failure).step, signal.aborted]).toEqual(["connect", true]);
    token.resolve("late-client-token"); await flush(); expect(run.created).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it("an already aborted start never requests a script or a token", async () => {
    const controller = new AbortController(); controller.abort(); const load = vi.fn(() => never<undefined>());
    const run = options({ signal: controller.signal, loadScript: load });
    expect((await failureOf(startPayPal(run.config))).code).toBe("ERR_START_CANCELLED");
    expect(load).not.toHaveBeenCalled(); expect(run.config.clientToken).not.toHaveBeenCalled();
  });

  it("cancellation during token retrieval stops the fetch and subsequent SDK stages", async () => {
    const controller = new AbortController(), token = deferred<string>(); let fetchSignal!: AbortSignal;
    const run = options({ auth: "client-token", signal: controller.signal, clientToken: (s) => { fetchSignal = s; return token.promise; } });
    const failure = failureOf(startPayPal(run.config)); await flush(); controller.abort();
    expect((await failure).code).toBe("ERR_START_CANCELLED"); expect(fetchSignal.aborted).toBe(true);
    token.resolve("unused-token"); await flush(); expect(run.created).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("shared document initialization", () => {
  it("StrictMode's immediate cleanup/setup and multiple components share one start", async () => {
    const manager = createPayPalStartManager(), pending = deferred<PayPalSdk>(), run = options({ createInstance: () => pending.promise });
    const first = observer(), second = observer(), release = manager.subscribe("same-sdk", run.config, first);
    await flush(); release(); const firstSteps = first.onStep.mock.calls.length;
    const releaseSecond = manager.subscribe("same-sdk", run.config, second);
    pending.resolve(sdk()); await flush();
    expect(run.created).toHaveLength(1); expect(first.onReady).not.toHaveBeenCalled();
    expect(first.onStep).toHaveBeenCalledTimes(firstSteps); expect(second.onReady).toHaveBeenCalledOnce();
    releaseSecond(); await flush(); expect(vi.getTimerCount()).toBe(0);
  });

  it("abandoned startup never notifies removed subscribers or resumes after late SDK success", async () => {
    const manager = createPayPalStartManager(), pending = deferred<PayPalSdk>(), late = sdk();
    const run = options({ createInstance: () => pending.promise }), removed = observer();
    const release = manager.subscribe("same-sdk", run.config, removed); await flush(); release(); await flush();
    pending.resolve(late); await flush();
    expect(removed.onReady).not.toHaveBeenCalled(); expect(removed.onError).not.toHaveBeenCalled();
    expect(late.findEligibleMethods).not.toHaveBeenCalled();
    const returned = observer(); manager.subscribe("same-sdk", { ...run.config, auth: "client-token" }, returned);
    expect(returned.onError.mock.calls[0]?.[0].code).toBe("ERR_START_CANCELLED");
    expect(run.created).toHaveLength(1); expect(run.config.clientToken).not.toHaveBeenCalled();
  });

  it("removing one view does not cancel initialization still needed by another view", async () => {
    const manager = createPayPalStartManager(), token = deferred<string>(); let signal!: AbortSignal;
    const run = options({ auth: "client-token", clientToken: (s) => { signal = s; return token.promise; } });
    const first = observer(), second = observer();
    const remove = manager.subscribe("same-sdk", run.config, first);
    manager.subscribe("same-sdk", run.config, second); await flush(); remove(); await flush();
    expect(signal.aborted).toBe(false); token.resolve("client-token"); await flush();
    expect(first.onReady).not.toHaveBeenCalled(); expect(second.onReady).toHaveBeenCalledOnce(); expect(run.created).toHaveLength(1);
  });

  it("changing auth preference in a failed SDK document does not start a second instance", async () => {
    const manager = createPayPalStartManager(), run = options({ createInstance: never }), first = observer();
    manager.subscribe("same-sdk", run.config, first); await vi.advanceTimersByTimeAsync(40);
    const second = observer(); manager.subscribe("same-sdk", { ...run.config, auth: "client-token" }, second);
    expect(first.onError).toHaveBeenCalledOnce(); expect(second.onError).toHaveBeenCalledOnce();
    expect(second.onError.mock.calls[0]?.[1]).toBe("client-id");
    expect(run.created).toHaveLength(1); expect(run.config.clientToken).not.toHaveBeenCalled();
  });

  it("a released ready instance does not leave a stale token instance cached for the next quote", async () => {
    const manager = createPayPalStartManager(), first = options({ auth: "client-token" }), ready = observer();
    const release = manager.subscribe("same-sdk", first.config, ready); await flush(); release(); await flush();
    const next = options({ auth: "client-token" }), second = observer(); manager.subscribe("same-sdk", next.config, second); await flush();
    expect(first.config.clientToken).toHaveBeenCalledOnce(); expect(next.config.clientToken).toHaveBeenCalledOnce();
    expect(second.onReady).toHaveBeenCalledOnce();
  });
});

describe("one fresh-document token recovery", () => {
  it("persists only a short-lived mode flag and can renew the preference after token success", () => {
    const s = storage(), now = 123000;
    expect(readPayPalAuth(s.store, now)).toBe("client-id"); expect(rememberPayPalTokenRetry(s.store, now)).toBe(true);
    expect([...s.values.values()].map(v => Object.keys(JSON.parse(v)).sort())).toEqual([["expiresAt", "mode"]]);
    expect(readPayPalAuth(s.store, now + 1000)).toBe("client-token"); expect(rememberPayPalTokenRetry(s.store, now + 1000)).toBe(true);
    expect(readPayPalAuth(s.store, now + TOKEN_RETRY_MS)).toBe("client-token");
    expect(readPayPalAuth(s.store, now + TOKEN_RETRY_MS + 1001)).toBe("client-id"); expect(s.values.size).toBe(0);
  });

  it("a client-ID timeout reloads once, and the new document creates only a token instance", async () => {
    const s = storage(), reload = vi.fn(), reconnect = createPayPalTokenReconnect(), hung = options({ createInstance: never });
    const failure = failureOf(startPayPal(hung.config)); await vi.advanceTimersByTimeAsync(40); const e = await failure;
    expect(reconnect(e, "client-id", s.store, reload)).toBe(true); expect(reconnect(e, "client-id", s.store, reload)).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
    const fresh = options({ auth: readPayPalAuth(s.store) }); await startPayPal(fresh.config);
    expect(fresh.created).toEqual([{ clientToken: "client-token", components: ["paypal-payments"], pageType: "checkout" }]);
    expect(hung.created).toHaveLength(1); expect(hung.config.clientToken).not.toHaveBeenCalled();
    expect(createPayPalTokenReconnect()(e, "client-token", s.store, reload)).toBe(false); expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload for token failure, unrelated stages, cancellation or unavailable storage", () => {
    const s = storage(), reload = vi.fn();
    for (const [error, auth] of [
      [new PayPalStartError("connect", "timeout"), "client-token"], [new PayPalStartError("script", "timeout"), "client-id"],
      [new PayPalStartError("eligibility", "failed"), "client-id"], [new PayPalStartError("connect", "failed", "ERR_START_CANCELLED"), "client-id"],
    ] as [PayPalStartError, PayPalAuth][]) expect(createPayPalTokenReconnect()(error, auth, s.store, reload)).toBe(false);
    const blocked = { ...s.store, setItem: () => { throw new Error("blocked"); } }, ignored = { ...s.store, setItem: () => {} };
    for (const store of [null, blocked, ignored]) expect(createPayPalTokenReconnect()(new PayPalStartError("connect", "timeout"), "client-id", store, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("ignores malformed, expired, future and inaccessible retry state", () => {
    const s = storage(); rememberPayPalTokenRetry(s.store, 1000); const key = [...s.values.keys()][0]!;
    for (const raw of ["not-json", "null", JSON.stringify({ mode: "token", expiresAt: 1000 }), JSON.stringify({ mode: "token", expiresAt: 10 * TOKEN_RETRY_MS })]) {
      s.values.set(key, raw); expect(readPayPalAuth(s.store, 2000)).toBe("client-id");
    }
    expect(readPayPalAuth({ ...s.store, getItem: () => { throw new Error("denied"); } })).toBe("client-id");
  });
});
