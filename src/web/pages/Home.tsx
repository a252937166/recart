import { useEffect, useMemo, useRef, useState } from "react";
import { CountUp, Reveal, SignalThread, Typewriter, type ThreadAnchor } from "../components/fx";
import { Page } from "../components/Shell";
import { SetupDiagram, type DiagramGoal, type DiagramPart } from "../components/SetupDiagram";
import { SignalScene } from "../components/SignalScene";
import { PayPalLogo, PayPalSection, type LiveEvidence } from "../components/Sponsor";
import { ErrorBlock, Money, Pill, Spinner } from "../components/ui";
import { Link, useFetch, usd, type Config } from "../lib/core";

interface Situation { id: string; title: string; budget_cents: number; proposal: any }
interface Showcase { store: string; requirements: any; catalog: { product_id: string; name: string; role: string; price_cents: number; attributes: any }[]; situations: Situation[] }

const TAB_LABEL: Record<string, string> = { recovered: "Another setup is in stock", needs_buyer: "Only a pricier fix exists", no_safe_replacement: "Nothing safe is in stock" };

/** Steps of one situation, each a diagram plus one sentence. Everything comes from the planner's real output. */
function stepsFor(s: Situation, catalog: Showcase["catalog"]) {
  const p = s.proposal;
  const attrs = new Map(catalog.map((c) => [c.product_id, c.attributes]));
  const missingId = p.unavailable_items[0].product_id;
  const original: DiagramPart[] = p.original.items.map((i: any) => ({ id: i.product_id, name: i.name, role: i.role, qty: i.quantity, attrs: attrs.get(i.product_id) }));
  const missing = original.map((x) => (x.id === missingId ? { ...x, status: "missing" as const } : x));
  const swap = p.single_item_swaps.find((w: any) => w.reasons.some((r: string) => r.includes("cable"))) ?? p.single_item_swaps[0];
  const swapped = swap ? original.map((x) => (x.id === missingId ? { id: swap.product_id, name: swap.name, role: x.role, qty: x.qty, status: "added" as const, attrs: attrs.get(swap.product_id) } : x)) : null;
  const setup = (r: any): DiagramPart[] => [
    ...r.items.map((i: any) => ({ id: i.product_id, name: i.name, role: i.role, qty: i.quantity, status: i.change === "kept" ? "kept" : "added", attrs: attrs.get(i.product_id) })),
    ...r.removed_items.map((i: any) => ({ id: i.product_id, name: i.name, role: i.role, qty: i.quantity, status: "removed", attrs: attrs.get(i.product_id) })),
  ];
  const missingName = p.unavailable_items[0].name;
  const steps: { title: string; parts: DiagramPart[]; text: string; money?: { from: number; to?: number; diff?: number; left?: number | null; need?: number } }[] = [
    { title: "Original order", parts: original, text: `Two people in the room and a remote guest on Zoom, on a USB-C Mac, within ${usd(s.budget_cents)} all-in. The buyer approved ${usd(p.original.totals.total_cents)}.`, money: { from: p.original.totals.total_cents } },
    { title: "One part is missing", parts: missing, text: `The ${missingName} cannot be found at packing. Without it, the mics, the computer connection and the remote guest's audio all stop working.` },
  ];
  if (swapped && swap) steps.push({ title: "A like-for-like swap fails", parts: swapped, text: `Swapping in the ${swap.name} alone does not work: ${swap.reasons.join(", ")}. Every single-part swap fails, so connected parts must change too.` });
  if (p.outcome === "proposal_ready") {
    const r = p.replacement;
    steps.push({ title: "ReCart rebuilds the setup", parts: setup(r), text: `ReCart checked ${p.search.combinations_checked} combinations. The rebuilt setup adds ${r.items.filter((i: any) => i.change !== "kept").map((i: any) => i.name).join(", ")}, and every compatibility check passes.` });
    steps.push({ title: "The buyer approves the new total", parts: setup(r), text: `Nothing is charged until the buyer approves this exact version. The first hold is released first.`, money: { from: p.original.totals.total_cents, to: r.totals.total_cents, diff: r.difference_cents, left: r.budget?.remaining_cents ?? null } });
  } else if (p.outcome === "budget_conflict") {
    const c = p.conflict;
    steps.push({ title: "The fix is over the limit", parts: setup(c.closest), text: `The only complete setup costs ${usd(c.closest.totals.total_cents)}, above the buyer's ${usd(c.current_max_total_cents)} limit. ReCart stops and asks; it never raises a limit on its own.`, money: { from: p.original.totals.total_cents, to: c.closest.totals.total_cents, diff: c.closest.difference_cents, need: c.required_max_total_cents } });
  } else {
    steps.push({ title: "No safe setup exists", parts: missing, text: `ReCart checked ${p.search.combinations_checked} combinations and none works with the parts in stock. ${p.search.blocking_reasons[0] ? `${p.search.blocking_reasons[0].charAt(0).toUpperCase()}${p.search.blocking_reasons[0].slice(1)}. ` : ""}The hold is released and nothing is charged.` });
  }
  return steps;
}

