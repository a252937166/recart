import { useEffect, useRef, useState } from "react";

/** Activity only: the signal is decorative, and elapsed time is not a progress estimate. */
export function DraftWaiting() {
  const ref = useRef<HTMLDivElement>(null);
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [active, setActive] = useState(false);

  useEffect(() => {
    let inView = typeof IntersectionObserver === "undefined";
    let timer: number | undefined;
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    const update = () => {
      const visible = document.visibilityState !== "hidden" && inView;
      setActive(visible);
      window.clearInterval(timer);
      timer = undefined;
      if (visible) {
        tick();
        timer = window.setInterval(tick, 1000);
      }
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false;
      update();
    });
    if (ref.current) observer?.observe(ref.current);
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
      observer?.disconnect();
    };
  }, []);

  const takingLonger = elapsed >= 30;
  return (
    <div className="draft-waiting" ref={ref} data-active={active}>
      <svg className="draft-waiting-signal" viewBox="0 0 128 64" aria-hidden="true" focusable="false">
        <path className="draft-waiting-track" d="M4 32h8l4-8 6 16 7-27 7 38 7-30 6 19 4-8h35" />
        <path className="draft-waiting-pulse" pathLength="1" d="M4 32h8l4-8 6 16 7-27 7 38 7-30 6 19 4-8h35" />
        <rect className="draft-waiting-sheet" x="88" y="10" width="34" height="44" rx="4" />
        <path className="draft-waiting-lines" d="M96 23h18M96 32h13M96 41h18" />
      </svg>
      <div className="draft-waiting-copy">
        <div role="status" aria-live="polite" aria-atomic="true">
          <p className="draft-waiting-title">{takingLonger ? "Still waiting for the AI helper" : "Preparing your draft"}</p>
          <p className="draft-waiting-detail">{takingLonger ? "This is taking longer than usual. Keep this page open while the AI finishes reading your request." : "The AI is reading your words. You’ll review the details before continuing."}</p>
        </div>
        <p className="draft-waiting-time" aria-live="off"><span className="num">{elapsed}s</span> elapsed</p>
      </div>
    </div>
  );
}
