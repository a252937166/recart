import { useMemo, useState } from "react";
import { api, toast, usd, useAction, type AppState } from "../../lib/core";
import { SetupDiagram } from "../SetupDiagram";
import { CheckIcon, Checks, Disclosure, Money, Notice, Pill } from "../ui";
import { goalOf, partsFromLines } from "./parts";
import { checkItems, PartsTable } from "./Setup";
import { Beacon, guideAt } from "./guide";

/** The recovery: what broke, why single-part swaps fail, the rebuilt options with money, or the honest exit. */
export function RecoveryPanel({ state, reload, onEditGoal, goalEditing = false }: { state: AppState; reload: () => void; onEditGoal: () => void; goalEditing?: boolean }) {
  const rc = state.recoveryCase;
  const act = useAction();
  const [pick, setPick] = useState(0);
  const goal = state.goal?.data;
  const original = state.originalQuote?.data;
  const exp = rc?.detail?.explanation;
  const solve = rc?.solve;
  const missingSku = rc?.detail?.sku;
  const oldAttempt = useMemo(() => state.attempts.find((a: any) => a.id === rc?.checkout_id) ?? state.attempts.find((a: any) => a.quoteId === state.originalQuote?.id), [state, rc]);
  if (!rc || !original || !goal) return null;
  const open = ["AWAITING_BUYER", "RECONCILING"].includes(rc.status);
  const r = solve?.result;
  const replacementQuote = state.quote?.kind === "REPLACEMENT" && ["PUBLISHED", "ACCEPTED"].includes(state.quote.status) ? state.quote : null;
  const choose = (index: number) => act.run("choose", async () => { await api("POST", "/api/quotes", { solveRunId: solve.id, index }); reload(); });
  const cancel = (reason: string) => act.run("cancel", async () => { await api("POST", "/api/purchase/cancel", { reason }); reload(); toast(reason === "no_supported_solution" ? "Purchase closed. Nothing was charged." : "Order cancelled. Nothing was charged."); });
  const oldMoney = oldAttempt?.state;
  const missingName = original.lines.find((l: any) => l.sku === missingSku)?.name ?? missingSku;
  const heading = rc.status.startsWith("RESOLVED") ? "Recovered purchase" : rc.status.startsWith("CLOSED") ? "Purchase closed" : "Your setup needs a change";
  return (
    <section className="panel" aria-labelledby="rec-h" style={{ borderColor: open ? "#EBCB98" : undefined }}>
      <div className="panel-head"><h2 id="rec-h">{heading}</h2><Pill tone="attention">Store reported a missing part</Pill></div>
      <p>The packing check could not find the <strong>{missingName}</strong>. {oldMoney === "VOIDED" ? "Your first PayPal hold was released, so you have not been charged." : oldMoney === "CLOSED_NO_PAYMENT" ? "No payment had been authorized yet." : "ReCart is releasing your first PayPal hold before anything else happens."}</p>
      <SetupDiagram parts={partsFromLines(original.lines, state.catalog, { missingSku })} goal={goalOf(goal)} label="Your original setup with the missing part" caption="Without the interface, the mics, the computer connection and the remote guest's audio all stop working." />
      {exp && (
        <div className="inset" style={{ marginTop: 16 }}>
          <Pill tone={exp.source === "model" ? "action" : exp.pending ? "attention" : "neutral"}>{exp.source === "model" ? `Explained by AI from checked facts (${exp.model})` : exp.pending ? "AI explanation on its way; this is the template meanwhile" : "Template explanation (AI unavailable or not grounded)"}</Pill>
          <p style={{ margin: "10px 0 0" }}>{exp.text}</p>
          {exp.swaps?.length > 0 && (
            <>
              <h3 style={{ margin: "14px 0 8px", fontSize: "var(--s0)" }}>Swapping only the missing part</h3>
              <ul className="checks">{exp.swaps.map((s: any) => (
                <li key={s.sku}><CheckIcon result={s.ok ? "pass" : "fail"} /><span><strong>{s.name}</strong> <span className="muted">{s.ok ? "works on its own" : (s.reasons ?? s.failed.map((f: any) => f.label.toLowerCase())).join("; ")}</span></span></li>
              ))}</ul>
            </>
          )}
        </div>
      )}
      {open && rc.status === "RECONCILING" && !r && <Notice tone="attention" title="Releasing your first hold">Replacement options appear as soon as PayPal confirms the release.</Notice>}
      {open && r?.status === "FEASIBLE" && !replacementQuote && (() => {
        const b = r.candidates[Math.min(pick, r.candidates.length - 1)];
        const diff = b.totalCents - original.totalCents;
        return (
          <div style={{ marginTop: 22 }}>
            <h3 style={{ fontSize: "var(--s2)" }}>Rebuilt setup</h3>
            <p className="small muted">{r.combinationsChecked} combinations checked. New parts are marked; everything else stays reserved for you.</p>
            {r.candidates.length > 1 && (
              <div className="options" role="group" aria-label="Rebuilt options">
                {r.candidates.map((c: any, i: number) => <button key={i} aria-pressed={pick === i} onClick={() => setPick(i)}><strong>{i === 0 ? "Fewest changes" : "Alternative"}</strong><br /><span className="small muted num">{usd(c.totalCents)} ({c.totalCents - original.totalCents >= 0 ? "+" : ""}{usd(c.totalCents - original.totalCents)})</span></button>)}
              </div>
            )}
            <SetupDiagram parts={partsFromLines(b.lines, state.catalog, { original: original.lines })} goal={goalOf(goal)} label="The rebuilt setup" />
            <div className="compare" style={{ marginTop: 16 }}>
              <div><div className="k">Original total</div><div className="v"><Money cents={original.totalCents} /></div></div>
              <div><div className="k">New total</div><div className="v"><Money cents={b.totalCents} /></div></div>
              <div><div className="k">Difference{goal.budgetCents != null ? ` · ${usd(goal.budgetCents - b.totalCents)} under your limit` : ""}</div><div className="v"><Money cents={diff} signed /></div></div>
            </div>
            <div style={{ marginTop: 16 }}><PartsTable lines={b.lines} original={original.lines} missingSku={missingSku} /></div>
            <Disclosure summary="All checks the rebuilt setup passed"><Checks items={checkItems(b.checks)} /></Disclosure>
            <div className="btn-row" style={{ marginTop: 16 }}>
              <Beacon on={guideAt(state, "review")}><button className="btn btn-primary" onClick={() => choose(pick)} disabled={!!act.busy}>Review this rebuilt setup</button></Beacon>
              <button className="btn btn-danger" onClick={() => cancel("buyer_cancelled")} disabled={!!act.busy}>Cancel order</button>
            </div>
          </div>
        );
      })()}
      {open && r && r.status !== "FEASIBLE" && r.nearMisses?.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <h3 style={{ fontSize: "var(--s2)" }}>Decision needed</h3>
          <Notice tone="attention" title="No complete setup fits your limit">The closest one costs <strong className="num">{usd(r.nearMisses[0].bundle.totalCents)}</strong>, above your {usd(goal.budgetCents)} limit. ReCart will not change your limit for you.</Notice>
          <h4 style={{ margin: "16px 0 10px" }}>What the closest complete setup would be</h4>
          <SetupDiagram parts={partsFromLines(r.nearMisses[0].bundle.lines, state.catalog, { original: original.lines })} goal={goalOf(goal)} label="The closest complete setup, over your limit" />
          <div className="compare" style={{ margin: "16px 0" }}>
            <div><div className="k">Original total</div><div className="v"><Money cents={original.totalCents} /></div></div>
            <div><div className="k">Closest complete setup</div><div className="v"><Money cents={r.nearMisses[0].bundle.totalCents} /></div></div>
            <div><div className="k">Over your {usd(goal.budgetCents)} limit by</div><div className="v"><Money cents={r.nearMisses[0].bundle.totalCents - goal.budgetCents} signed /></div></div>
          </div>
          <div className="btn-row">
            <Beacon on={guideAt(state, "decision") && !goalEditing}><button className="btn btn-primary" onClick={onEditGoal}>Change my requirements</button></Beacon>
            <button className="btn btn-danger" onClick={() => cancel("buyer_cancelled")} disabled={!!act.busy}>Cancel order</button>
          </div>
        </div>
      )}
      {open && r && r.status !== "FEASIBLE" && !r.nearMisses?.length && (
        <div style={{ marginTop: 22 }}>
          <h3 style={{ fontSize: "var(--s2)" }}>No supported setup</h3>
          <Notice tone="danger" title="Nothing in stock can complete this setup">No bundle in this catalog and its reviewed recipes meets your confirmed requirements. {r.bindingExplanation?.[0]}</Notice>
          <Beacon on={guideAt(state, "no_solution")}><button className="btn btn-primary" onClick={() => cancel("no_supported_solution")} disabled={!!act.busy || !["VOIDED", "CLOSED_NO_PAYMENT", undefined].includes(oldMoney)}>Close purchase</button></Beacon>
        </div>
      )}
      {rc.status === "CLOSED_NO_SOLUTION" && <Notice tone="confirmed" title="Purchase closed with an explanation saved">The authorization was voided; nothing was charged.</Notice>}
      {rc.status === "RESOLVED_RECOVERED" && <Notice tone="confirmed" title="Recovered">The rebuilt setup was approved and captured. Your pickup ticket is ready.</Notice>}
    </section>
  );
}
