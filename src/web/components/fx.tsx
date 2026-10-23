import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";

/** Motion is decoration only where it explains state; everything here stands still for reduced-motion users. */
export const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** The fixed backdrop: PayPal-blue aurora, a faint measurement grid and film grain. */
export function Atmosphere() {
  return <><div className="atmos" aria-hidden><i /></div><div className="gridlines" aria-hidden /><div className="grain" aria-hidden /></>;
}

export function useInView<T extends Element>(ref: RefObject<T | null>, rootMargin = "0px 0px -12% 0px") {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } }, { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin, seen]);
  return seen;
}

/** Fades and lifts its children into place the first time they scroll into view. */
export function Reveal({ children, delay = 0, className = "", as: Tag = "div", ...rest }: { children: ReactNode; delay?: 0 | 1 | 2 | 3 | 4 | 5; className?: string; as?: "div" | "section" | "li" | "article" } & Record<string, unknown>) {
  const ref = useRef<HTMLElement>(null);
  const seen = useInView(ref);
  const T = Tag as any;
  return <T ref={ref} className={`reveal ${delay ? `d${delay}` : ""} ${seen ? "in" : ""} ${className}`} {...rest}>{children}</T>;
}

/** Counts from zero to the value once visible (tabular figures, so nothing jumps). */
export function CountUp({ to, format = (n: number) => Math.round(n).toLocaleString("en-US"), duration = 1400 }: { to: number; format?: (n: number) => string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref);
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!seen) return;
    if (prefersReducedMotion()) { setV(to); return; }
    let raf = 0; const start = performance.now();
    const tick = (t: number) => { const p = Math.min(1, (t - start) / duration); setV(to * (1 - Math.pow(1 - p, 3))); if (p < 1) raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seen, to, duration]);
  // Reserve the final number's width so counting never reflows the surrounding text.
  return <span ref={ref} className="num" style={{ display: "inline-block", minWidth: `${format(to).length}ch`, textAlign: "inherit" }}>{format(v)}</span>;
}

/**
 * Types lines one after another, like a log being written. Deterministic text; reduced motion shows it at once.
 * The box never changes size: an invisible copy of its tallest state (the two longest lines) shares its grid cell,
 * so typing, wrapping and looping cannot shift the page.
 */
export function Typewriter({ lines, speed = 18, pause = 900, loop = true, className = "" }: { lines: string[]; speed?: number; pause?: number; loop?: boolean; className?: string }) {
  const [li, setLi] = useState(0);
  const [ci, setCi] = useState(0);
  const reduced = prefersReducedMotion();
  useEffect(() => {
    if (reduced) return;
    if (li >= lines.length) { if (!loop) return; const t = setTimeout(() => { setLi(0); setCi(0); }, 3500); return () => clearTimeout(t); }
    const line = lines[li]!;
    if (ci < line.length) { const t = setTimeout(() => setCi(ci + 1), speed + (/[.,—:]/.test(line[ci]!) ? 140 : 0)); return () => clearTimeout(t); }
    const t = setTimeout(() => { setLi(li + 1); setCi(0); }, pause);
    return () => clearTimeout(t);
  }, [li, ci, lines, speed, pause, loop, reduced]);
  if (reduced) return <div className={className}>{lines.map((l, i) => <p key={i} className="done" style={{ margin: 0 }}>{l}</p>)}</div>;
  const typing = li < lines.length;
  const doneIndex = typing ? li - 1 : lines.length - 1;
  // Two fixed slots (the finished line and the line being typed). Every line sits invisibly in each slot, so a slot is
  // always as tall as the tallest wrapped line. The typed line is laid out in full and revealed a character at a time,
  // with the caret drawn after the last revealed character: no box ever moves, so the page never reflows.
  const ghosts = lines.map((l, i) => <p key={`g${i}`} className="tw-ghost">{l}</p>);
  return (
    <div className={`typewriter ${className}`}>
      <div aria-hidden>
        <div className="tw-slot">{ghosts}{doneIndex >= 0 && <p key={`d${doneIndex}`} className="done">{lines[doneIndex]}</p>}</div>
        <div className="tw-slot">
          {ghosts}
          {typing && (
            <p key={`t${li}`} className={ci === 0 ? "tw-line at-start" : "tw-line"}>
              {[...lines[li]!].map((ch, i) => <span key={i} className={i < ci ? (i === ci - 1 ? "on cur" : "on") : undefined}>{ch}</span>)}
            </p>
          )}
        </div>
      </div>
      <span className="visually-hidden">{lines.join(" ")}</span>
    </div>
  );
}

export type ThreadAnchor = { ref: RefObject<HTMLElement | null> };
type Pt = { x: number; y: number };

/**
 * A signal cable down the left margin of a long page. It passes a knot beside each section, draws itself as the page
 * scrolls, and a pulse of light travels along it: the same signal the home page's setup diagram carries.
 */
export function SignalThread({ container, anchors }: { container: RefObject<HTMLElement | null>; anchors: ThreadAnchor[] }) {
  const [geom, setGeom] = useState<{ w: number; h: number; pts: Pt[] }>({ w: 0, h: 0, pts: [] });
  const [progress, setProgress] = useState(0);
  const pathRef = useRef<SVGPathElement | null>(null);
  const [len, setLen] = useState(1);
  useLayoutEffect(() => {
    const measure = () => {
      const c = container.current; if (!c) return;
      const cr = c.getBoundingClientRect();
      const pts = anchors.map((a) => {
        const el = a.ref.current; if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.max(14, r.left - cr.left - 34), y: r.top - cr.top + 22 };
      }).filter((p): p is Pt => !!p);
      setGeom({ w: cr.width, h: c.offsetHeight, pts });
    };
    measure();
    const ro = new ResizeObserver(measure); if (container.current) ro.observe(container.current);
    window.addEventListener("resize", measure);
    const t = setTimeout(measure, 900);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); clearTimeout(t); };
  }, [container, anchors]);
  useEffect(() => { if (pathRef.current) setLen(pathRef.current.getTotalLength() || 1); }, [geom]);
  useEffect(() => {
    const onScroll = () => {
      const c = container.current; if (!c) return;
      const r = c.getBoundingClientRect();
      setProgress(Math.min(1, Math.max(0, (window.innerHeight * 0.75 - r.top) / r.height)));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [container, geom]);
  if (geom.pts.length < 2) return null;
  const [first, ...rest] = geom.pts;
  let d = `M${first!.x} ${first!.y}`;
  let prev = first!;
  for (const p of rest) {
    const mid = (prev.y + p.y) / 2;
    d += ` C ${prev.x} ${mid}, ${p.x} ${mid}, ${p.x} ${p.y}`;
    prev = p;
  }
  const reached = progress * (geom.pts[geom.pts.length - 1]!.y - first!.y) + first!.y + 40;
  return (
    <svg className="thread" width={geom.w} height={geom.h} viewBox={`0 0 ${geom.w} ${geom.h}`} aria-hidden>
      <defs>
        <linearGradient id="threadGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#008CFF" /><stop offset="100%" stopColor="#60CDFF" /></linearGradient>
      </defs>
      <path d={d} className="thread-ghost" />
      <path ref={pathRef} d={d} className="thread-ink" style={{ strokeDasharray: len, strokeDashoffset: len * (1 - progress) }} />
      {geom.pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r="5.5" className={`thread-knot ${p.y <= reached ? "on" : ""}`} />)}
      {!prefersReducedMotion() && <circle r="3.2" className="thread-pulse"><animateMotion dur="9s" repeatCount="indefinite" path={d} /></circle>}
    </svg>
  );
}
