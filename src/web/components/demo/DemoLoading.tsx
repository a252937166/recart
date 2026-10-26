import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/** Shared by session creation and the first state read; no estimated progress or invented preparation stages. */
export function DemoLoading({ storyTitle }: { storyTitle?: string }) {
  const ref = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const startedAt = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [active, setActive] = useState(false);
  const titleId = useId();

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    heading.current?.focus({ preventScroll: true });
  }, []);

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

  return (
    <section className="demo-loading wrap" ref={ref} data-active={active} aria-labelledby={titleId}>
      <svg className="demo-loading-scene" viewBox="0 0 360 180" aria-hidden="true" focusable="false">
        <path className="demo-loading-ground" d="M24 152h312" />
        <path className="demo-loading-store" d="M144 62v88h166V62M134 62l18-32h148l20 32H134Z" />
        <path className="demo-loading-detail" d="M176 30l-9 32M210 30l-2 32M244 30l5 32M278 30l13 32M160 132h134" />
        <rect className="demo-loading-store" x="172" y="99" width="48" height="27" rx="4" />
        <circle className="demo-loading-detail" cx="185" cy="112.5" r="4" />
        <circle className="demo-loading-detail" cx="206" cy="112.5" r="4" />
        <path className="demo-loading-detail" d="M247 111V99a17 17 0 0 1 34 0v12M247 103h5v16h-5zM276 103h5v16h-5z" />
        <path className="demo-loading-track" d="M24 104h14l5-11 8 23 9-45 9 63 9-47 8 29 6-12h52" />
        <path className="demo-loading-pulse" pathLength="1" d="M24 104h14l5-11 8 23 9-45 9 63 9-47 8 29 6-12h52" />
      </svg>
      <div className="demo-loading-copy">
        <h1 id={titleId} ref={heading} tabIndex={-1}>{storyTitle ? `Preparing the ${storyTitle} story` : "Opening your guided demo"}</h1>
        <p className="demo-loading-description" role="status" aria-live="polite" aria-atomic="true">
          {elapsed >= 10
            ? "This is taking longer than usual. Keep this page open while the server responds."
            : storyTitle
              ? "We’re creating your own audio store, stock and inbox. You’ll begin by describing your recording."
              : "We’re checking the demo for this browser. If you haven’t started a story yet, you’ll be able to choose one."}
        </p>
        <p className="demo-loading-time" aria-live="off"><span className="num">{elapsed}s</span> elapsed</p>
      </div>
    </section>
  );
}
