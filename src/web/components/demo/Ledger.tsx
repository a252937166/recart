import { Link, usd, type AppState } from "../../lib/core";
import { Pill } from "../ui";
import { PAYMENT_TEXT } from "./parts";

/** Totals for the current quote and every PayPal attempt in plain words, with the Sandbox IDs underneath. */
export function LedgerPanel({ state }: { state: AppState }) {
  const q = state.quote;
  const orig = state.originalQuote;
  const d = q?.data;
  const tickets: any[] = state.tickets ?? [];
  const totalFor = (quoteId: string) => (quoteId === q?.id ? d?.totalCents : quoteId === orig?.id ? orig?.data?.totalCents : null);
  return (
    <aside aria-label="Totals and payments" className="stack">
      <section className="panel" aria-labelledby="cost-h">
        <div className="panel-head"><h2 id="cost-h">Total</h2>{d && <span className="small muted">quote v{q.version}</span>}</div>
        {d ? (
          <dl className="totals">
            <dt>Parts</dt><dd>{usd(d.subtotalCents)}</dd>
            <dt>Tax (8%)</dt><dd>{usd(d.taxCents)}</dd>
            <dt>Pickup</dt><dd>{usd(0)}</dd>
            <dt className="grand">Total</dt><dd className="grand">{usd(d.totalCents)}</dd>
            {orig && q.kind === "REPLACEMENT" && <><dt className="small">Change from the original {usd(orig.data.totalCents)}</dt><dd className={`small ${d.totalCents - orig.data.totalCents > 0 ? "delta-up" : "delta-down"}`}>{d.totalCents - orig.data.totalCents > 0 ? "+" : ""}{usd(d.totalCents - orig.data.totalCents)}</dd></>}
          </dl>
        ) : <p className="muted small">Totals appear when you choose a setup. Amounts are exact cents with the store's 8% tax rule.</p>}
      </section>
      <section className="panel" aria-labelledby="pay-h">
        <div className="panel-head"><h2 id="pay-h">Payments</h2><Pill tone="action">PayPal Sandbox</Pill></div>
        {state.attempts.length === 0 ? <p className="muted small">No payment yet. Accepting a quote never charges; PayPal first places a hold.</p> : (
          <ol className="timeline">
            {state.attempts.map((a: any, i: number) => {
              const m = PAYMENT_TEXT[a.state] ?? { tone: "neutral" as const, label: a.state, detail: "" };
              const color = m.tone === "confirmed" ? "var(--confirmed)" : m.tone === "attention" ? "var(--attention)" : m.tone === "danger" ? "var(--danger)" : m.tone === "action" ? "var(--action)" : "var(--ink-3)";
              return (
                <li key={a.id}>
                  <span className="dot" style={{ color }} aria-hidden />
                  <div>
                    <strong>{i === 0 ? "First hold" : "New hold"} · <span className="num">{usd(totalFor(a.quoteId))}</span></strong>
                    <div className="small">{m.label}. {m.detail}</div>
                    <div className="ids">
                      {a.paypalOrderId && <div>order {a.paypalOrderId}</div>}
                      {a.authorizationId && <div>authorization {a.authorizationId}</div>}
                      {a.captureId && <div>capture {a.captureId}</div>}
                      {a.refundId && <div>refund {a.refundId}</div>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <p className="small" style={{ marginTop: 12, marginBottom: 0 }}><Link to="/evidence">See all evidence</Link></p>
      </section>
      {tickets.length > 0 && (
        <section className="panel" aria-labelledby="ticket-h">
          <div className="panel-head"><h2 id="ticket-h">Pickup ticket</h2></div>
          {tickets.map((t) => <div key={t.id} className="small" style={{ marginBottom: 6 }}><Pill tone={t.state === "READY_FOR_HANDOFF" || t.state === "HANDED_OVER" ? "confirmed" : t.state === "BLOCKED" ? "danger" : "neutral"}>{t.state === "READY_FOR_HANDOFF" ? "Ready for pickup" : t.state === "HANDED_OVER" ? "Handed over" : t.state === "BLOCKED" ? "Blocked" : "Not released"}</Pill> <span className="muted">bound to the captured quote</span></div>)}
        </section>
      )}
    </aside>
  );
}