function RecoveryPreview({ data }: { data: Showcase }) {
  const [which, setWhich] = useState(0);
  const [step, setStep] = useState(0);
  const situation = data.situations[which]!;
  const steps = useMemo(() => stepsFor(situation, data.catalog), [situation, data.catalog]);
  const cur = steps[Math.min(step, steps.length - 1)]!;
  useEffect(() => setStep(0), [which]);
  const r = data.requirements;
  const goal: DiagramGoal = { localPeople: r.local_people, remoteGuests: r.remote_guests, hostPort: r.host_port, os: r.os, callApp: r.call_app };
  return (
    <div className="preview" aria-label="Interactive recovery example">
      <div className="preview-tabs" role="group" aria-label="Store situation">
        {data.situations.map((s, i) => <button key={s.id} aria-pressed={i === which} onClick={() => setWhich(i)}>{TAB_LABEL[s.id] ?? s.title}</button>)}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ fontSize: "var(--s2)" }}>{cur.title}</h2>
        <span className="small muted num">Step {Math.min(step, steps.length - 1) + 1} of {steps.length}</span>
      </div>
      <div key={`${which}-${step}`} className="enter" style={{ marginTop: 14 }}>
        <SetupDiagram parts={cur.parts} goal={goal} label={`${cur.title}: setup diagram`} />
        {cur.money && (
          <div className="compare" style={{ marginTop: 14 }}>
            <div><div className="k">Original total</div><div className="v"><Money cents={cur.money.from} /></div></div>
            {cur.money.to !== undefined && <div><div className="k">{cur.money.need ? "Closest complete setup" : "New total"}</div><div className="v"><Money cents={cur.money.to} /></div></div>}
            {cur.money.diff !== undefined && <div><div className="k">{cur.money.need ? `Needs a limit of ${usd(cur.money.need)}` : cur.money.left != null ? `Difference · ${usd(cur.money.left)} under limit` : "Difference"}</div><div className="v"><Money cents={cur.money.diff} signed /></div></div>}
          </div>
        )}
      </div>
      <p className="preview-caption" aria-live="polite">{cur.text}</p>
      <div className="steps">
        <div className="step-dots" aria-hidden>{steps.map((_, i) => <span key={i} className={i <= step ? "on" : ""} />)}</div>
        <div className="btn-row" style={{ marginLeft: "auto" }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>Back</button>
          {step < steps.length - 1
            ? <button className="btn btn-primary btn-sm" onClick={() => setStep((s) => s + 1)}>Next</button>
            : <button className="btn btn-secondary btn-sm" onClick={() => setStep(0)}>Replay</button>}
        </div>
      </div>
      <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>Computed live by ReCart's planner over {data.store}.</p>
    </div>
  );
}

const LOG = [
  "store › packing check: 2-in USB-C interface not on the shelf",
  "paypal › void authorization: hold released, buyer not charged",
  "solver › 480 combinations checked against 11 rules · 3 complete",
  "recart › new setup: USB-B interface + USB-B→USB-A cable + adapter · +$45.36",
  "buyer › approves version 2 in PayPal · store confirms · captured once",
];

