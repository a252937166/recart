import { useEffect, useState } from "react";
import { SetupDiagram, RoleIcon, type DiagramPart } from "../components/SetupDiagram";
import { Checks, Disclosure, ErrorBlock, Mark, Money, Notice, Pill, Spinner } from "../components/ui";
import { api, ApiError, toast, useFetch, usd, useAction, when } from "../lib/core";

const ROLE: Record<string, string> = { mic: "Microphones", interface: "Audio interface", headphones: "Headphones", mic_cable: "Mic cables", host_cable: "Computer cable", adapter: "Adapter", stand: "Stands", splitter: "Headphone splitter" };

function ReviewHeader({ merchant }: { merchant?: string }) {
  return (
    <header className="site-header">
      <div className="wrap" style={{ gap: 14 }}>
        <span className="brand"><Mark size={26} />ReCart</span>
        <span className="small muted">{merchant ? `Order review for ${merchant}` : "Order review"}</span>
      </div>
    </header>
  );
}

function partsOf(setup: any): DiagramPart[] {
  return [
    ...setup.items.map((i: any) => ({ id: i.product_id, name: i.name, role: i.role, qty: i.quantity, status: i.change === "kept" ? "kept" : "added", attrs: i.attributes })),
    ...setup.removed_items.map((i: any) => ({ id: i.product_id, name: i.name, role: i.role, qty: i.quantity, status: "removed" })),
  ];
}

const REASON: Record<string, string> = { missing_at_packing: "could not be found when your order was packed", damaged: "was found damaged", out_of_stock: "is out of stock", discontinued: "is no longer sold", other: "is unavailable" };

/** The proposal in the buyer's own terms (the API summary is written for the merchant). */
function buyerSummary(v: any): string {
  const p = v.proposal;
  if (!p) return "";
  const u = p.unavailable_items;
  const lead = `The ${u.map((x: any) => x.name).join(" and ")} ${u.length === 1 ? REASON[u[0].reason] ?? "is unavailable" : "are unavailable"}.`;
  switch (p.outcome) {
    case "proposal_ready": {
      const r = p.replacement;
      const n = r.items.filter((i: any) => i.change !== "kept").length;
      const single = p.single_item_swaps.length > 0 && !p.single_item_swaps.some((s: any) => s.works);
      return `${lead} ${single ? "Replacing only that part would not work with anything in stock, so " : ""}${v.merchant.name} proposes ${n} new part${n === 1 ? "" : "s"} that complete${n === 1 ? "s" : ""} your setup. The new total is ${usd(r.totals.total_cents)}, ${usd(Math.abs(r.difference_cents))} ${r.difference_cents >= 0 ? "more" : "less"} than your original order${r.budget ? `, within your ${usd(r.budget.max_total_cents)} limit` : ""}.`;
    }
    case "budget_conflict": {
      const c = p.conflict;
      return `${lead} The closest complete setup costs ${usd(c.closest.totals.total_cents)}, over your ${usd(c.current_max_total_cents)} limit. Nothing changes unless you raise your limit to at least ${usd(c.required_max_total_cents)}. You can also decline.`;
    }
    case "deadline_conflict": return `${lead} The closest complete setup can be ready ${when(p.conflict.earliest_ready_at)}, later than you asked. You can accept the later time or decline.`;
    case "no_change_needed": return `${lead} The store has another one, so your order stays as it is.`;
    case "no_supported_bundle": return `${lead} No complete setup can be built from what is in stock, so the store will contact you about your order.`;
    default: return "The store is updating its information. This page shows the current proposal when it is ready.";
  }
}

