/**
 * Starting PayPal's JS SDK v6 takes three steps, and the SDK puts no time limit on the requests behind them: when its
 * script, one of the files it loads next or its eligibility call never answers, createInstance or findEligibleMethods
 * stays pending for good. Each step has a deadline. One attempt uses one authentication mode: the SDK caches its first
 * pixel connection, so a second createInstance on the same document cannot repair that connection. A client-token retry
 * must run in a new document, with no client-id token request in its pixel. We never reset the SDK's private globals.
 */
export type PayPalStep = "script" | "connect" | "eligibility";

export const STEP_MS = 20_000;
export type PayPalAuth = "client-id" | "client-token";
export const TOKEN_RETRY_MS = 5 * 60_000;
const RETRY_KEY = "recart.paypal.token-retry";
export interface RetryStorage { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** Only a short-lived mode preference crosses a reload, never a client token or a payment identifier. */
export function readPayPalAuth(storage: RetryStorage | null, now = Date.now()): PayPalAuth {
  try {
    const raw = storage?.getItem(RETRY_KEY);
    if (!raw) return "client-id";
    const value = JSON.parse(raw);
    if (value?.mode === "token" && Number.isFinite(value.expiresAt) && value.expiresAt > now && value.expiresAt <= now + TOKEN_RETRY_MS) return "client-token";
    storage?.removeItem(RETRY_KEY);
  } catch { /* Storage can be blocked, or a previous value malformed. Keep the standard checkout path. */ }
  return "client-id";
}

/** Verify persistence before allowing an automatic reload, so blocked storage cannot cause a reload loop. */
export function rememberPayPalTokenRetry(storage: RetryStorage | null, now = Date.now()): boolean {
  if (!storage) return false;
  try {
    const value = JSON.stringify({ mode: "token", expiresAt: now + TOKEN_RETRY_MS });
    storage.setItem(RETRY_KEY, value);
    return storage.getItem(RETRY_KEY) === value;
  } catch { return false; }
}

/** At most one automatic new-document attempt. A token attempt or unavailable storage never reloads itself. */
export function createPayPalTokenReconnect() {
  let requested = false;
  return (error: unknown, auth: PayPalAuth, storage: RetryStorage | null, reload: () => void): boolean => {
    if (requested || auth !== "client-id" || !(error instanceof PayPalStartError) || error.step !== "connect" || error.kind === "unavailable" || error.code === "ERR_START_CANCELLED") return false;
    if (!rememberPayPalTokenRetry(storage)) return false;
    requested = true;
    reload();
    return true;
  };
}

const STEPS: Record<PayPalStep, { label: string; during: string }> = {
  script: { label: "Loading PayPal Sandbox…", during: "loading PayPal's script" },
  connect: { label: "Connecting to PayPal Sandbox…", during: "connecting to PayPal" },
  eligibility: { label: "Checking that PayPal can take this payment…", during: "checking that PayPal can take this payment" },
};

/** The status line shown while a step runs. */
export const stepLabel = (step: PayPalStep) => STEPS[step].label;

export class PayPalStartError extends Error {
  constructor(readonly step: PayPalStep, readonly kind: "timeout" | "failed" | "unavailable", readonly code?: string) {
    super(`${kind} while ${STEPS[step].during}${code ? ` (${code})` : ""}`);
    this.name = "PayPalStartError";
  }
}

export interface PayPalSdk {
  findEligibleMethods(options: { currencyCode: string }): Promise<{ isEligible(method: string): boolean }>;
  createPayPalOneTimePaymentSession(options: unknown): any;
}
interface PayPalNamespace { createInstance(options: Record<string, unknown>): Promise<PayPalSdk> }

export interface StartOptions {
  /** Resolves to window.paypal once PayPal's script has run. */
  loadScript: () => Promise<PayPalNamespace | undefined>;
  clientId: string;
  /** Used only in a fresh document's token attempt. The abort signal also bounds the server token request. */
  clientToken: (signal: AbortSignal) => Promise<string>;
  auth?: PayPalAuth;
  signal?: AbortSignal;
  onStep?: (step: PayPalStep) => void;
  stepMs?: number;
}

// SDK errors carry codes such as ERR_DEV_SCRIPT_LOAD_FAILED; keep a code only when it looks like one.
const codeOf = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{3,64}$/.test(code) ? code : undefined;
};