export function Home({ cfg }: { cfg: Config | null }) {
  const { data, error, loading, reload } = useFetch<Showcase>("/api/showcase/preview");
  const ev = useFetch<LiveEvidence>("/api/evidence");
  const caps = useFetch<any>("/v1/capabilities");
  const ref = useFetch<any>("/api/integrations/reference");
  const main = useRef<HTMLDivElement>(null);
  const a1 = useRef<HTMLDivElement>(null), a2 = useRef<HTMLDivElement>(null), a3 = useRef<HTMLDivElement>(null), a4 = useRef<HTMLDivElement>(null), a5 = useRef<HTMLDivElement>(null), a6 = useRef<HTMLDivElement>(null), a7 = useRef<HTMLDivElement>(null);
  const anchors = useMemo<ThreadAnchor[]>(() => [a1, a2, a3, a4, a5, a6, a7].map((r) => ({ ref: r })), []);
  const recovered = data?.situations.find((s) => s.id === "recovered")?.proposal;
  const fig = recovered ? {
    originalCents: recovered.original.totals.total_cents, newCents: recovered.replacement.totals.total_cents, differenceCents: recovered.replacement.difference_cents,
    underLimitCents: recovered.replacement.budget?.remaining_cents ?? 0, combinations: recovered.search.combinations_checked, complete: recovered.search.feasible_count,
  } : null;
  const live = ev.data?.live;
  const shop = ref.data?.data?.[0];
  return (
    <Page cfg={cfg}>
      <div className="home-main" ref={main}>
        <SignalThread container={main} anchors={anchors} />
        <section className="hero">
          <div className="wrap hero-grid">
            <div ref={a1}>
              <a className="sponsor-lockup enter" href="#paypal">
                <span className="marks"><PayPalLogo height={28} /></span>
                <span className="txt">Built on the <b>PayPal Developer Platform</b><br />for the PayPal AI Hackathon</span>
              </a>
              <h1 className="enter" style={{ animationDelay: "80ms" }}>When one part goes missing, ReCart <span className="glow-text">rebuilds the whole order.</span></h1>
              <p className="lede enter" style={{ animationDelay: "160ms" }}>A missing audio interface can break the cable, the adapter and the remote guest's audio. ReCart checks every in-stock combination, explains exactly what changes, and PayPal captures the new total only after the buyer approves it.</p>
              <Typewriter lines={LOG} className="monologue mono-log" />
              <div className="btn-row" style={{ marginTop: 22 }}>
                <Link to="/demo" className="btn btn-primary">Start guided demo</Link>
                <Link to="/developers" className="btn btn-secondary">Explore the API</Link>
              </div>
              <div className="ticker" aria-label="Live PayPal Sandbox activity">
                <span className="live"><span className="dot live" />live</span>
                <span><b>{live ? live.authorizations : "…"}</b> PayPal holds</span><span className="sep">/</span>
                <span><b>{live ? live.voids : "…"}</b> voided</span><span className="sep">/</span>
                <span><b>{live ? live.captures : "…"}</b> captured</span><span className="sep">/</span>
                <span><b>{live ? live.webhooks_verified : "…"}</b> webhooks verified</span>
              </div>
              <p className="hero-note">About five minutes. PayPal Sandbox and fictional products: no real money moves.</p>
            </div>
            <div className="enter" style={{ animationDelay: "220ms" }}>
              {fig ? <SignalScene fig={fig} /> : error ? <ErrorBlock error={error} retry={reload} title="The live scene could not be computed" /> : <div className="scene" aria-busy="true"><Spinner label="Computing the live scene" /></div>}
            </div>
          </div>
        </section>

        <section className="section" id="paypal">
          <div className="wrap">
            <div className="section-head" ref={a2}>
              <div className="eyebrow"><span className="dot" style={{ color: "#60CDFF" }} />sponsor · what PayPal makes possible</div>
              <h2>PayPal moves the money. ReCart decides what to ask it to do.</h2>
              <p>Six PayPal capabilities carry the parts of a recovery that must never go wrong: holding instead of charging, releasing the old money, retrying without double charges, learning the truth after a tab closes, and getting a fresh approval for every changed total.</p>
            </div>
            <PayPalSection ev={ev.data} />
          </div>
        </section>

        <section className="section" id="how">
          <div className="wrap">
            <div className="section-head" ref={a3}>
              <div className="eyebrow"><span className="dot" style={{ color: "#60CDFF" }} />the recovery</div>
              <h2>From a missing part to an approved replacement</h2>
              <p>Language helps people say what they need. Code decides what works. Payment follows only the buyer's explicit approval.</p>
            </div>
            <ol className="flow">
              <Reveal as="li" delay={1}><span className="n">01</span><h3>Confirm the need</h3><p>AI drafts the requirements from the buyer's own words and quotes them. The buyer corrects and confirms; nothing is guessed.</p></Reveal>
              <Reveal as="li" delay={2}><span className="n">02</span><h3>Check every combination</h3><p>A deterministic solver tests each in-stock bundle: <CountUp to={fig?.combinations ?? 480} /> combinations for the example, in milliseconds.</p></Reveal>
              <Reveal as="li" delay={3}><span className="n">03</span><h3>Explain the change</h3><p>Changed parts, the reason for each, every passed check and the exact price difference, in one view.</p></Reveal>
              <Reveal as="li" delay={4}><span className="n">04</span><h3>Approve one exact version</h3><p>The buyer approves a hashed proposal. A stock or price change produces a new version to review.</p></Reveal>
              <Reveal as="li" delay={5}><span className="n">05</span><h3>Settle with PayPal</h3><p>The first hold is voided, the new total is authorized and captured once, after the store confirms the goods.</p></Reveal>
            </ol>
          </div>
        </section>

        <section className="section" id="example">
          <div className="wrap">
            <div className="section-head" ref={a4}>
              <div className="eyebrow"><span className="dot" style={{ color: "#60CDFF" }} />try it · three store situations</div>
              <h2>Step through a real recovery</h2>
              <p>Each step is the planner's actual output for the fictional store, not an illustration.</p>
            </div>
            <Reveal>
              {loading && <div className="preview" aria-busy="true"><Spinner label="Computing the example" /></div>}
              {error && <ErrorBlock error={error} retry={reload} title="The live example could not be computed" />}
              {data && <RecoveryPreview data={data} />}
            </Reveal>
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className="section-head" ref={a5}>
              <div className="eyebrow"><span className="dot" style={{ color: "#F87171" }} />guardrails</div>
              <h2>What ReCart will not do</h2>
              <p>The rules hold in every interface: browser, API and AI agent.</p>
            </div>
            <div className="promises">
              <Reveal delay={1}><span className="x">✕</span><h3>Raise a budget</h3><p>If the only fix costs more, ReCart shows the amount and stops. Only the buyer can raise a limit.</p></Reveal>
              <Reveal delay={2}><span className="x">✕</span><h3>Assume compatibility</h3><p>An undocumented fact is unknown, never a yes. The store is asked to document it.</p></Reveal>
              <Reveal delay={3}><span className="x">✕</span><h3>Charge without fresh approval</h3><p>A changed order is a new version with a new hash and a new PayPal approval.</p></Reveal>
              <Reveal delay={4}><span className="x">✕</span><h3>Hide a dead end</h3><p>When nothing works, ReCart says which constraint blocks it, voids the hold and closes.</p></Reveal>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className="section-head" ref={a6}>
              <div className="eyebrow"><span className="dot" style={{ color: "#60CDFF" }} />three entry points</div>
              <h2>One planning engine, three ways in</h2>
            </div>
            <div className="entry-grid">
              <Reveal className="entry" delay={1}><Pill tone="confirmed" dot>Live</Pill><h3>Guided demo</h3><p>Play the buyer and the store in a self-contained shop with real PayPal Sandbox holds, voids and captures.</p><span className="meta">{live ? `${live.sessions} sessions so far` : ""}</span><Link to="/demo" className="btn btn-secondary">Start the demo</Link></Reveal>
              <Reveal className="entry" delay={2}><Pill tone="confirmed" dot>Live</Pill><h3>Merchant API</h3><p>Send catalog and stock in a standard format, open recoveries and receive signed status callbacks.</p><span className="meta">{caps.data ? `${caps.data.api_version} · OpenAPI 3.1 · ${caps.data.features.webhooks.events.length} event types` : ""}</span><Link to="/developers" className="btn btn-secondary">Try the sandbox</Link></Reveal>
              <Reveal className="entry" delay={3}><Pill tone="confirmed" dot>Live</Pill><h3>AI agents (MCP)</h3><p>A remote MCP server gives agents the planning tools. Approval and payment stay with the buyer.</p><span className="meta">{caps.data ? `${caps.data.features.mcp.tools.length} tools · Streamable HTTP` : ""}</span><Link to="/developers#mcp" className="btn btn-secondary">Connect an agent</Link></Reveal>
            </div>
          </div>
        </section>

        <section className="section">
          <div className="wrap">
            <div className="section-head" ref={a7}>
              <div className="eyebrow"><span className="dot" style={{ color: "#60CDFF" }} />also built with</div>
              <h2>Around the PayPal core</h2>
              <p>Other technologies ReCart uses alongside PayPal.</p>
            </div>
            <div className="also">
              <Reveal className="chip" delay={1}><b>GPT-6 Luna via a self-hosted Codex gateway</b><span>Drafts requirements and explanations; Claude Haiku 4.5 via Astropods steps in only while the gateway is down. Code checks every value either way.</span></Reveal>
              <Reveal className="chip" delay={2}><b>Model Context Protocol</b><span>The remote server agents connect to; same keys and rules as REST.</span></Reveal>
              <Reveal className="chip" delay={3}><b>Shopify development store</b><span>Read-only reference integration{shop ? `: ${shop.catalog.active} products, ${shop.inventory.fresh_units} units synced` : ""}.</span></Reveal>
              <Reveal className="chip" delay={4}><b>PostgreSQL ledger</b><span>Every payment operation, proposal version and event is stored before it is acted on.</span></Reveal>
            </div>
          </div>
        </section>

        <div className="wrap">
          <Reveal className="closing">
            <div><h2>See a recovery end to end</h2><p>Buyer view, store view and real PayPal Sandbox payments, guided step by step.</p></div>
            <div className="btn-row"><Link to="/demo" className="btn btn-primary">Start guided demo</Link><span style={{ display: "inline-flex", alignItems: "center", gap: 8 }} className="small muted">powered by <PayPalLogo height={18} /></span></div>
          </Reveal>
        </div>
      </div>
    </Page>
  );
}