/** The buyer's page for a merchant recovery: what changes and why, the money, the evidence, and the decision. */
export function Review({ token }: { token: string }) {
  const { data: v, error, loading, setData, reload } = useFetch<any>(`/api/review/${token}`);
  const act = useAction();
  const [budget, setBudget] = useState<string>("");
  const decide = (decision: "approve" | "decline") => act.run(decision, async () => {
    try {
      setData(await api("POST", `/api/review/${token}/decision`, { proposal_id: v.proposal.id, proposal_hash: v.proposal.hash, decision }));
      toast(decision === "approve" ? "Approved. The store has been notified." : "Declined. The store has been notified.");
    } catch (e) {
      if (e instanceof ApiError && ["proposal_superseded", "proposal_hash_mismatch"].includes(e.code)) { toast("Something changed, so this page now shows the current version. Review it again.", "error"); await reload(); return; }
      throw e;
    }
  });
  const raise = () => act.run("budget", async () => { setData(await api("POST", `/api/review/${token}/budget`, { proposal_id: v.proposal.id, max_total_cents: Math.round(Number(budget || 0) * 100) })); toast("Your limit was updated and ReCart rechecked every option."); });
  useEffect(() => {
    const need = v?.proposal?.conflict?.required_max_total_cents;
    if (v?.decisions?.includes("raise_budget") && need && !budget) setBudget((need / 100).toFixed(2));
  }, [v, budget]);
  const later = () => act.run("later", async () => { setData(await api("POST", `/api/review/${token}/accept-later-time`, { proposal_id: v.proposal.id })); });
  const refresh = () => act.run("refresh", async () => { setData(await api("POST", `/api/review/${token}/refresh`, {})); });

  if (loading && !v) return <><ReviewHeader /><main id="main" className="review"><Spinner label="Loading your order review" /></main></>;
  if (error || !v) {
    const expired = error instanceof ApiError && error.code === "review_link_expired";
    return (
      <><ReviewHeader /><main id="main" className="review">
        <h1>{expired ? "This review link has expired" : "This review link is not valid"}</h1>
        <p className="sub">{expired ? "For your protection, review links expire. Ask the store for a new link to see the current proposal." : "Check that you opened the complete link from the store. If it still does not work, ask the store for a new one."}</p>
        {!expired && error && !(error instanceof ApiError) && <ErrorBlock error={error} retry={reload} />}
      </main></>
    );
  }
  const p = v.proposal;
  const setup = p?.replacement ?? p?.conflict?.closest ?? null;
  const r = v.requirements;
  const goal = { localPeople: r.local_people, remoteGuests: r.remote_guests, hostPort: r.host_port, os: r.os, callApp: r.call_app };
  const title = ({
    awaiting_buyer: p?.outcome === "budget_conflict" ? "Your order needs a decision about its budget" : p?.outcome === "deadline_conflict" ? "Your order can only be ready later" : `${v.merchant.name} needs your approval for a changed order`,
    approved: "You approved this version", executing: "The store is applying your approved order", reconciling: "The store is confirming your order", completed: "Your order was updated",
    declined: "You declined this proposal", expired: "This proposal has expired", no_change_needed: "No change is needed", no_solution: "No safe replacement is available",
    action_required: "The store is updating its information", cancelled: "The store cancelled this recovery",
  } as Record<string, string>)[v.status] ?? "Your order";
  const canApprove = v.decisions.includes("approve");
  const required = p?.conflict?.required_max_total_cents;
  return (
    <>
      <ReviewHeader merchant={v.merchant.name} />
      <main id="main" className="review">
        <div className="btn-row small muted">Order {v.external_order_id} · {v.merchant.name}{v.merchant.kind === "sandbox" && <Pill>Sandbox store</Pill>}</div>
        <h1 style={{ marginTop: 8 }}>{title}</h1>
        {p && <p className="sub">{buyerSummary(v)}</p>}
        {v.status === "approved" && <Notice tone="confirmed" title={`Approved version ${p.version} ${p.decided_at ? `on ${when(p.decided_at)}` : ""}`}>The store now updates your order and settles the difference through its own checkout.</Notice>}
        {v.status === "completed" && <Notice tone="confirmed" title="Done">The store applied your approved order.</Notice>}
        {v.status === "declined" && <Notice title="Declined">The store has been told. Nothing changes without your approval.</Notice>}

        {p?.changes?.length > 0 && (
          <section style={{ marginTop: 28 }} aria-labelledby="chg-h">
            <h2 id="chg-h" style={{ marginBottom: 12 }}>What changes</h2>
            <ul className="change-list">
              {p.changes.map((c: any) => (
                <li key={c.role}>
                  <div className={`from ${c.after.length === 0 ? "gone" : ""}`}><span className="small" style={{ display: "flex", gap: 6, alignItems: "center" }}><RoleIcon role={c.role} />{ROLE[c.role] ?? c.role}</span>{c.before.length ? c.before.map((b: any) => `${b.quantity}× ${b.name}`).join(", ") : "Nothing before"}</div>
                  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <div className="to">{c.after.length ? c.after.map((a: any) => `${a.quantity}× ${a.name}`).join(", ") : "Removed"}</div>
                  <div className="why">{c.reason}</div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {setup && (
          <section style={{ marginTop: 28 }} aria-labelledby="setup-h">
            <h2 id="setup-h" style={{ marginBottom: 12 }}>{p.replacement ? "The complete setup" : "The closest complete setup"}</h2>
            <div className="panel"><SetupDiagram parts={partsOf(setup)} goal={goal} label="Proposed setup" /></div>
            <div className="compare" style={{ marginTop: 16 }}>
              <div><div className="k">Your original order</div><div className="v"><Money cents={p.original.totals.total_cents} /></div></div>
              <div><div className="k">{p.replacement ? "New total" : "This setup would cost"}</div><div className="v"><Money cents={setup.totals.total_cents} /></div></div>
              <div><div className="k">Difference{setup.budget ? ` · limit ${usd(setup.budget.max_total_cents)}` : ""}</div><div className="v"><Money cents={setup.difference_cents} signed /></div></div>
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>Totals include tax{setup.totals.shipping_cents ? " and shipping" : ""}. Items you already ordered keep the price you agreed to.</p>
            <Disclosure summary={`Every compatibility check (${setup.compatibility.length})`}>
              <Checks items={setup.compatibility.map((c: any) => ({ id: c.check, label: c.label, result: c.result, detail: c.detail, evidence: c.evidence }))} />
            </Disclosure>
            {p.single_item_swaps?.length > 0 && (
              <Disclosure summary="Why not just replace the missing item?">
                <Checks items={p.single_item_swaps.map((s: any) => ({ id: s.product_id, label: s.name, result: s.works ? "pass" : "fail", detail: s.works ? "works on its own" : s.reasons.join("; ") }))} />
              </Disclosure>
            )}
            <Disclosure summary="Parts and prices">
              <div className="table-wrap"><table className="data"><thead><tr><th>Part</th><th className="r">Qty</th><th className="r">Price</th></tr></thead><tbody>
                {setup.items.map((i: any) => <tr key={i.product_id} className={i.change === "kept" ? "" : "added"}><td><div className="item-name">{i.name}</div><div className="item-sub">{ROLE[i.role] ?? i.role}{i.change !== "kept" ? " · new" : ""}</div></td><td className="r">{i.quantity}</td><td className="r">{usd(i.line_total_cents)}</td></tr>)}
                {setup.removed_items.map((i: any) => <tr key={`x${i.product_id}`} className="removed"><td><div className="item-name">{i.name}</div><div className="item-sub">{i.reason === "unavailable" ? "unavailable" : "no longer needed"}</div></td><td className="r">{i.quantity}</td><td className="r">{usd(i.line_total_cents)}</td></tr>)}
              </tbody></table></div>
            </Disclosure>
          </section>
        )}
        {p && !setup && p.outcome === "no_supported_bundle" && <Notice tone="danger" title="No complete setup can be built from what is in stock">The store will contact you about your order. You have not been charged for any change.</Notice>}
        <Notice tone="action">{v.boundary}</Notice>
        <p className="small muted">Proposal version {p?.version} · expires {when(p?.expires_at)} · fingerprint <span className="mono">{p?.hash?.slice(0, 12)}</span></p>

        {(v.decisions.length > 0 || v.status === "expired") && (
          <div className="decision">
            <div className="btn-row">
              {canApprove && <button className="btn btn-primary" onClick={() => decide("approve")} disabled={!!act.busy}>{act.busy === "approve" ? <Spinner label="Recording your approval" /> : `Approve version ${p.version} · ${usd(setup.totals.total_cents)}`}</button>}
              {v.decisions.includes("raise_budget") && (
                <form className="btn-row" onSubmit={(e) => { e.preventDefault(); void raise(); }}>
                  <label htmlFor="limit" className="small">New all-in limit (USD)</label>
                  <input id="limit" className="input" style={{ width: 130 }} inputMode="decimal" placeholder={(required / 100).toFixed(2)} value={budget} onChange={(e) => setBudget(e.target.value)} />
                  <button className="btn btn-primary" type="submit" disabled={!!act.busy || !budget}>Update my limit</button>
                </form>
              )}
              {v.decisions.includes("accept_later_time") && <button className="btn btn-primary" onClick={later} disabled={!!act.busy}>Accept the later time</button>}
              {v.status === "expired" && <button className="btn btn-primary" onClick={refresh} disabled={!!act.busy}>Show current options</button>}
              {v.decisions.includes("decline") && <button className="btn btn-danger" onClick={() => decide("decline")} disabled={!!act.busy}>Decline</button>}
            </div>
            {canApprove && <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>Approving binds your consent to version {p.version} exactly. If stock or prices change first, you will see a new version instead.</p>}
            {v.decisions.includes("raise_budget") && <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>The closest complete setup needs at least {usd(required)}. Only you can change your limit; ReCart then checks every option again.</p>}
          </div>
        )}
        {!v.decisions.length && v.status !== "expired" && <p className="small muted" style={{ marginTop: 24 }}>{v.next_action.actor === "buyer" ? v.next_action.message : "There is nothing for you to do right now."}</p>}
        <div style={{ marginTop: 40 }}><Pill>Planning review: this page reserves no stock and creates no payment</Pill></div>
      </main>
    </>
  );
}
