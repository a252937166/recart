import { useEffect, useRef, useState } from "react";
import { DemoLoading } from "../components/demo/DemoLoading";
import { RecoveryPanel } from "../components/demo/Recovery";
import { RequirementsPanel } from "../components/demo/Requirements";
import { SetupPanel } from "../components/demo/Setup";
import { LedgerPanel } from "../components/demo/Ledger";
import { MessagesView, StoreView, TechDetails } from "../components/demo/StoreView";
import { Page, SiteHeader } from "../components/Shell";
import { api, ApiError, limitedText, Link, navigate, remaining, setCsrf, useAction, useNow, useSessionState, type AppState, type Config } from "../lib/core";
import { Notice, Pill, Spinner } from "../components/ui";
import { Beacon, BeaconFinder, GuideText, SandboxLogin } from "../components/demo/guide";

const STORIES = [
  { id: "A", title: "Recovered", text: "Another complete setup is in stock. ReCart rebuilds the order around a USB-B interface plus the cable and adapter it needs, and you approve the new total.", outcome: "Ends with a recovered purchase, paid once." },
  { id: "B", title: "Buyer decides", text: "The only complete fix costs $422.28, over a $400 limit. ReCart stops and asks. You raise your limit or cancel.", outcome: "Ends with your decision; nothing is charged without it." },
  { id: "C", title: "No safe replacement", text: "The last loopback interface is gone. ReCart checks every combination, explains why none works and closes the order.", outcome: "Ends with the hold released and nothing charged." },
] as const;

