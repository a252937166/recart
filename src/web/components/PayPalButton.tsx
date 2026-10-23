import { useEffect, useRef, useState } from "react";
import { api, toast, type Config } from "../lib/core";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "paypal-button": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { type?: string; class?: string; disabled?: boolean };
    }
  }
}

let sdkPromise: Promise<any> | null = null;
function loadSdk(url: string): Promise<any> {
  if (!sdkPromise) {
    sdkPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = url; s.async = true;
      s.onload = () => resolve((window as any).paypal);
      s.onerror = () => { sdkPromise = null; reject(new Error("The PayPal Sandbox SDK could not load. Check your connection or ad blocker, then reload.")); };
      document.head.appendChild(s);
    });
  }
  return sdkPromise;
}

/**
 * PayPal JavaScript SDK v6 one-time payment session for an AUTHORIZE order.
 * The order is created on our server (bound to the accepted quote); onApprove sends the order ID back so the
 * server verifies the binding and authorizes. The browser never decides whether money moved.
 */
export function PayPalCheckoutButton({ cfg, quoteId, disabled, onChanged, onWorkingChange }: { cfg: Config; quoteId: string; disabled?: boolean; onChanged: () => void; onWorkingChange?: (working: boolean) => void }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const onWorking = useRef(onWorkingChange);
  onWorking.current = onWorkingChange;
  useEffect(() => { onWorking.current?.(working); }, [working]);
  const session = useRef<any>(null);
  const makeSession = useRef<(() => any) | null>(null);
  const checkoutId = useRef<string | null>(null);
  const latest = useRef({ onChanged, quoteId });
  latest.current = { onChanged, quoteId };

  useEffect(() => {
    if (cfg.paypal.mode === "fake") { setReady(true); return; }
    let cancelled = false;
    (async () => {
      const paypal = await loadSdk(cfg.paypal.sdkUrl);
      let sdk: any;
      try {
        sdk = await paypal.createInstance({ clientId: cfg.paypal.clientId, components: ["paypal-payments"], pageType: "checkout" });
      } catch {
        const t = await api<{ clientToken: string }>("GET", "/api/paypal/client-token");
        sdk = await paypal.createInstance({ clientToken: t.clientToken, components: ["paypal-payments"], pageType: "checkout" });
      }
      const methods = await sdk.findEligibleMethods({ currencyCode: "USD" });
      if (!methods.isEligible("paypal")) throw new Error("PayPal is not available in this browser.");
      makeSession.current = () => sdk.createPayPalOneTimePaymentSession({
        onApprove: async (data: { orderId: string }) => {
          setWorking(true);
          try {
            await api("POST", `/api/checkout/${checkoutId.current}/approved`, { orderId: data.orderId });
            toast("PayPal approval received. The server authorized a Sandbox payment hold.");
          } catch (e: any) { toast(e.message, "error"); }
          finally { setWorking(false); latest.current.onChanged(); }
        },
        onCancel: () => { setWorking(false); toast("PayPal approval was cancelled. Nothing was authorized."); latest.current.onChanged(); },
        onError: (e: any) => { setWorking(false); toast(`PayPal reported a problem: ${e?.message ?? e?.code ?? "unknown error"}`, "error"); latest.current.onChanged(); },
      });
      session.current = makeSession.current();
      if (!cancelled) setReady(true);
    })().catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [cfg]);

  const start = () => {
    if (disabled || working) return;
    if (cfg.paypal.mode === "fake") {
      setWorking(true);
      api<{ checkoutId: string; orderId: string }>("POST", "/api/checkout", { quoteId: latest.current.quoteId })
        .then((r) => api("POST", "/api/dev/fake-approve", { orderId: r.orderId }).then(() => api("POST", `/api/checkout/${r.checkoutId}/approved`, { orderId: r.orderId })))
        .catch((e) => toast(e.message, "error")).finally(() => { setWorking(false); latest.current.onChanged(); });
      return;
    }
    if (!session.current) return;
    setWorking(true);
    const orderPromise = api<{ checkoutId: string; orderId: string | null }>("POST", "/api/checkout", { quoteId: latest.current.quoteId }).then((r) => {
      checkoutId.current = r.checkoutId;
      latest.current.onChanged();
      if (!r.orderId) throw new Error("PayPal has not confirmed the order yet. Try again in a moment.");
      return { orderId: r.orderId };
    });
    const fail = (e: any) => { console.warn("[paypal] could not start", e?.code ?? e?.message ?? e); setWorking(false); toast(e?.message ?? "Could not open PayPal.", "error"); latest.current.onChanged(); };
    // Popup mode, not "auto": in our measurements "auto" sometimes never opened anything (2 of 12 clicks), while
    // popup mode opened every time. When a popup blocker stops the window, the SDK says so at once
    // (ERR_DEV_UNABLE_TO_OPEN_POPUP), and PayPal's in-page overlay takes over; it needs no new click.
    session.current.start({ presentationMode: "popup" }, orderPromise).catch((e: any) => {
      if (e?.code === "ERR_DEV_UNABLE_TO_OPEN_POPUP" && makeSession.current) {
        session.current = makeSession.current();
        return session.current.start({ presentationMode: "modal" }, orderPromise).catch(fail);
      }
      fail(e);
    });
  };

  if (error) return <div className="notice danger" role="alert"><div><strong>PayPal could not load</strong><div>{error}</div></div></div>;
  return (
    <div aria-busy={working}>
      {cfg.paypal.mode === "fake" ? (
        <button className="btn btn-primary btn-block" onClick={start} disabled={disabled || working}>Approve with simulated PayPal (offline mode)</button>
      ) : ready ? (
        <paypal-button type="pay" class="paypal-gold" onClick={start} aria-disabled={disabled || working} />
      ) : (
        <div className="muted small" role="status"><span className="spinner" /> Loading PayPal Sandbox…</div>
      )}
      {working && (
        <p className="small muted" style={{ marginTop: 8 }} role="status">
          <span className="spinner" /> Waiting for PayPal. Complete the approval in the PayPal window.{" "}
          {cfg.paypal.mode !== "fake" && <button type="button" className="linklike" onClick={() => window.location.reload()}>PayPal not showing? Reload this page and select the PayPal button again</button>}
        </p>
      )}
    </div>
  );
}
