import { useState } from "react";
import { api, remaining, usd, useAction, useNow, type AppState, type Config } from "../../lib/core";
import { PayPalCheckoutButton } from "../PayPalButton";
import { SetupDiagram } from "../SetupDiagram";
import { Checks, Disclosure, Money, Notice, Pill, Spinner } from "../ui";
import { goalOf, PAYMENT_TEXT, partsFromLines, ROLE_LABEL } from "./parts";
import { Beacon, guideAt, SandboxLogin } from "./guide";

const NON_TERMINAL_MONEY = ["READY_FOR_APPROVAL", "AUTHORIZATION_IN_FLIGHT", "AUTHORIZED", "CAPTURE_IN_FLIGHT", "VOID_IN_FLIGHT", "REFUND_IN_FLIGHT", "STATUS_UNKNOWN", "REVIEW_REQUIRED"];

/** Parts table: one row per line; with an original, rows added by the rebuild are marked and dropped rows listed. */
export function PartsTable({ lines, original, missingSku }: { lines: any[]; original?: any[] | null; missingSku?: string | null }) {
  const was = new Map((original ?? []).map((l) => [l.sku, l]));
  const now = new Set(lines.map((l) => l.sku));
  const removed = (original ?? []).filter((l) => !now.has(l.sku));
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Part</th><th className="r">Qty</th><th className="r">Price</th></tr></thead>
        <tbody>
          {lines.map((l) => {
            const added = !!original && !was.has(l.sku);
            return (
              <tr key={l.sku} className={added ? "added" : ""}>
                <td><div className="item-name">{l.name}</div><div className="item-sub">{ROLE_LABEL[l.role] ?? l.role}{added ? " · new in this version" : ""}</div></td>
                <td className="r">{l.qty}</td><td className="r">{usd(l.lineCents)}</td>
              </tr>
            );
          })}
          {removed.map((l) => (
            <tr key={`x-${l.sku}`} className="removed">
              <td><div className="item-name">{l.name}</div><div className="item-sub">{l.sku === missingSku ? "missing at packing" : "no longer needed"}</div></td>
              <td className="r">{l.qty}</td><td className="r">{usd(l.lineCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function checkItems(checks: any[]) {
  return checks.map((c) => ({ id: c.id, label: c.label, result: c.outcome as "pass" | "fail" | "unknown", detail: c.detail }));
}

/** Choose a checked setup, accept the exact quote, then approve the hold in PayPal. */
export function SetupPanel({ state, cfg, reload }: { state: AppState; cfg: Config; reload: () => void }) {
  const goal = state.goal?.data;
  const rc = state.recoveryCase;
  const recoveryOpen = rc && ["AWAITING_BUYER", "RECONCILING"].includes(rc.status);
  const solve = recoveryOpen ? rc.solve : state.solve;
  const [pick, setPick] = useState(0);
  const act = useAction();
  const now = useNow();
  const quote = state.quote;
  const co = state.checkout;
  const originalLines = state.originalQuote?.data?.lines;
  const priorUnresolved = state.attempts.some((a: any) => !a.terminal && a.quoteId !== quote?.id && NON_TERMINAL_MONEY.includes(a.state));

  if (!goal) return (
    <section className="panel">
      <h2>Your setup</h2>
      <p className="muted" style={{ marginTop: 10 }}>Confirm your requirements first. ReCart then checks every combination in this store's catalog against the full recording path: mic inputs, phantom power, a headphone feed for each person, the remote guest's audio route and the cable into your computer.</p>
    </section>
  );
  const choose = (index: number) => act.run("choose", async () => { await api("POST", "/api/quotes", { solveRunId: solve.id, index }); reload(); });
  const accept = () => act.run("accept", async () => { await api("POST", `/api/quotes/${quote.id}/accept`, { hash: quote.hash }); reload(); });

  if (recoveryOpen && quote && quote.kind !== "REPLACEMENT") return null;
  const quoteActive = quote && ["PUBLISHED", "ACCEPTED"].includes(quote.status) && !(co && co.quoteId === quote.id && co.state === "PAID");
  if (quoteActive || (co && co.quoteId === quote?.id)) {
    const d = quote.data;
    const acceptLeft = new Date(quote.accept_by).getTime() - now;
    const coForQuote = co && co.quoteId === quote.id ? co : null;
    const replacement = quote.kind === "REPLACEMENT";
    return (
      <section className="panel" aria-labelledby="quote-h">
        <div className="panel-head">
          <h2 id="quote-h">{replacement ? "Your rebuilt setup" : "Your quote"} <span className="muted small">version {quote.version}</span></h2>
          <Pill tone={quote.status === "ACCEPTED" ? "confirmed" : "action"}>{quote.status === "ACCEPTED" ? "Accepted" : quote.status === "PUBLISHED" ? "Waiting for your acceptance" : quote.status.toLowerCase()}</Pill>
        </div>
        <SetupDiagram parts={partsFromLines(d.lines, state.catalog, { original: replacement ? originalLines : null })} goal={goalOf(goal)} label="The quoted setup" />
        <div style={{ marginTop: 16 }}><PartsTable lines={d.lines} original={replacement ? originalLines : null} /></div>
        <p className="small muted" style={{ marginTop: 10 }}>Pickup {d.pickup.label} at the {d.pickup.location}. {d.confirmationPolicy.note}</p>
        <Disclosure summary="Why this setup works"><Checks items={checkItems(d.checks)} /></Disclosure>
        <Disclosure summary="Quote fingerprint"><p className="small muted" style={{ wordBreak: "break-all" }}>SHA-256 {quote.hash}. Your consent is recorded against these exact terms; any change creates a new quote.</p></Disclosure>
        {quote.status === "PUBLISHED" && (
          <div className="paybox">
            <p style={{ marginTop: 0 }}>Accepting records your consent to exactly these {d.lines.length} parts and <strong className="num">{usd(d.totalCents)}</strong>. It does not charge you.</p>
            <Beacon block on={acceptLeft > 0 && guideAt(state, "quote", "review")}><button className="btn btn-primary btn-block" onClick={accept} disabled={!!act.busy || acceptLeft <= 0}>{acceptLeft > 0 ? `Accept quote (${remaining(acceptLeft)} left)` : "Quote expired"}</button></Beacon>
            {acceptLeft <= 0 && <button className="btn btn-secondary btn-block" style={{ marginTop: 8 }} onClick={() => solve && choose(pick)}>Refresh the quote</button>}
          </div>
        )}
        {quote.status === "ACCEPTED" && (!coForQuote || coForQuote.state === "READY_FOR_APPROVAL") && (
          priorUnresolved ? (
            <div className="paybox"><Notice tone="attention" title="Releasing the previous hold first">PayPal opens here as soon as the earlier hold is released. Nothing new is authorized until then.</Notice></div>
          ) : (
            <ApprovalBox cfg={cfg} quoteId={quote.id} totalCents={d.totalCents} guided={guideAt(state, "approval", "reapproval")} reload={reload} />
          )
        )}
        {coForQuote && <PaymentStatus co={coForQuote} total={d.totalCents} now={now} />}
      </section>
    );
  }

  if (!solve) return <section className="panel"><Spinner label="Checking every combination" /></section>;
  const r = solve.result;
  if (r.status === "NEEDS_CLARIFICATION") return <section className="panel"><h2>Your setup</h2><Notice tone="attention" title="More details needed">Add the missing requirements to check setups. ReCart does not guess hard requirements.</Notice></section>;
  if (r.status === "UNSUPPORTED_GOAL") return <section className="panel"><h2>Your setup</h2><Notice tone="attention" title="Outside this store's reviewed setups">The reviewed recipes cover up to two people in the room plus at most one remote guest, on macOS or Windows with Zoom or Google Meet. ReCart will not improvise a setup outside them.</Notice></section>;
  if (recoveryOpen) return null;
  if (r.status !== "FEASIBLE") return <section className="panel"><h2>Your setup</h2><Notice tone="danger" title="No complete setup fits right now">{r.nearMisses?.[0] ? `The closest one needs ${r.nearMisses[0].requires.budgetCents ? `a budget of ${usd(r.nearMisses[0].requires.budgetCents)}` : "a later pickup"}. Edit your requirements to see it.` : "No bundle in this catalog meets every requirement."}</Notice></section>;
  const b = r.candidates[Math.min(pick, r.candidates.length - 1)];
  return (
    <section className="panel" aria-labelledby="setup-h">
      <div className="panel-head"><h2 id="setup-h">Checked setups</h2><span className="small muted num">{r.combinationsChecked} combinations checked · {r.feasibleCount} complete</span></div>
      {r.candidates.length > 1 && (
        <div className="options" role="group" aria-label="Setup options">
          {r.candidates.map((c: any, i: number) => <button key={i} aria-pressed={pick === i} onClick={() => setPick(i)}><strong>{i === 0 ? "Recommended" : "Alternative"}</strong><br /><span className="small muted num">{usd(c.totalCents)} all-in</span></button>)}
        </div>
      )}
      <SetupDiagram parts={partsFromLines(b.lines, state.catalog)} goal={goalOf(goal)} label="This setup" />
      <div style={{ marginTop: 16 }}><PartsTable lines={b.lines} /></div>
      <Disclosure summary="All checks this setup passed"><Checks items={checkItems(b.checks)} /></Disclosure>
      <div className="btn-row" style={{ marginTop: 16 }}><Beacon on={guideAt(state, "quote")}><button className="btn btn-primary" onClick={() => choose(pick)} disabled={!!act.busy}>Choose this setup ({usd(b.totalCents)})</button></Beacon></div>
    </section>
  );
}

/**
 * Approving the hold, as three numbered steps: copy the Sandbox test login, open PayPal, approve. The guide points at
 * the email first, then the PayPal button, and while PayPal's window is open, at whatever is not copied yet.
 */
function ApprovalBox({ cfg, quoteId, totalCents, guided, reload }: { cfg: Config; quoteId: string; totalCents: number; guided: boolean; reload: () => void }) {
  const buyer = cfg.judgeBuyers[0];
  const [copied, setCopied] = useState<{ email?: boolean; password?: boolean }>({});
  const [working, setWorking] = useState(false);
  const next = !copied.email ? "email" : !copied.password ? "password" : null;
  const target = !guided ? null : !buyer ? "pay" : working ? next : copied.email ? "pay" : "email";
  const button = (
    <Beacon block={!buyer || cfg.paypal.mode === "fake"} shape="rect" on={target === "pay"} tag={buyer ? "Click here, then paste the login" : undefined}>
      <div className="pay-button"><PayPalCheckoutButton cfg={cfg} quoteId={quoteId} onChanged={reload} onWorkingChange={setWorking} /></div>
    </Beacon>
  );
  return (
    <div className="paybox">
      <p style={{ marginTop: 0 }}>PayPal will place a hold of <strong className="num">{usd(totalCents)}</strong>. The store captures it only after confirming the exact goods.</p>
      {buyer ? (
        <ol className="approval-steps">
          <li className={copied.email && copied.password ? "done" : ""}>
            <div className="step-title">Copy the test login</div>
            <SandboxLogin buyer={buyer} beacon={target === "email" || target === "password" ? target : null} copied={copied} onCopied={(w) => setCopied((c) => ({ ...c, [w]: true }))} />
          </li>
          <li>
            <div className="step-title">Select PayPal and log in with it</div>
            {button}
          </li>
          <li>
            <div className="step-title">Approve the hold in PayPal</div>
            <p className="small muted" style={{ margin: 0 }}>This page updates by itself when PayPal returns. Enter the login on PayPal's Sandbox page only; ReCart never asks for it.</p>
          </li>
        </ol>
      ) : button}
    </div>
  );
}

function PaymentStatus({ co, total, now }: { co: any; total: number; now: number }) {
  const m = PAYMENT_TEXT[co.state] ?? { tone: "neutral" as const, label: co.state, detail: "" };
  const releaseLeft = co.releaseBy ? new Date(co.releaseBy).getTime() - now : null;
  const text = co.state === "AUTHORIZED" ? `Payment authorized: a Sandbox hold of ${usd(total)}. Not captured yet.` : co.state === "PAID" ? `Payment captured: ${usd(total)}.` : m.detail;
  return (
    <div style={{ marginTop: 16 }}>
      <Notice tone={m.tone} title={m.label}>{text}{co.state === "AUTHORIZED" && <div className="small" style={{ marginTop: 4 }}>Next: the store checks the shelf. Switch to the Store view.</div>}</Notice>
      {co.state === "AUTHORIZED" && releaseLeft != null && (
        <div className={`countdown ${releaseLeft < 5 * 60_000 ? "urgent" : ""}`}>
          <span className="small">The store must confirm by {new Date(co.releaseBy).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} or the hold is voided automatically</span>
          <strong>{remaining(releaseLeft)}</strong>
        </div>
      )}
    </div>
  );
}

export { Money };
