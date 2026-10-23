import { api, Link, remaining, toast, usd, useAction, useNow, type AppState } from "../../lib/core";
import { Notice, Pill, Spinner } from "../ui";
import { Beacon, guideAt } from "./guide";

/** The simulated store associate, confined to this isolated demo session; actions call the same guarded backend. */
export function StoreView({ state, reload }: { state: AppState; reload: () => void }) {
  const act = useAction();
  const now = useNow();
  const co = state.checkout;
  const quote = co ? (state.quote?.id === co.quoteId ? state.quote : state.originalQuote?.id === co.quoteId ? state.originalQuote : null) : null;
  const ticket = co ? (state.tickets ?? []).find((t: any) => t.checkout_id === co.id) : null;
  const reserved: any[] = (state.reservations ?? []).filter((r: any) => r.checkout_id === co?.id);
  const confirm = () => act.run("confirm", async () => { await api("POST", `/api/merchant/checkouts/${co.id}/confirm`); reload(); toast("Goods confirmed. Capture requested from PayPal."); });
  const missing = (sku: string) => act.run("missing", async () => { await api("POST", `/api/merchant/checkouts/${co.id}/report-missing`, { sku }); reload(); toast("Missing part recorded. The buyer was notified and the hold is being released."); });
  const handover = () => act.run("handover", async () => { await api("POST", `/api/merchant/checkouts/${co.id}/handover`); reload(); toast("Handed over. Inventory updated."); });
  const releaseLeft = co?.releaseBy ? new Date(co.releaseBy).getTime() - now : null;
  const lines: any[] = quote?.data?.lines ?? [];
  const reservedQty = (sku: string) => reserved.filter((r) => r.sku === sku).reduce((s, r) => s + r.qty, 0);
  const rc = state.recoveryCase;
  // The guided story reports the audio interface missing: that row's button is where the guide points.
  const targetSku = guideAt(state, "store_check") ? lines.find((l) => l.role === "interface")?.sku : null;
  return (
    <div>
      <div className="role-banner"><Pill tone="attention">Store</Pill><span>You are the store associate in this demo's own shop. These controls cannot change who gets paid, create a capture, or skip the buyer's approval.</span></div>
      <div className="store-grid">
        <section className="panel" aria-labelledby="ready-h">
          <div className="panel-head"><h2 id="ready-h">Readiness check</h2>{co && quote && <span className="small muted">order version {quote.version}</span>}</div>
          {!co && <p className="muted">No order is waiting. An order appears here after the buyer approves a hold in PayPal.</p>}
          {co && co.state === "READY_FOR_APPROVAL" && <p className="muted">The buyer has not approved the hold yet. Nothing to pack.</p>}
          {co && co.state === "AUTHORIZED" && (
            <>
              <p>PayPal holds <strong className="num">{usd(quote?.data?.totalCents)}</strong>. Check the shelf for each reserved part, then confirm them, or report what is missing.</p>
              {releaseLeft != null && <div className={`countdown ${releaseLeft < 5 * 60_000 ? "urgent" : ""}`}><span className="small">Confirm before {new Date(co.releaseBy).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} or the hold is voided</span><strong>{remaining(releaseLeft)}</strong></div>}
              <div className="table-wrap" style={{ marginTop: 14 }}>
                <table className="data">
                  <thead><tr><th>Reserved part</th><th className="r">Qty</th><th className="r">On the shelf?</th></tr></thead>
                  <tbody>{lines.map((l) => (
                    <tr key={l.sku} className={l.sku === targetSku ? "target" : ""}>
                      <td><div className="item-name">{l.name}</div><div className="item-sub mono">{l.sku}</div></td>
                      <td className="r">{reservedQty(l.sku) || l.qty}</td>
                      <td className="r"><Beacon on={l.sku === targetSku}><button className="btn btn-danger btn-sm" onClick={() => missing(l.sku)} disabled={!!act.busy} aria-label={`Report ${l.name} missing`}>Report missing</button></Beacon></td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div className="btn-row" style={{ marginTop: 16 }}><Beacon on={guideAt(state, "confirm")}><button className="btn btn-confirm" onClick={confirm} disabled={!!act.busy}>Confirm exact goods are here</button></Beacon></div>
              <p className="hint" style={{ marginTop: 8 }}>For the guided demo, report the 2-in USB-C interface missing to start a recovery.</p>
            </>
          )}
          {co && ["CAPTURE_IN_FLIGHT", "STATUS_UNKNOWN", "VOID_IN_FLIGHT", "REFUND_IN_FLIGHT", "AUTHORIZATION_IN_FLIGHT"].includes(co.state) && <p><Spinner label="Waiting for PayPal to confirm the last operation. Nothing else can start until it does." /></p>}
          {co && co.state === "PAID" && ticket && (
            <>
              {ticket.state === "READY_FOR_HANDOFF" && <Notice tone="confirmed" title="Payment captured and released">Pack the exact items on quote version {quote?.version}.</Notice>}
              {ticket.state === "HANDED_OVER" && <Notice tone="confirmed" title="Handed over. The purchase is complete." />}
              {ticket.state === "BLOCKED" && <Notice tone="danger" title="Do not hand over">The payment was captured, but release is blocked by a cancellation or discrepancy. ReCart refunds it automatically.</Notice>}
              {ticket.state === "READY_FOR_HANDOFF" && <Beacon on={guideAt(state, "confirm", "handover")}><button className="btn btn-confirm" onClick={handover} disabled={!!act.busy}>Mark handed over</button></Beacon>}
            </>
          )}
          {co && ["VOIDED", "CLOSED_NO_PAYMENT", "REFUNDED"].includes(co.state) && <p className="muted">The last order is closed ({co.state === "VOIDED" ? "hold voided" : co.state === "REFUNDED" ? "refunded" : "no payment"}). {rc && ["AWAITING_BUYER", "RECONCILING"].includes(rc.status) ? "Waiting for the buyer to decide on the rebuilt setup." : ""}</p>}
        </section>
        <div className="stack">
          <section className="panel" aria-labelledby="shelf-h">
            <div className="panel-head"><h2 id="shelf-h">Shelf</h2><span className="small muted">this demo's own stock</span></div>
            <div className="shelf">{(state.inventory ?? []).map((i: any) => {
              const v = state.catalog.find((c: any) => c.sku === i.sku);
              return <div key={i.sku} className={i.on_hand === 0 ? "zero" : ""}><strong>{i.on_hand}</strong> on hand<br />{v?.name ?? i.sku}</div>;
            })}</div>
          </section>
          {rc && (
            <section className="panel" aria-labelledby="case-h">
              <div className="panel-head"><h2 id="case-h">Recovery</h2></div>
              <p className="small">Missing: {state.catalog.find((c: any) => c.sku === rc.detail?.sku)?.name ?? rc.detail?.sku}. Status: {({ RECONCILING: "releasing the first hold", AWAITING_BUYER: "waiting for the buyer", RESOLVED_RECOVERED: "recovered", CLOSED_NO_SOLUTION: "closed, no supported setup", CLOSED_BY_BUYER: "cancelled by the buyer" } as Record<string, string>)[rc.status] ?? rc.status.toLowerCase()}.</p>
              <Link to="/demo" className="small">See the buyer's view</Link>
            </section>
          )}
          <section className="panel">
            <h2 style={{ fontSize: "var(--s1)" }}>Connecting a real store</h2>
            <p className="small muted" style={{ marginTop: 6, marginBottom: 0 }}>This shop is simulated inside the demo. Real stores send catalog and stock through the merchant API; a Shopify development store is connected as a read-only reference. <Link to="/merchants">See integration status</Link>.</p>
          </section>
        </div>
      </div>
    </div>
  );
}

export function MessagesView({ state, reload }: { state: AppState; reload: () => void }) {
  const items: any[] = state.inbox ?? [];
  const markRead = (id: string) => { void api("POST", `/api/inbox/${id}/read`).then(reload); };
  return (
    <section className="panel" aria-labelledby="inbox-h" style={{ maxWidth: 760, marginTop: 20 }}>
      <div className="panel-head"><h2 id="inbox-h">Messages</h2><Pill>Simulated delivery</Pill></div>
      <p className="small muted">Messages come from ReCart's durable outbox, the same path a real email adapter would use. No email or SMS is sent in this demo.</p>
      {items.length === 0 && <p className="muted">Nothing yet. A message arrives when your setup changes.</p>}
      {items.map((n) => (
        <article key={n.id} className={`inbox-item ${!n.read_at && n.status === "DELIVERED" ? "unread" : ""}`}>
          <span className="dot" style={{ color: !n.read_at && n.status === "DELIVERED" ? "var(--action)" : "var(--line-strong)", marginTop: 7 }} aria-hidden />
          <div>
            <strong>{n.title}</strong>
            <p className="small" style={{ margin: "4px 0 8px" }}>{n.body}</p>
            {n.link && <Link to={n.link} onClick={() => markRead(n.id)}>{n.link.startsWith("/case/") ? "Open recovery case" : "Open"}</Link>}
            {n.link?.startsWith("/case/") && <p className="hint" style={{ marginTop: 6 }}>Works in this browser profile while the demo session is available.</p>}
          </div>
        </article>
      ))}
    </section>
  );
}

/** Expandable technical log: PayPal operations, verified webhooks and the audit trail of this session. */
export function TechDetails({ state }: { state: AppState }) {
  const ops: any[] = state.operations ?? [];
  const hooks: any[] = state.webhooks ?? [];
  const timeline: any[] = state.timeline ?? [];
  const t = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <details className="disclosure" style={{ marginTop: 32 }}>
      <summary>Technical details: PayPal operations, webhooks and audit log</summary>
      <div className="store-grid" style={{ marginTop: 12 }}>
        <div>
          <h3 style={{ fontSize: "var(--s0)", marginBottom: 6 }}>PayPal operations ({ops.length})</h3>
          <div className="log">{ops.length === 0 ? <div>None yet.</div> : ops.map((o) => <div key={o.id}>{t(o.created_at)} {o.kind} {o.status}{o.provider_ref ? ` ${o.provider_ref}` : ""}{o.provider_status ? ` (${o.provider_status})` : ""}{o.http_status ? ` HTTP ${o.http_status}` : ""}{o.debug_id ? ` debug ${o.debug_id}` : ""}{o.attempts > 1 ? ` attempts ${o.attempts}` : ""}</div>)}</div>
          <h3 style={{ fontSize: "var(--s0)", margin: "14px 0 6px" }}>Verified webhooks ({hooks.length})</h3>
          <div className="log">{hooks.length === 0 ? <div>None yet.</div> : hooks.map((w, i) => <div key={i}>{t(w.received_at)} {w.event_type} {w.verification} {w.status}</div>)}</div>
        </div>
        <div>
          <h3 style={{ fontSize: "var(--s0)", marginBottom: 6 }}>Audit log (latest first)</h3>
          <div className="log" style={{ maxHeight: 420 }}>{timeline.map((e, i) => <div key={i}>{t(e.at)} {e.actor} {e.action}{e.entity ? ` ${e.entity}` : ""}{e.detail ? ` ${JSON.stringify(e.detail).slice(0, 160)}` : ""}</div>)}</div>
        </div>
      </div>
    </details>
  );
}
