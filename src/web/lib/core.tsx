import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { retryAtText } from "./retry";

/* ---------------- routing (tiny, history API) ---------------- */
const listeners = new Set<() => void>();
export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, "", to); else history.pushState(null, "", to);
  listeners.forEach((l) => l());
  window.scrollTo({ top: 0 });
}
window.addEventListener("popstate", () => listeners.forEach((l) => l()));
export function usePath(): string {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => location.pathname + location.search);
}
export function Link(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const { to, onClick, ...rest } = props;
  return <a {...rest} href={to} onClick={(e) => { onClick?.(e); if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || (rest.target && rest.target !== "_self")) return; e.preventDefault(); navigate(to); }} />;
}

/* ---------------- formatting ---------------- */
export function usd(cents: number | null | undefined) {
  if (cents == null) return "—";
  const sign = cents < 0 ? "−" : "";
  const a = Math.abs(cents);
  return `${sign}$${Math.floor(a / 100).toLocaleString("en-US")}.${String(a % 100).padStart(2, "0")}`;
}
export function when(iso: string | null | undefined, tz?: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
}
export function clockTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
}
export function remaining(ms: number) {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/* ---------------- API ---------------- */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) { super(message); }
}
export { retryAtText };
/** The retry sentence for a 429 error, or null for anything else. */
export const retryText = (e: unknown) => (e instanceof ApiError && e.status === 429 ? retryAtText((e.detail as any)?.retry_at) : null);
/** A 429's message for the page: the server's text, with its relative "try again" replaced by the local time. */
export function limitedText(e: ApiError): string {
  const when = retryText(e);
  return when ? `${e.message.replace(/\s*Try again in \d+ minutes?\.$/, "")} ${when}` : e.message;
}
let csrfToken = "";
export function setCsrf(t: string) { csrfToken = t; }
/** Calls the browser routes (session cookie + CSRF) and the public platform routes; both error formats are understood. */
export async function api<T = any>(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(url, { method, credentials: "same-origin", headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(csrfToken ? { "x-recart-csrf": csrfToken } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = typeof j.error === "object" && j.error ? j.error : { code: j.error ?? "error", message: j.message, details: j.detail };
    throw new ApiError(r.status, e.code ?? "error", e.message ?? `Request failed (${r.status})`, e.details);
  }
  return j as T;
}

/** Fetch JSON once, with loading and error state, for read-only pages. */
export function useFetch<T>(url: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(!!url);
  const load = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try { setData(await api<T>("GET", url)); setError(null); } catch (e) { setError(e as Error); } finally { setLoading(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...deps]);
  useEffect(() => { void load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

/* ---------------- app state ---------------- */
export type AppState = any; // server read model (see src/server/services/views.ts)
export interface Config { paypal: { clientId: string; sdkUrl: string; mode: string }; judgeBuyers: { email: string; password: string }[]; scenarios: { id: string; title: string; ending: string; description: string; budgetCents: number }[]; timing: { quoteAcceptMinutes: number; approvalMinutes: number; confirmationMinutes: number }; sessionHours: number; repoUrl: string; videoUrl: string; publicBaseUrl: string; release: string }

export function useConfig() {
  const [cfg, setCfg] = useState<Config | null>(null);
  useEffect(() => { api<Config>("GET", "/api/config").then(setCfg).catch(() => {}); }, []);
  return cfg;
}

/** Loads durable server state, refreshes on server-sent change events, and polls as a fallback. */
export function useSessionState(caseId?: string | null) {
  const [state, setState] = useState<AppState | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "none" | "unavailable">("loading");
  const timer = useRef<number | null>(null);
  // Loads overlap: a poll, a stream event and an action's reload can all be in flight. Only the newest request's
  // answer is applied, so an older response (one that left the server before a change) never overwrites a newer one.
  const seq = useRef(0);
  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await api<{ csrf: string | null; state: AppState | null }>("GET", caseId ? `/api/case/${caseId}` : "/api/state");
      if (mine !== seq.current) return;
      if (!r.state) { setState(null); setStatus("none"); return; }
      setCsrf(r.csrf ?? ""); setState(r.state); setStatus("ready");
    } catch (e) {
      if (mine !== seq.current) return;
      if (e instanceof ApiError && e.status === 404) { setState(null); setStatus(caseId ? "unavailable" : "none"); }
    }
  }, [caseId]);
  const hasSession = status === "ready";
  useEffect(() => {
    void load();
    let es: EventSource | null = null;
    // Live updates need a demo session; without one the stream would only be refused.
    if (hasSession) {
      try {
        es = new EventSource("/api/events");
        es.addEventListener("changed", () => { void load(); });
      } catch { /* polling only */ }
    }
    timer.current = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 4000);
    return () => { es?.close(); if (timer.current) clearInterval(timer.current); };
  }, [load, hasSession]);
  return { state, status, reload: load, setState };
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

/* ---------------- toast ---------------- */
type Toast = { text: string; kind: "info" | "error" } | null;
const toastListeners = new Set<(t: Toast) => void>();
export function toast(text: string, kind: "info" | "error" = "info") { toastListeners.forEach((l) => l({ text, kind })); }
export function ToastHost() {
  const [t, setT] = useState<Toast>(null);
  useEffect(() => {
    const l = (x: Toast) => { setT(x); window.setTimeout(() => setT((cur) => (cur === x ? null : cur)), 6000); };
    toastListeners.add(l); return () => { toastListeners.delete(l); };
  }, []);
  if (!t) return null;
  return <div role="status" aria-live="polite" className={`toast ${t.kind === "error" ? "error" : ""}`}>{t.text}</div>;
}

/** Wrap an async UI action: disables while running and turns API errors into readable toasts. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(async <T,>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(name);
    try { return await fn(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e), "error"); return undefined; }
    finally { setBusy(null); }
  }, []);
  return useMemo(() => ({ busy, run }), [busy, run]);
}

/** Copies text with the async clipboard, then the older copy command. Resolves false when both are missing or refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* refused or unavailable: try the older command */ }
  const back = document.activeElement as HTMLElement | null;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
  finally { back?.focus?.({ preventScroll: true }); }
}

