import { useEffect, useState, type ReactNode } from "react";
import { CopyButton, type AppState, type Config } from "../../lib/core";
import { prefersReducedMotion } from "../fx";

/** True when the guide's current step is one of `ids` and it is the person's turn (not ReCart waiting on PayPal). */
export function guideAt(state: AppState, ...ids: string[]) {
  const cur = state?.stage?.current;
  return !!cur && !cur.waiting && ids.includes(cur.id);
}

/**
 * Marks the control the guide points at with a pulsing ring and a short tag. Both are drawn outside the layout and
 * the wrapper is always rendered, so turning a beacon on or off never moves anything on the page.
 */
export function Beacon({ on, tag, block = false, shape = "pill", children }: { on: boolean; tag?: string; block?: boolean; shape?: "pill" | "rect" | "field"; children: ReactNode }) {
  return (
    <span className={`beacon${shape === "pill" ? "" : ` b-${shape}`}${block ? " b-block" : ""}${on ? " on" : ""}`}>
      {children}
      {on && (
        <span className="beacon-tag" aria-hidden>
          {tag ?? <><span className="fine">Click here</span><span className="coarse">Tap here</span></>}
        </span>
      )}
    </span>
  );
}

/** When the control the guide points at is out of view, a floating pointer says which way it is and scrolls to it. */
export function BeaconFinder() {
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const el = document.querySelector(".beacon.on");
      if (!el) return setDir(null);
      const r = el.getBoundingClientRect();
      const top = (document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0) + 8;
      setDir(r.bottom < top ? "up" : r.top > window.innerHeight - 24 ? "down" : null);
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(check); };
    const timer = window.setInterval(schedule, 500);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    schedule();
    return () => { window.clearInterval(timer); window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); if (raf) cancelAnimationFrame(raf); };
  }, []);
  if (!dir) return null;
  const go = () => {
    const el = document.querySelector<HTMLElement>(".beacon.on");
    if (!el) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center", inline: "nearest" });
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    window.setTimeout(() => el.classList.remove("flash"), 1600);
  };
  return (
    <button type="button" className={`beacon-finder ${dir}`} onClick={go}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden><path d={dir === "down" ? "M7 2v9M3 7.5L7 11.5 11 7.5" : "M7 12V3M3 6.5L7 2.5 11 6.5"} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>
      Your next step is {dir === "down" ? "below" : "above"}
    </button>
  );
}

/** Guide text in which each [Button name] is shown as a chip that looks like the control to use. */
export function GuideText({ text }: { text: string }) {
  return <>{text.split(/\[([^\]]+)\]/g).map((p, i) => (i % 2 ? <b key={i} className="ui-chip">{p}</b> : p))}</>;
}

/**
 * The PayPal Sandbox test login, shown as a card that is hard to miss. Each value can be copied, or selected with one
 * click if the clipboard is blocked. `beacon` names the copy button the guide points at.
 */
export function SandboxLogin({ buyer, beacon, onCopied, copied = {} }: { buyer: Config["judgeBuyers"][number]; beacon?: "email" | "password" | null; onCopied?: (which: "email" | "password") => void; copied?: { email?: boolean; password?: boolean } }) {
  // A line may break after the "@" (a <wbr>, which adds nothing to the copied or selected text).
  const shown = (value: string) => { const at = value.indexOf("@"); return at < 0 ? value : <>{value.slice(0, at + 1)}<wbr />{value.slice(at + 1)}</>; };
  const row = (which: "email" | "password", label: string, value: string, tag: string) => (
    // Copying the shown value by hand counts too, so the guide moves on either way.
    <div className={`login-row${copied[which] ? " copied" : ""}`} onCopy={() => onCopied?.(which)}>
      <span className="k">{label}</span>
      <code>{shown(value)}</code>
      <Beacon on={beacon === which} tag={tag}>
        <CopyButton text={value} label={`Copy ${which}`} what={which} className="btn btn-secondary btn-sm copy" onCopied={() => onCopied?.(which)} />
      </Beacon>
    </div>
  );
  return (
    <div className="login-card">
      <div className="login-head">
        <span className="login-icon" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 18 18"><circle cx="6" cy="9" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M9.6 9H16.5M13.6 9v2.8M15.9 9v2" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
        </span>
        <div>
          <div className="login-title">PayPal Sandbox test login</div>
          <div className="login-sub">PayPal's window asks for these. It is a test account with no real money.</div>
        </div>
      </div>
      {row("email", "Email", buyer.email, "Copy this first")}
      {row("password", "Password", buyer.password, "Then copy this")}
    </div>
  );
}