/** Story chooser and judge guide: what happens, what you need, and one button to start. */
export function DemoIntro({ cfg, state, onStarted }: { cfg: Config | null; state?: AppState | null; onStarted?: (state: AppState) => void }) {
  const [story, setStory] = useState<"A" | "B" | "C">("A");
  const [limited, setLimited] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const startInFlight = useRef(false);
  const active = useRef(false);
  const startButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    if (!limited && !startError) return;
    startButton.current?.focus({ preventScroll: true });
    startButton.current?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [limited, startError]);
  const start = async () => {
    // A ref guards clicks in the same event turn, before React disables/removes the button.
    if (startInFlight.current) return;
    startInFlight.current = true;
    const pathAtStart = location.pathname + location.search;
    const stillHere = () => active.current && location.pathname + location.search === pathAtStart;
    setStarting(true);
    setLimited(null);
    setStartError(null);
    try {
      const r = await api<{ csrf: string; state: AppState }>("POST", "/api/sessions", { scenario: story, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles" });
      if (!stillHere()) return;
      setCsrf(r.csrf);
      onStarted?.(r.state);
      if (!onStarted || location.pathname !== "/demo") navigate("/demo");
    } catch (e) {
      if (!stillHere()) return;
      if (e instanceof ApiError && e.status === 429) setLimited(limitedText(e));
      else setStartError(e instanceof Error ? e.message : "The server did not respond. Please try starting the story again.");
    } finally {
      startInFlight.current = false;
      if (active.current) setStarting(false);
    }
  };
  const inProgress = state && state.session?.status === "ACTIVE" && !state.stage?.ending;
  const buyer = cfg?.judgeBuyers[0];
  if (starting) return <Page cfg={cfg}><DemoLoading storyTitle={STORIES.find((s) => s.id === story)!.title} /></Page>;
  return (
    <Page cfg={cfg}>
      <div className="wrap" style={{ paddingTop: 48 }}>
        <div className="section-head" style={{ marginBottom: 24 }}>
          <h1>Guided demo</h1>
          <p>You play both sides of one small audio store: the buyer who orders a podcast setup, and the store associate who finds a part missing. A guide at the top always shows the next step and whose turn it is. Payments are real PayPal Sandbox holds; no real money moves.</p>
        </div>
        {inProgress && (
          <Notice tone="action" title={`You have a demo in progress: ${STORIES.find((s) => s.id === state!.session.scenario)?.title ?? "story"}`}>
            <div className="btn-row" style={{ marginTop: 8 }}><Link to="/demo" className="btn btn-primary btn-sm">Continue where you left off</Link><span className="small muted">or choose a story below to start over</span></div>
          </Notice>
        )}
        <h2 style={{ margin: "24px 0 12px" }}>Choose a story</h2>
        <div className="stories" role="radiogroup" aria-label="Story">
          {STORIES.map((s) => (
            <button key={s.id} type="button" className="story" role="radio" aria-checked={story === s.id} aria-pressed={story === s.id} onClick={() => setStory(s.id)}>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
              <p className="small muted">{s.outcome}</p>
            </button>
          ))}
        </div>
        <div className="store-grid" style={{ marginTop: 28 }}>
          <section className="panel">
            <h2>What you will do</h2>
            <ol style={{ margin: "12px 0 0", paddingLeft: 20, color: "var(--ink-2)" }}>
              <li>As the buyer, describe the recording; AI drafts the requirements and you confirm them.</li>
              <li>Accept a checked setup and approve a PayPal Sandbox hold.</li>
              <li>Switch to the store and report the audio interface missing.</li>
              <li>Back as the buyer, see what changes and why, then decide.</li>
            </ol>
            <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>About five minutes. PayPal opens in a popup window; allow popups for this site if your browser asks.</p>
          </section>
          <section className="panel">
            <h2>You will need this login</h2>
            {buyer ? (
              <>
                <p className="small muted" style={{ marginTop: 6 }}>In step 2, PayPal opens its Sandbox login. The demo shows this login again next to the PayPal button, so there is no need to note it down.</p>
                <SandboxLogin buyer={buyer} />
              </>
            ) : <p className="small muted">{cfg ? "This server uses simulated PayPal approval; no login is needed." : <Spinner />}</p>}
          </section>
        </div>
        {limited && <Notice tone="attention" title="The demo is busy from your network" role="alert">{limited}</Notice>}
        {startError && <Notice tone="danger" title="Your demo could not be prepared" role="alert">{startError} You can try starting the story again.</Notice>}
        <div className="btn-row" style={{ marginTop: 28 }}>
          <button ref={startButton} className="btn btn-primary" onClick={() => void start()} disabled={starting}>{`Start the ${STORIES.find((s) => s.id === story)!.title} story`}</button>
          <span className="small muted">Each demo gets its own store, stock and inbox for {cfg?.sessionHours ?? 24} hours.</span>
        </div>
      </div>
    </Page>
  );
}

function StageHeader({ state, view, onNewDemo }: { state: AppState; view: "buyer" | "store" | "messages"; onNewDemo: () => void }) {
  const now = useNow(30_000);
  const st = state.stage;
  const story = STORIES.find((s) => s.id === st.scenario);
  const cur = st.current;
  const switchTo = cur && !cur.waiting && cur.view !== view ? cur.view : null;
  const who = (a: string) => (a === "store" ? "Store" : a === "buyer" ? "Buyer" : "ReCart");
  return (
    <div className="demo-top">
      <div className="wrap">
        <div style={{ display: "flex", alignItems: "center", gap: 12, paddingTop: 16, flexWrap: "wrap" }}>
          <strong>Guided demo</strong><Pill>{story?.title ?? "Story"}</Pill>
          <span className="small muted" style={{ marginLeft: "auto" }}>Session {remaining(new Date(state.session.expiresAt).getTime() - now).replace(/:\d\d$/, "")} left</span>
          <button className="btn btn-secondary btn-sm" onClick={onNewDemo}>New demo</button>
        </div>
        <ol className="stagebar" aria-label="Progress">
          {st.stages.map((s: any) => (
            <li key={s.id} className={s.status} aria-current={s.status === "current" ? "step" : undefined}>
              <div className="who">{who(s.actor)}</div>
              <div className="t">{s.title}</div>
            </li>
          ))}
        </ol>
        <div className={`nextbar ${cur?.waiting ? "waiting" : ""} ${st.ending ? "ended" : ""}`} aria-live="polite">
          <div className="what">
            {st.ending ? (
              <><div className="label">Done</div><div>{st.ending.message} <Link to="/evidence">See the PayPal Sandbox evidence</Link>.</div></>
            ) : cur?.waiting ? (
              <><div className="label">ReCart is working</div><div><Spinner /> {cur.waiting}</div></>
            ) : cur ? (
              <><div className="label">Next · {who(cur.actor)}</div><div className="guide-text"><GuideText text={cur.instruction} /></div></>
            ) : null}
          </div>
          {switchTo && <Beacon on><Link to={switchTo === "store" ? "/demo/store" : "/demo"} className="btn btn-primary">Go to the {switchTo === "store" ? "Store" : "Buyer"} view</Link></Beacon>}
          {st.ending && <Link to="/demo/start" className="btn btn-secondary">Try another story</Link>}
        </div>
      </div>
    </div>
  );
}

/** The running demo: stage header, role tabs, and the active view. */
export function Demo({ cfg, view, caseId }: { cfg: Config | null; view: "buyer" | "store" | "messages"; caseId?: string }) {
  const { state, status, reload, adoptState } = useSessionState(caseId ?? null);
  const [editGoal, setEditGoal] = useState(0);
  const [goalEditing, setGoalEditing] = useState(false);
  const act = useAction();
  const newDemo = () => act.run("new", async () => { await api("POST", "/api/sessions/close").catch(() => {}); navigate("/demo/start"); });
  if (status === "loading" || !cfg) return <Page cfg={cfg}><DemoLoading /></Page>;
  if (status === "unavailable") return (
    <Page cfg={cfg}><div className="wrap" style={{ paddingTop: 48, maxWidth: 720 }}>
      <h1>This purchase cannot be opened here</h1>
      <p style={{ marginTop: 12 }}>Recovery links work only in the browser profile that started the purchase, while its demo session is available. Return to that browser, or start a separate demo.</p>
      <Link to="/demo/start" className="btn btn-primary">Start a separate demo</Link>
    </div></Page>
  );
  if (status === "none" || !state) return <DemoIntro cfg={cfg} onStarted={adoptState} />;
  const unread = (state.inbox ?? []).filter((n: any) => n.status === "DELIVERED" && !n.read_at).length;
  const closing = state.session.status !== "ACTIVE";
  const here = state.stage.current && !state.stage.current.waiting ? state.stage.current.view : null;
  return (
    <>
      <SiteHeader />
      <StageHeader state={state} view={view} onNewDemo={newDemo} />
      <main id="main" className="wrap" style={{ paddingBottom: 64 }}>
        {closing && <Notice tone="attention" title="This demo session is closed">Existing payments keep reconciling, but nothing new can start. <Link to="/demo/start">Start a separate demo</Link>.</Notice>}
        <nav className="roles" aria-label="Demo roles">
          <Link to="/demo" aria-current={view === "buyer" ? "page" : undefined}>Buyer view{here === "buyer" && view !== "buyer" ? <span className="here">your turn</span> : null}</Link>
          <Link to="/demo/store" aria-current={view === "store" ? "page" : undefined}>Store view{here === "store" && view !== "store" ? <span className="here">your turn</span> : null}</Link>
          <Link to="/demo/messages" aria-current={view === "messages" ? "page" : undefined}>Messages{unread ? <span className="count" aria-label={`${unread} unread`}>{unread}</span> : null}</Link>
        </nav>
        {view === "store" && <StoreView state={state} reload={reload} />}
        {view === "messages" && <MessagesView state={state} reload={reload} />}
        {view === "buyer" && (
          <div className="demo-grid">
            <div className="stack">
              {/* Keyed by session: when another tab starts a new demo, the form remounts instead of carrying the old draft over. */}
              {!state.goal && <RequirementsPanel key={state.session.id} state={state} reload={reload} />}
              {state.recoveryCase && <RecoveryPanel state={state} reload={reload} onEditGoal={() => setEditGoal((n) => n + 1)} goalEditing={goalEditing} />}
              {state.goal && <SetupPanel state={state} cfg={cfg} reload={reload} />}
            </div>
            <div className="stack">
              {state.goal && <RequirementsPanel key={`${state.session.id}:${editGoal}`} state={state} reload={reload} forceEdit={editGoal} onEditingChange={setGoalEditing} />}
              <LedgerPanel state={state} />
            </div>
          </div>
        )}
        <TechDetails state={state} />
        <BeaconFinder />
      </main>
    </>
  );
}
