import type { ReactNode } from "react";
import { CopyButton, usd } from "../lib/core";

/** The ReCart mark: a connection whose middle segment reroutes around a gap, the way a recovery reroutes a setup. */
export function Mark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" role={title ? "img" : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs><linearGradient id="markBg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#0B2A6B" /><stop offset="1" stopColor="#06122E" /></linearGradient></defs>
      <rect width="32" height="32" rx="9" fill="url(#markBg)" stroke="rgba(96,205,255,0.45)" strokeWidth="1" />
      <path d="M11 20.5h10" stroke="#3E5A86" strokeWidth="2" strokeDasharray="2 2.6" strokeLinecap="round" />
      <path d="M6.5 20.5H10c1.6 0 2.1-1.2 2.6-3.3.8-3.4 1.7-5.2 3.4-5.2s2.6 1.8 3.4 5.2c.5 2.1 1 3.3 2.6 3.3h3.5" stroke="#60CDFF" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="6.5" cy="20.5" r="2.2" fill="#fff" />
      <circle cx="25.5" cy="20.5" r="2.2" fill="#fff" />
    </svg>
  );
}

export const Spinner = ({ label }: { label?: string }) => <span role="status"><span className="spinner" aria-hidden />{label ? <span style={{ marginLeft: 8 }}>{label}</span> : <span className="visually-hidden">Loading</span>}</span>;

export type Tone = "neutral" | "action" | "confirmed" | "attention" | "danger";
export const Pill = ({ tone = "neutral", children, dot }: { tone?: Tone; children: ReactNode; dot?: boolean }) => <span className={`pill ${tone === "neutral" ? "" : tone}`}>{dot && <span className="dot" aria-hidden />}{children}</span>;

export function Notice({ tone = "neutral", title, children, role }: { tone?: Tone; title?: ReactNode; children?: ReactNode; role?: string }) {
  return <div className={`notice ${tone === "neutral" ? "" : tone}`} role={role}><div>{title && <strong>{title}</strong>}{children}</div></div>;
}

export function Money({ cents, signed }: { cents: number | null | undefined; signed?: boolean }) {
  if (cents == null) return <span className="money">—</span>;
  const text = signed && cents > 0 ? `+${usd(cents)}` : usd(cents);
  return <span className={`money ${signed ? (cents > 0 ? "delta-up" : cents < 0 ? "delta-down" : "") : ""}`}>{text}</span>;
}

export function Disclosure({ summary, children, open }: { summary: ReactNode; children: ReactNode; open?: boolean }) {
  return <details className="disclosure" open={open}><summary>{summary}</summary>{children}</details>;
}

export function CheckIcon({ result }: { result: "pass" | "fail" | "unknown" }) {
  return (
    <svg className={`check-icon ${result}`} viewBox="0 0 18 18" aria-hidden>
      <circle cx="9" cy="9" r="8" fill="currentColor" opacity="0.12" />
      {result === "pass" && <path d="M5.2 9.3l2.4 2.4 5-5.2" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />}
      {result === "fail" && <path d="M6 6l6 6M12 6l-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
      {result === "unknown" && <path d="M9 5v5M9 12.6v.4" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />}
    </svg>
  );
}

export function Checks({ items }: { items: { id: string; label: string; result: "pass" | "fail" | "unknown"; detail?: string; evidence?: string[] }[] }) {
  return (
    <ul className="checks">
      {items.map((c) => (
        <li key={c.id}><CheckIcon result={c.result} /><span><strong>{c.label}</strong>{c.detail ? <span className="muted"> — {c.detail}</span> : null}{c.evidence?.length ? <span className="muted small"> ({c.evidence.join(", ")} evidence)</span> : null}</span></li>
      ))}
    </ul>
  );
}

/** A code sample with a copy button. */
export function Code({ code, label }: { code: string; label?: string }) {
  return (
    <div>
      {label && <div className="code-label">{label}</div>}
      <div className="code-wrap">
        <pre className="code" tabIndex={0}>{code}</pre>
        <CopyButton text={code} className="copy" what="code" />
      </div>
    </div>
  );
}

export function LoadingBlock({ label = "Loading" }: { label?: string }) {
  return <div className="panel" aria-busy="true"><Spinner label={label} /></div>;
}

export function ErrorBlock({ error, retry, title = "This could not be loaded" }: { error: Error | null; retry?: () => void; title?: string }) {
  return (
    <div className="notice danger" role="alert">
      <div>
        <strong>{title}</strong>
        <p style={{ margin: "4px 0 8px" }}>{error?.message ?? "The server did not respond."}</p>
        {retry && <button className="btn btn-secondary btn-sm" onClick={retry}>Try again</button>}
      </div>
    </div>
  );
}