/** Starts the SDK and resolves to an instance that can create payment sessions, or rejects with a PayPalStartError. */
export async function startPayPal({ loadScript, clientId, clientToken, auth = "client-id", signal, onStep, stepMs = STEP_MS }: StartOptions): Promise<PayPalSdk> {
  const cancelled = (name: PayPalStep) => new PayPalStartError(name, "failed", "ERR_START_CANCELLED");
  const step = async <T>(name: PayPalStep, run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (signal?.aborted) throw cancelled(name);
    onStep?.(name);
    const work = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped: PayPalStartError | undefined;
    let abort = () => {};
    const deadline = new Promise<never>((_, reject) => {
      const stop = (error: PayPalStartError) => { stopped = error; reject(error); work.abort(); };
      timer = setTimeout(() => stop(new PayPalStartError(name, "timeout")), stepMs);
      abort = () => stop(cancelled(name));
      signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      const value = await Promise.race([Promise.resolve().then(() => {
        if (work.signal.aborted) throw stopped ?? cancelled(name);
        return run(work.signal);
      }), deadline]);
      if (stopped || signal?.aborted) throw stopped ?? cancelled(name);
      return value;
    } catch (e) {
      throw stopped ?? (e instanceof PayPalStartError ? e : new PayPalStartError(name, "failed", codeOf(e)));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  const paypal = await step("script", async () => {
    const ns = await loadScript();
    if (!ns?.createInstance) throw new Error("PayPal's script ran without defining window.paypal");
    return ns;
  });
  const components = ["paypal-payments"];
  const sdk = await step("connect", async (work) => {
    if (auth === "client-id") return paypal.createInstance({ clientId, components, pageType: "checkout" });
    const token = await clientToken(work);
    if (work.aborted) throw cancelled("connect");
    return paypal.createInstance({ clientToken: token, components, pageType: "checkout" });
  });
  const methods = await step("eligibility", () => sdk.findEligibleMethods({ currencyCode: "USD" }));
  if (!methods.isEligible("paypal")) throw new PayPalStartError("eligibility", "unavailable");
  return sdk;
}

interface StartObserver { onStep(step: PayPalStep): void; onReady(sdk: PayPalSdk, auth: PayPalAuth): void; onError(error: unknown, auth: PayPalAuth): void }
type ManagedOptions = Omit<StartOptions, "signal" | "onStep">;

/** One in-flight SDK start per configuration/document, including React's development effect replay and multiple views. */
export function createPayPalStartManager() {
  type Job = { auth: PayPalAuth; step: PayPalStep; controller: AbortController; observers: Set<StartObserver>; state: "pending" | "ready" | "failed"; sdk?: PayPalSdk; error?: unknown; idle?: ReturnType<typeof setTimeout> };
  const jobs = new Map<string, Job>();
  return {
    subscribe(key: string, options: ManagedOptions, observer: StartObserver): () => void {
      let job = jobs.get(key);
      if (!job) {
        job = { auth: options.auth ?? "client-id", step: "script", controller: new AbortController(), observers: new Set(), state: "pending" };
        jobs.set(key, job);
        const current = job;
        void startPayPal({ ...options, signal: current.controller.signal, onStep: (step) => {
          current.step = step;
          for (const listener of current.observers) listener.onStep(step);
        } }).then((sdk) => {
          current.state = "ready"; current.sdk = sdk;
          for (const listener of current.observers) listener.onReady(sdk, current.auth);
          if (!current.observers.size && jobs.get(key) === current) jobs.delete(key);
        }, (error) => {
          current.state = "failed"; current.error = error;
          for (const listener of current.observers) listener.onError(error, current.auth);
          // Retain a failed start: its SDK pixel may be poisoned. A new view must reload, not create another instance.
        });
      }
      clearTimeout(job.idle);
      job.observers.add(observer);
      observer.onStep(job.step);
      if (job.state === "ready") observer.onReady(job.sdk!, job.auth);
      if (job.state === "failed") observer.onError(job.error, job.auth);
      const current = job;
      return () => {
        current.observers.delete(observer);
        if (current.observers.size) return;
        // An immediate StrictMode cleanup/setup reuses the start; a genuinely abandoned start cannot fetch a token or
        // proceed to later stages. The SDK itself has no public abort/destroy method for its pixel connection.
        current.idle = setTimeout(() => {
          if (current.observers.size) return;
          if (current.state === "pending") current.controller.abort();
          if (current.state === "ready" && jobs.get(key) === current) jobs.delete(key);
        }, 0);
      };
    },
  };
}

/** What the page says when PayPal did not start: which step stopped, and what the buyer can do next. */
export function startFailureText(e: unknown, stepMs = STEP_MS): { title: string; detail: string } {
  if (!(e instanceof PayPalStartError)) return { title: "PayPal could not load", detail: String((e as Error | null)?.message ?? e) };
  if (e.code === "ERR_START_CANCELLED") return { title: "PayPal connection was interrupted", detail: "Reload this page to reconnect. Your accepted quote is saved, and nothing was charged." };
  if (e.kind === "unavailable") return { title: "PayPal is not available here", detail: "PayPal Sandbox reports that it cannot take this payment in this browser. Try another browser." };
  const what = e.kind === "timeout"
    ? `PayPal did not answer within ${Math.round(stepMs / 1000)} seconds while ${STEPS[e.step].during}.`
    : `PayPal stopped while ${STEPS[e.step].during}${e.code ? ` (${e.code})` : ""}.`;
  return { title: "PayPal did not finish loading", detail: `${what} Nothing was charged. If it stops again after a reload, allow paypal.com in any ad or tracking blocker, or use another browser or network.` };
}