const shortcut = () => {
  if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) return "touch and hold the text, then choose Copy";
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "press ⌘C" : "press Ctrl+C";
};

/**
 * A copy button that never fails silently. When the browser blocks the clipboard, a small panel opens below it with the
 * text selected and the shortcut to use. Copying from it, or "I copied it", counts as copied, so a guide that waits
 * for the copy carries on. Its container must be positioned (the panel is drawn outside the layout).
 */
export function CopyButton({ text, label = "Copy", className = "btn btn-secondary btn-sm", onCopied, what = "text" }: { text: string; label?: string; className?: string; onCopied?: () => void; what?: string }) {
  const [state, setState] = useState<"idle" | "done" | "manual">("idle");
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  // Focus and select in the same commit that shows the panel (a layout effect), so the panel is never on screen
  // with the focus still elsewhere; a passive effect could be delayed behind other work, such as the PayPal SDK.
  useLayoutEffect(() => { if (state === "manual") { input.current?.focus({ preventScroll: true }); input.current?.select(); } }, [state]);
  // Escape closes the panel wherever the focus is.
  useEffect(() => {
    if (state !== "manual") return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setState("idle"); button.current?.focus({ preventScroll: true }); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [state]);
  const copy = async () => {
    if (await copyText(text)) {
      setState("done");
      onCopied?.();
      window.setTimeout(() => setState((s) => (s === "done" ? "idle" : s)), 1500);
    } else setState("manual");
  };
  const close = (copied: boolean) => { setState("idle"); if (copied) onCopied?.(); button.current?.focus({ preventScroll: true }); };
  return (
    <>
      <button ref={button} type="button" className={`${className}${state === "done" ? " done" : ""}`} onClick={() => void copy()} aria-live="polite" aria-expanded={state === "manual" ? true : undefined}>{state === "done" ? "Copied" : label}</button>
      {state === "manual" && (
        <span className="copy-manual" role="group" aria-label={`Copy the ${what} yourself`}>
          <span className="copy-manual-text">This browser blocked copying. The {what} is selected below: {shortcut()}.</span>
          <input ref={input} className="input" readOnly value={text} aria-label={`The ${what}`} onFocus={(e) => e.currentTarget.select()} onCopy={() => window.setTimeout(() => close(true), 150)} />
          <span className="copy-manual-actions">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => close(true)}>I copied it</button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => close(false)}>Close</button>
          </span>
        </span>
      )}
    </>
  );
}
