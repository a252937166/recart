/**
 * Starting PayPal's JS SDK v6 takes three steps, and the SDK puts no time limit on the requests behind them: when its
 * script, one of the files it loads next or its eligibility call never answers, createInstance or findEligibleMethods
 * stays pending for good (measured on 2026-10-24 by holding each request). Each step here has its own deadline, so the
 * page can say which step stalled and offer a retry instead of loading forever. The retry is a page reload: the SDK keeps
 * a failed start for the page's lifetime (after a blocked pixel, a second createInstance fails again within 1 ms).
 */
export type PayPalStep = "script" | "connect" | "eligibility";

export const STEP_MS = 20_000;

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
  /** A client token from our server: the SDK's other way to start when the client ID is refused. */
  clientToken: () => Promise<string>;
  onStep?: (step: PayPalStep) => void;
  stepMs?: number;
}

// SDK errors carry codes such as ERR_DEV_SCRIPT_LOAD_FAILED; keep a code only when it looks like one.
const codeOf = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{3,64}$/.test(code) ? code : undefined;
};

/** Starts the SDK and resolves to an instance that can create payment sessions, or rejects with a PayPalStartError. */
export async function startPayPal({ loadScript, clientId, clientToken, onStep, stepMs = STEP_MS }: StartOptions): Promise<PayPalSdk> {
  const step = async <T>(name: PayPalStep, run: () => Promise<T>): Promise<T> => {
    onStep?.(name);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PayPalStartError(name, "timeout")), stepMs); });
    try {
      return await Promise.race([run(), deadline]);
    } catch (e) {
      throw e instanceof PayPalStartError ? e : new PayPalStartError(name, "failed", codeOf(e));
    } finally {
      clearTimeout(timer);
    }
  };
  const paypal = await step("script", async () => {
    const ns = await loadScript();
    if (!ns?.createInstance) throw new Error("PayPal's script ran without defining window.paypal");
    return ns;
  });
  const components = ["paypal-payments"];
  // The client-token fallback shares the connect step's deadline, so a refused client ID cannot double the wait.
  const sdk = await step("connect", async () => {
    try {
      return await paypal.createInstance({ clientId, components, pageType: "checkout" });
    } catch {
      return paypal.createInstance({ clientToken: await clientToken(), components, pageType: "checkout" });
    }
  });
  const methods = await step("eligibility", () => sdk.findEligibleMethods({ currencyCode: "USD" }));
  if (!methods.isEligible("paypal")) throw new PayPalStartError("eligibility", "unavailable");
  return sdk;
}

/** What the page says when PayPal did not start: which step stopped, and what the buyer can do next. */
export function startFailureText(e: unknown, stepMs = STEP_MS): { title: string; detail: string } {
  if (!(e instanceof PayPalStartError)) return { title: "PayPal could not load", detail: String((e as Error | null)?.message ?? e) };
  if (e.kind === "unavailable") return { title: "PayPal is not available here", detail: "PayPal Sandbox reports that it cannot take this payment in this browser. Try another browser." };
  const what = e.kind === "timeout"
    ? `PayPal did not answer within ${Math.round(stepMs / 1000)} seconds while ${STEPS[e.step].during}.`
    : `PayPal stopped while ${STEPS[e.step].during}${e.code ? ` (${e.code})` : ""}.`;
  return { title: "PayPal did not finish loading", detail: `${what} Nothing was charged. If it stops again after a reload, allow paypal.com in any ad or tracking blocker, or use another browser or network.` };
}
