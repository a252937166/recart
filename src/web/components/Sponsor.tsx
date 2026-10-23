import { CountUp, Reveal } from "./fx";

/** PayPal's own logo (reverse variant for dark surfaces), credited as the hackathon sponsor. */
export function PayPalLogo({ height = 26, mark = true }: { height?: number; mark?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: Math.round(height * 0.3) }}>
      {mark && <img src="/brand/paypal-mark-reverse.svg" alt="" style={{ height, width: "auto" }} />}
      <img src="/brand/paypal-wordmark-reverse.svg" alt="PayPal" style={{ height: Math.round(height * 0.72), width: "auto" }} />
    </span>
  );
}

export interface LiveEvidence {
  live?: { sessions: number; authorizations: number; captures: number; voids: number; refunds: number; webhooks_verified: number; webhooks_processed: number; recovery_cases: number };
  sandboxMatrix?: { rows: { id: string; path: string; result: string; resources: string }[]; recordedAt: string };
  tests?: { passed: number; total: number };
}

/** The sponsor section: what PayPal provides, which capabilities ReCart relies on, and the problem each one solves. */
export function PayPalSection({ ev }: { ev: LiveEvidence | null }) {
  const live = ev?.live;
  const row = (id: string) => ev?.sandboxMatrix?.rows.find((r) => r.id === id);
  const pp04 = row("PP04");
  const pp03 = row("PP03");
  const e2e = ["E2E-A", "E2E-B", "E2E-C"].map(row).filter(Boolean);
  const n = (v: number | undefined) => (v == null ? <span className="muted">…</span> : <CountUp to={v} />);
  const caps = [
    {
      api: "Orders v2 · intent AUTHORIZE", title: "A hold, not a charge",
      problem: "Charging at checkout locks the buyer into a setup the store may not be able to pack.",
      solution: "Every order is created with intent AUTHORIZE. The buyer approves a hold for the exact quote; nothing is captured until the store confirms the goods are on the shelf.",
      proof: <><strong>{n(live?.authorizations)}</strong> authorizations created on this server</>,
    },
    {
      api: "Payments v2 · void · capture · refund", title: "Release the old money first",
      problem: "When a part goes missing, the hold for the old setup must be released before a different order is charged.",
      solution: "ReCart voids the first authorization, captures the new total once, and refunds any capture PayPal confirms after the store's deadline.",
      proof: <><strong>{n(live?.voids)}</strong> voids · <strong>{n(live?.captures)}</strong> captures{pp03 ? <> · refund path recorded (PP03)</> : null}</>,
    },
    {
      api: "PayPal-Request-Id idempotency", title: "A lost reply never charges twice",
      problem: "A network timeout after PayPal executed a capture looks exactly like a failure.",
      solution: "Every PayPal call is a stored operation with its own request ID. An unknown result is reconciled from PayPal with the same ID before anything else happens.",
      proof: pp04 ? <>PP04: a real capture reply was discarded; <strong>one</strong> capture exists at PayPal</> : <>PP04 lost-reply recovery recorded</>,
    },
    {
      api: "Webhooks · verify-webhook-signature", title: "The truth arrives even if the tab closes",
      problem: "Buyers close tabs mid-payment; the browser cannot be trusted to report what happened to money.",
      solution: "Verified PayPal events trigger reconciliation. Each one is checked with verify-webhook-signature on the raw body before it is used.",
      proof: <><strong>{n(live?.webhooks_verified)}</strong> webhooks verified with PayPal</>,
    },
    {
      api: "JavaScript SDK v6", title: "Fresh approval for every changed order",
      problem: "A rebuilt setup costs a different amount; the old approval must not carry over.",
      solution: "Each new version opens a new PayPal approval (popup, with PayPal's in-page overlay as fallback). The buyer approves the exact new total.",
      proof: e2e.length ? <><strong>{e2e.length}</strong> guided stories passed on this site through real PayPal approvals</> : <>Guided stories recorded on this site</>,
    },
    {
      api: "Sandbox · Developer Dashboard", title: "Real money flows, no real money",
      problem: "Judges and developers must try authorize, void and capture end to end without risk.",
      solution: "The demo runs on a Sandbox REST app with dedicated test buyers, so every hold, void and capture you trigger is a real PayPal Sandbox resource.",
      proof: <>Real Sandbox resources only · test buyer login shown in the demo</>,
    },
  ];
  return (
    <>
      <Reveal className="pp-hero">
        <div>
          <div className="bigmark"><img className="m" src="/brand/paypal-mark-reverse.svg" alt="" /><img className="w" src="/brand/paypal-wordmark-reverse.svg" alt="PayPal" /></div>
          <h2>Built on the PayPal Developer Platform</h2>
          <p>PayPal sponsors the PayPal AI Hackathon and provides the free Sandbox, the REST APIs and the JavaScript SDK that move every dollar in ReCart's demo store. ReCart's solver works out the replacement, and AI drafts the requirements and explains the change; PayPal holds, releases and captures the money, and only after the buyer approves.</p>
        </div>
        <div className="pp-stats" aria-label="Live PayPal Sandbox activity on this server">
          <div><div className="v">{n(live?.authorizations)}</div><div className="k">Authorizations</div></div>
          <div><div className="v">{n(live?.voids)}</div><div className="k">Holds voided</div></div>
          <div><div className="v">{n(live?.captures)}</div><div className="k">Captures</div></div>
          <div><div className="v">{n(live?.sessions)}</div><div className="k">Demo sessions</div></div>
          <div><div className="v">{n(live?.webhooks_verified)}</div><div className="k">Webhooks verified</div></div>
          <div><div className="v">{n(live?.recovery_cases)}</div><div className="k">Recoveries</div></div>
          <div className="src"><span className="dot live" style={{ color: "#34D399" }} />live from this server's PayPal Sandbox ledger · <a href="/evidence">evidence</a></div>
        </div>
      </Reveal>
      <div className="cap-list-pp">
        {caps.map((c, i) => (
          <Reveal key={c.api} className="cap" delay={((i % 2) + 1) as 1 | 2}>
            <span className="api"><img src="/brand/paypal-mark-reverse.svg" alt="" />{c.api}</span>
            <h3>{c.title}</h3>
            <p className="problem"><b>Problem</b> · {c.problem}</p>
            <p className="solution"><b>With PayPal</b> · {c.solution}</p>
            <div className="proof"><span className="dot" style={{ color: "#60CDFF" }} />{c.proof}</div>
          </Reveal>
        ))}
      </div>
    </>
  );
}
