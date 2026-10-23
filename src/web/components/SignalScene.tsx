import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./fx";

/**
 * The home page's live scene. A podcast setup is drawn as its signal path with audio flowing through it; the
 * interface goes missing and every connected path breaks; ReCart checks every combination; the rebuilt path lights
 * up; PayPal's money rail runs authorize → void → re-approve → capture. Figures come from the planner's real output.
 */
export interface SceneFigures { originalCents: number; newCents: number; differenceCents: number; underLimitCents: number; combinations: number; complete: number }

const PHASES = [
  { ms: 3400, title: "Order approved", text: "Two mics into a USB-C interface, one cable into the laptop, a remote guest on Zoom. PayPal holds the total; nothing is captured yet." },
  { ms: 3000, title: "The interface is missing", text: "The packing check finds no interface. The mics, the computer link and the guest's loopback route all break, so ReCart voids the hold first." },
  { ms: 3600, title: "Checking every combination", text: "ReCart's solver tests each in-stock bundle against inputs, phantom power, headphone feeds, routing, the computer port, stock and budget." },
  { ms: 3200, title: "Rebuilt, not just swapped", text: "A USB-B interface fits only with a USB-B cable and a USB-A to USB-C adapter. ReCart proposes all three, within the buyer's limit." },
  { ms: 3200, title: "Approved and captured once", text: "The buyer approves the exact new total in PayPal. The store confirms the goods and PayPal captures it once." },
] as const;

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const COLS = 24, ROWS = 4, CELLS = COLS * ROWS;
const PASS = new Set([58, 77, 91]);

