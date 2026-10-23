import { useEffect, useState, type ReactNode } from "react";
import { Link, usePath, type Config } from "../lib/core";
import { prefersReducedMotion } from "./fx";
import { Mark } from "./ui";

const NAV = [
  ["/", "Product"],
  ["/demo", "Guided demo"],
  ["/merchants", "For merchants"],
  ["/developers", "Developers"],
  ["/evidence", "Evidence"],
] as const;

// The "×" draws itself once per page load, not again on every route change.
let linkIntroPlayed = false;

/**
 * ReCart × PayPal, side by side on every page and at every width. The × draws itself on the first load; hovering or
 * focusing either brand turns it into a + and lights a beam that links the two marks.
 */
function CoBrand() {
  const [intro] = useState(() => { const first = !linkIntroPlayed && !prefersReducedMotion(); linkIntroPlayed = true; return first; });
  return (
    <div className={`cobrand${intro ? " intro" : ""}`}>
      <Link to="/" className="brand" aria-label="ReCart home"><Mark size={28} />ReCart</Link>
      <span className="cobrand-x" aria-hidden>
        <svg width="12" height="12" viewBox="0 0 12 12"><path pathLength={1} d="M1.5 1.5l9 9" /><path pathLength={1} d="M10.5 1.5l-9 9" /></svg>
      </span>
      <a href="/#paypal" className="cobrand-pp" aria-label="Built on PayPal: what PayPal provides" title="Built on the PayPal Developer Platform for the PayPal AI Hackathon">
        <img src="/brand/paypal-mark-reverse.svg" alt="" className="pp-mark" width="23" height="23" />
        <img src="/brand/paypal-wordmark-reverse.svg" alt="" className="pp-word" width="51" height="18" />
      </a>
      <span className="cobrand-beam" aria-hidden />
    </div>
  );
}

export function SiteHeader() {
  const path = usePath().split("?")[0]!;
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const active = (to: string) => (to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`) || (to === "/demo" && (path.startsWith("/case/") || path === "/judges")));
  return (
    <header className={`site-header ${open ? "open" : ""}`}>
      <a className="skip" href="#main">Skip to content</a>
      <div className="wrap">
        <CoBrand />
        <nav className="nav" aria-label="Main">
          {NAV.map(([to, label]) => <Link key={to} to={to} aria-current={active(to) ? "page" : undefined}>{label}</Link>)}
        </nav>
        <div className="header-cta">
          <Link to="/demo" className="btn btn-primary btn-sm">Start guided demo</Link>
        </div>
        <button className="btn btn-secondary btn-sm menu-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "Close" : "Menu"}</button>
      </div>
    </header>
  );
}

export function SiteFooter({ cfg }: { cfg?: Config | null }) {
  return (
    <footer className="site-footer">
      <div className="wrap">
        <div>ReCart · recovery planning for complete purchases. PayPal Sandbox only: no real money moves. Products are fictional.</div>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <Link to="/developers">API and MCP</Link>
          <Link to="/evidence">Evidence</Link>
          {cfg?.repoUrl && <a href={cfg.repoUrl}>Source code</a>}
          <span className="mono">release {cfg?.release ?? "…"}</span>
        </div>
        <div className="footer-tm">PayPal and the PayPal logo are trademarks of PayPal, Inc., shown to credit the sponsor of the PayPal AI Hackathon and the PayPal Developer Platform capabilities ReCart uses.</div>
      </div>
    </footer>
  );
}

export function Page({ children, cfg, wide = true }: { children: ReactNode; cfg?: Config | null; wide?: boolean }) {
  return (
    <>
      <SiteHeader />
      <main id="main" className={wide ? "" : "wrap"}>{children}</main>
      <SiteFooter cfg={cfg} />
    </>
  );
}