export function SignalScene({ fig }: { fig: SceneFigures }) {
  const reduced = prefersReducedMotion();
  const [phase, setPhase] = useState(reduced ? 3 : 0);
  // Plays on its own unless the visitor prefers reduced motion; the Play/Pause button and the step buttons stop it.
  const [playing, setPlaying] = useState(!reduced);
  const [scan, setScan] = useState(0);
  const [cycle, setCycle] = useState(0);
  const timer = useRef<number | null>(null);
  const paused = !playing;

  useEffect(() => {
    if (!playing) return;
    timer.current = window.setTimeout(() => { setPhase((p) => (p + 1) % PHASES.length); if (phase === PHASES.length - 1) setCycle((c) => c + 1); }, PHASES[phase]!.ms);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [phase, playing]);

  useEffect(() => {
    if (phase !== 2) { setScan(phase > 2 ? 1 : 0); return; }
    if (!playing) { setScan(1); return; }
    let raf = 0; const start = performance.now(); const dur = PHASES[2].ms * 0.85;
    const tick = (t: number) => { const p = Math.min(1, (t - start) / dur); setScan(p); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, playing, cycle]);

  const missing = phase === 1 || phase === 2;
  const rebuilt = phase >= 3;
  const flowing = phase === 0 || rebuilt;
  const wire = (newPart = false) => (missing ? "broken" : rebuilt && newPart ? "new" : "live");
  const checked = Math.round(scan * fig.combinations);
  const rail = [
    { label: "Authorize hold", amt: usd(fig.originalCents), on: phase === 0, done: phase > 0, cls: "" },
    { label: "Void the hold", amt: "not charged", on: phase === 1 || phase === 2, done: phase > 2, cls: "void" },
    { label: "Buyer re‑approves", amt: usd(fig.newCents), on: phase === 3, done: phase > 3, cls: "" },
    { label: "Capture once", amt: usd(fig.newCents), on: phase === 4, done: false, cls: "" },
  ];
  // Each phase's readout; all of them share one grid cell, so the console never changes size.
  const readouts = [
    { tone: "", big: "11 / 11 checks pass", lines: [`total ${usd(fig.originalCents)} · hold only`] },
    { tone: "bad", big: "4 paths broken", lines: ["mics · computer · guest · phones"] },
    { tone: "bad", big: "single swaps: 0 / 4 work", lines: ["cable mismatch · no loopback · budget", "whole-setup search running"] },
    { tone: "good", big: `${usd(fig.differenceCents).replace("$", "+$")} vs original`, lines: [`${usd(fig.underLimitCents)} under the limit`, "3 parts change · 11 / 11 checks pass"] },
  ];
  const readout = Math.min(phase, 3);
  // A part's status tag sits on its top edge, clear of both text lines.
  const Node = ({ x, y, w, h = 74, title, sub, cls = "" }: { x: number; y: number; w: number; h?: number; title: string; sub: string; cls?: string }) => {
    const [ty, sy] = h >= 70 ? [30, 52] : h >= 50 ? [22, 40] : [19, 36];
    const tag = cls.includes("missing") ? { text: "MISSING", w: 54, fill: "#F87171", ink: "#1A0505" } : cls.includes("new") ? { text: "NEW", w: 34, fill: "#34D399", ink: "#03140D" } : null;
    return (
      <g className={`sg-node ${cls}`}>
        <rect className="box" x={x} y={y} width={w} height={h} rx="10" />
        <text x={x + 12} y={y + ty}>{title}</text>
        <text className="sub" x={x + 12} y={y + sy}>{sub}</text>
        {tag && <g><rect x={x + w - tag.w - 10} y={y - 7.5} width={tag.w} height="15" rx="7.5" fill={tag.fill} /><text x={x + w - 10 - tag.w / 2} y={y + 3.5} textAnchor="middle" style={{ fill: tag.ink, font: "700 9px var(--display)" }}>{tag.text}</text></g>}
      </g>
    );
  };
  const Wire = ({ d, state }: { d: string; state: string }) => (
    <g>
      <path d={d} className={`sg-wire ${state}`} />
      {flowing && state !== "broken" && <path d={d} className={`sg-flow ${state === "new" ? "new" : ""}`} />}
    </g>
  );
  const iface = { title: rebuilt ? "2-in USB-B" : "2-in USB-C", sub: rebuilt ? "loopback · USB-B" : "loopback · USB-C", cls: missing ? "missing" : rebuilt ? "new" : "" };
  const cable = { title: rebuilt ? "USB-B → USB-A" : "USB-C cable", sub: rebuilt ? "cable · 1 m" : "C → C · 1 m", cls: rebuilt ? "new" : "" };
  const guest = { sub: missing ? "can't hear the room" : "Zoom · loopback", cls: missing ? "missing" : "" };
  const label = `${PHASES[phase]!.title}. ${PHASES[phase]!.text}`;

  return (
    <div className="scene">
      <div className="scene-top">
        <span className="rec"><span className="dot live" style={{ color: missing ? "#F87171" : "#34D399" }} />{missing ? "SIGNAL LOST" : "SIGNAL OK"}</span>
        <span>recovery.plan · {phase + 1}/{PHASES.length}</span>
      </div>
      {/* The signal chain, drawn across on wide scenes and top to bottom on narrow ones, so labels stay readable. */}
      <svg className="sg-chain sg-wide" viewBox="0 40 720 172" role="img" aria-label={label}>
        <Wire d="M134 87 L166 87" state={wire()} />
        <Wire d="M316 87 L356 87" state={wire(true)} />
        <Wire d="M484 87 L608 87" state={wire(true)} />
        <Wire d="M241 124 L241 160" state={wire()} />
        <Wire d="M316 112 C 420 112, 450 182, 540 182" state={wire()} />
        <Node x={16} y={50} w={118} title="2× XLR mics" sub="dynamic · XLR" />
        <Node x={166} y={50} w={150} {...iface} />
        <Node x={356} y={50} w={128} {...cable} />
        <Node x={500} y={50} w={92} title="Adapter" sub="USB-A → C" cls={rebuilt ? "new" : "ghost"} />
        <Node x={608} y={50} w={104} title="Laptop" sub="USB-C · Mac" cls="host" />
        <Node x={166} y={160} w={150} h={44} title="2× headphones" sub="one feed each" />
        <Node x={540} y={160} w={172} h={44} title="Remote guest" {...guest} />
        <text className="sg-label" x="134" y="78" textAnchor="start" dx="6">XLR</text>
      </svg>
      <svg className="sg-chain sg-narrow" viewBox="0 0 340 372" role="img" aria-label={label}>
        <Wire d="M92 60 L92 84" state={wire()} />
        <Wire d="M254 84 L254 60" state={wire()} />
        <Wire d="M92 136 L92 160" state={wire(true)} />
        <Wire d="M92 212 L92 312" state={wire(true)} />
        <Wire d="M290 136 L290 312" state={wire()} />
        <Node x={16} y={8} w={152} h={52} title="2× XLR mics" sub="dynamic · XLR" />
        <Node x={184} y={8} w={140} h={52} title="2× headphones" sub="one feed each" />
        <Node x={16} y={84} w={308} h={52} {...iface} />
        <Node x={16} y={160} w={152} h={52} {...cable} />
        <Node x={16} y={236} w={152} h={52} title="Adapter" sub="USB-A → C" cls={rebuilt ? "new" : "ghost"} />
        <Node x={16} y={312} w={120} h={52} title="Laptop" sub="USB-C · Mac" cls="host" />
        <Node x={152} y={312} w={172} h={52} title="Remote guest" {...guest} />
        <text className="sg-label" x="98" y="76">XLR</text>
      </svg>

      <div className="sg-console" aria-hidden>
        <div className="sg-solver">
          <div className="sg-cap sg-stack">
            <span className={phase < 2 ? "on" : ""}>solver idle</span>
            <span className={phase === 2 ? "on" : ""}>solve(): {checked} / {fig.combinations} combinations</span>
            <span className={phase > 2 ? "on" : ""}>solve(): {fig.combinations} checked · {fig.complete} complete</span>
          </div>
          <svg className="sg-grid" viewBox="0 0 444 68">
            <defs><linearGradient id="scanGrad" x1="0" x2="1"><stop offset="0" stopColor="#60CDFF" stopOpacity="0" /><stop offset="1" stopColor="#60CDFF" stopOpacity="0.55" /></linearGradient></defs>
            {Array.from({ length: CELLS }, (_, i) => {
              const col = i % COLS, row = Math.floor(i / COLS);
              const evaluated = (col + row * 0.15) / COLS < scan;
              const fill = !evaluated ? "rgba(140,170,230,0.12)" : PASS.has(i) ? "#34D399" : "rgba(248,113,113,0.45)";
              return <rect key={i} className="sg-cell" x={col * 18.5} y={4 + row * 15} width="15" height="11" rx="2" fill={fill} opacity={phase < 2 ? 0.5 : 1} />;
            })}
            {phase === 2 && <rect className="sg-scan" x={scan * COLS * 18.5 - 40} y="0" width="40" height={ROWS * 15 + 6} />}
          </svg>
        </div>
        <div className="sg-readout sg-stack">
          {readouts.map((r, i) => (
            <div key={i} className={`${r.tone}${i === readout ? " on" : ""}`}>
              <div className="big">{r.big}</div>
              {r.lines.map((l) => <div key={l} className="line">{l}</div>)}
            </div>
          ))}
        </div>
      </div>

      <div className="sg-money" aria-hidden>
        <div className="sg-cap">money path · PayPal Sandbox</div>
        <ol className="sg-rail">
          {rail.map((r) => (
            <li key={r.label} className={`${r.cls}${r.on ? " on" : ""}${r.done ? " done" : ""}`}>
              <span className="t"><span className="tick">✓</span>{r.label}</span>
              <span className="amt">{r.amt}</span>
            </li>
          ))}
        </ol>
      </div>

      {/* Every caption shares one grid cell, so the scene is always as tall as its longest caption and never resizes. */}
      <div className="phase-caption">
        {PHASES.map((p, i) => (
          <div key={p.title} className={i === phase ? "on" : ""} aria-hidden={i !== phase}>
            <div className="phase-title">{p.title}</div>
            <p className="phase-text">{p.text}</p>
          </div>
        ))}
      </div>
      <div className="scene-controls">
        <button type="button" className="scene-play" onClick={() => setPlaying((v) => !v)} aria-pressed={!playing} aria-label={playing ? "Pause the scene" : "Play the scene"}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>{playing ? <path d="M3 1.5v9M9 1.5v9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" /> : <path d="M3 1.4v9.2L10.4 6z" fill="currentColor" />}</svg>
          <span className="fine">{playing ? "Pause" : "Play"}</span>
        </button>
        <div className={`scene-steps ${paused ? "paused" : ""}`} role="group" aria-label="Scene steps" style={{ ["--phase-ms" as any]: `${PHASES[phase]!.ms}ms` }}>
          {PHASES.map((p, i) => <button key={`${i}-${cycle}-${i === phase ? phase : ""}`} className={i === phase ? "on" : i < phase ? "done" : ""} aria-label={`Step ${i + 1}: ${p.title}`} aria-current={i === phase ? "step" : undefined} onClick={() => { setPhase(i); setPlaying(false); }} />)}
        </div>
      </div>
    </div>
  );
}
