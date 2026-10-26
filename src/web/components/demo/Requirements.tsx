import { useEffect, useRef, useState } from "react";
import { api, ApiError, limitedText, usd, useAction, when, type AppState } from "../../lib/core";
import { Notice, Pill, Spinner } from "../ui";
import { clearDraft, loadDraft, saveDraft, startingDraft } from "./draft";
import { DraftWaiting } from "./DraftWaiting";
import { Beacon, guideAt } from "./guide";
import { APPS, OSES, PORTS } from "./parts";

/** The judge-facing sample request; its budget follows the story (Recovered and No safe replacement: $450, Buyer decides: $400). */
const sampleRequest = (budgetCents: number | undefined) =>
  `I need to record a podcast on Friday with two people in the room and one remote guest. I have a USB-C laptop. My total budget is $${Math.round((budgetCents ?? 45000) / 100)}.`;

interface FormState { localPeople: string; remoteGuests: string; hostPort: string; os: string; callApp: string; budget: string; date: string; time: string; ownedHeadphones: string; ownedStands: string; ownedCables: string; headphoneType: string }
const EMPTY: FormState = { localPeople: "", remoteGuests: "", hostPort: "", os: "", callApp: "", budget: "", date: "", time: "", ownedHeadphones: "0", ownedStands: "0", ownedCables: "0", headphoneType: "" };

function fromGoal(g: any, tz: string): FormState {
  const d = g.pickupBy ? new Date(g.pickupBy) : null;
  const parts = d ? Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map((p) => [p.type, p.value])) : null;
  return {
    localPeople: g.localPeople?.toString() ?? "", remoteGuests: g.remoteGuests?.toString() ?? "", hostPort: g.hostPort ?? "", os: g.os ?? "", callApp: g.callApp ?? "",
    budget: g.budgetCents != null ? (g.budgetCents / 100).toFixed(2).replace(/\.00$/, "") : "", date: parts ? `${parts.year}-${parts.month}-${parts.day}` : "", time: parts ? `${parts.hour}:${parts.minute}` : "",
    ownedHeadphones: String(g.owned?.headphones ?? 0), ownedStands: String(g.owned?.stands ?? 0), ownedCables: String(g.owned?.micCables ?? 0), headphoneType: g.preferences?.headphoneType ?? "",
  };
}
function fromExtraction(x: any): FormState {
  return {
    ...EMPTY,
    localPeople: x.localPeople?.value?.toString() ?? "", remoteGuests: x.remoteGuests?.value?.toString() ?? "", hostPort: x.hostPort?.value ?? "", os: x.os?.value ?? "", callApp: x.callApp?.value ?? "",
    budget: x.budgetCents ? (x.budgetCents.value / 100).toString() : "", date: x.recordingDate?.value ?? "", time: x.recordingTime?.value ?? "",
    ownedHeadphones: String(x.owned?.headphones ?? 0), ownedStands: String(x.owned?.stands ?? 0), ownedCables: String(x.owned?.micCables ?? 0),
  };
}
function toGoal(f: FormState, tz: string) {
  const n = (v: string) => (v === "" ? null : Number(v));
  const remote = n(f.remoteGuests);
  const pickupBy = f.date && f.time ? new Date(`${f.date}T${f.time}:00`).toISOString() : null;
  return {
    task: "podcast", localPeople: n(f.localPeople), remoteGuests: remote, hostPort: f.hostPort || null, os: f.os || null, callApp: remote && remote > 0 ? (f.callApp || null) : null,
    owned: { headphones: Number(f.ownedHeadphones || 0), micCables: Number(f.ownedCables || 0), stands: Number(f.ownedStands || 0) },
    budgetCents: f.budget === "" ? null : Math.round(Number(f.budget) * 100), pickupBy, timezone: tz,
    preferences: f.headphoneType ? { headphoneType: f.headphoneType } : {},
  };
}
const sourceLabel = (model: boolean, name?: string | null) => (model ? `AI draft (${name || "model"})` : "Rules draft: the AI helper was unavailable");
const FIELD_LABEL: Record<string, string> = { localPeople: "people in the room", remoteGuests: "remote guests", hostPort: "computer port", os: "operating system", callApp: "call app", budgetCents: "all-in budget", recordingDate: "recording day", recordingTime: "start time" };

export function RequirementsPanel({ state, reload, forceEdit, onEditingChange }: { state: AppState; reload: () => void; forceEdit?: number; onEditingChange?: (editing: boolean) => void }) {
  const tz = state.session.buyerTimezone;
  const goal = state.goal?.data;
  const active = state.checkout && !state.checkout.terminal ? state.checkout : null;
  const canEdit = !active || ["VOIDED", "CLOSED_NO_PAYMENT"].includes(active.state);
  const [editing, setEditing] = useState(!goal);
  const savedExtraction = state.extraction?.response?.fallbackDraft ?? state.extraction?.response ?? null;
  // An unconfirmed draft survives a reload or a visit to the Store view: the buyer's own edits when they were made on
  // the latest saved draft, otherwise the saved draft itself (see draft.ts).
  const [start] = useState(() => (goal ? null : startingDraft<FormState>({
    draft: loadDraft<FormState>(state.session.id), extractionId: state.extraction?.id ?? null,
    extractionForm: savedExtraction ? fromExtraction(savedExtraction) : null, extractionText: state.extraction?.request_text ?? null,
    empty: EMPTY, sampleText: sampleRequest(state.session.scenarioInfo?.budgetCents),
  })));
  const [text, setText] = useState(() => start?.text ?? sampleRequest(state.session.scenarioInfo?.budgetCents));
  const [form, setForm] = useState<FormState>(goal ? fromGoal(goal, tz) : start!.form);
  const [draftOf, setDraftOf] = useState<string | null>(start?.extractionId ?? null);
  const [extraction, setExtraction] = useState<any>(savedExtraction);
  const [source, setSource] = useState<string | null>(state.extraction ? sourceLabel(state.extraction.status === "OK", state.extraction.model) : null);
  // The session this form was mounted for. The page remounts the form per session, and this guards the draft store
  // against a write for a session the buyer never typed into.
  const sessionAtMount = useRef(state.session.id);
  const [attempted, setAttempted] = useState(false);
  const [limited, setLimited] = useState<string | null>(null);
  const act = useAction();
  const reading = act.busy === "extract";
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { if (goal && !editing) setForm(fromGoal(goal, tz)); }, [goal, editing, tz]);
  useEffect(() => { onEditingChange?.(editing && !!goal); }, [editing, goal, onEditingChange]);
  useEffect(() => { if (!goal && state.session.id === sessionAtMount.current) saveDraft({ sessionId: state.session.id, extractionId: draftOf, text, form, savedAt: Date.now() }); }, [goal, state.session.id, draftOf, text, form]);
  // A newer saved draft than the one being edited (read in another tab) replaces the form, as it does on load.
  const extractionId: string | null = state.extraction?.id ?? null;
  useEffect(() => {
    if (goal || !extractionId || extractionId === draftOf || !savedExtraction) return;
    setExtraction(savedExtraction);
    setForm(fromExtraction(savedExtraction));
    setSource(sourceLabel(state.extraction.status === "OK", state.extraction.model));
    if (state.extraction.request_text) setText(state.extraction.request_text);
    setDraftOf(extractionId);
  }, [extractionId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Opened from the recovery panel ("Change my requirements"): bring the form into view and focus the budget.
  useEffect(() => {
    if (!forceEdit) return;
    setEditing(true);
    window.setTimeout(() => { ref.current?.scrollIntoView({ behavior: "smooth", block: "start" }); (document.getElementById("bud") as HTMLInputElement | null)?.focus({ preventScroll: true }); }, 50);
  }, [forceEdit]);

  const read = () => act.run("extract", async () => {
    setLimited(null);
    let r: any;
    try { r = await api<any>("POST", "/api/goal/extract", { text }); }
    catch (e) { if (e instanceof ApiError && e.status === 429) { setLimited(limitedText(e)); return; } throw e; }
    setExtraction(r.result.extraction);
    setForm(fromExtraction(r.result.extraction));
    setDraftOf(r.result.runId ?? null);
    setSource(sourceLabel(r.result.source === "model", r.result.model));
    reload();
  });
  const g = toGoal(form, tz);
  const missing: string[] = [];
  if (g.localPeople == null) missing.push("people in the room");
  if (g.remoteGuests == null) missing.push("remote guests");
  if (!g.hostPort) missing.push("computer port");
  if (!g.os) missing.push("operating system");
  if ((g.remoteGuests ?? 0) > 0 && !g.callApp) missing.push("call app");
  if (g.budgetCents == null) missing.push("all-in budget");
  if (!form.date) missing.push("recording day");
  if (!form.time) missing.push("start time");
  const confirm = () => act.run("confirm", async () => {
    setAttempted(true);
    if (missing.length) return;
    await api("POST", "/api/goal/confirm", { goal: g, source: extraction ? "extraction-confirmed" : "form" });
    if (!goal) clearDraft();
    setEditing(false);
    reload();
  });
  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const miss = (k: keyof FormState) => (form[k] === "" && !(k === "callApp" && (form.remoteGuests === "0" || form.remoteGuests === "")) ? "missing" : "");
  // Where the guide points: read the sample request, then each field still missing in order, then confirm. When the
  // buyer is raising the limit after a recovery, the guide points at the budget field and then at confirm.
  const firstStep = guideAt(state, "requirements") && !goal;
  const deciding = guideAt(state, "decision") && editing;
  const order: (keyof FormState)[] = ["localPeople", "remoteGuests", "hostPort", "os", "callApp", "budget", "date", "time"];
  const firstMissing = source ? order.find((k) => miss(k) && (k !== "callApp" || form.remoteGuests !== "0")) : undefined;
  const budgetTarget = deciding && Number(form.budget || 0) * 100 <= (goal?.budgetCents ?? 0);
  const target: keyof FormState | "read" | "confirm" | null = firstStep ? (!source ? "read" : firstMissing ?? "confirm") : deciding ? (budgetTarget ? "budget" : "confirm") : null;
  const fieldTag = (k: keyof FormState) => (["hostPort", "os", "callApp"].includes(k) ? "Choose one" : k === "budget" && deciding ? "Raise the limit" : "Fill this in");
  const at = (k: keyof FormState, el: React.ReactNode) => <Beacon block shape="field" on={target === k} tag={fieldTag(k)}>{el}</Beacon>;

  if (goal && !editing) {
    const app = APPS.find((a) => a[0] === goal.callApp)?.[1] ?? goal.callApp;
    return (
      <section className="panel" aria-labelledby="req-h" ref={ref}>
        <div className="panel-head"><h2 id="req-h">What you need</h2><Pill tone="confirmed">Confirmed</Pill></div>
        <dl className="facts">
          <dt>In the room</dt><dd>{goal.localPeople} {goal.localPeople === 1 ? "person" : "people"}</dd>
          <dt>Remote</dt><dd>{goal.remoteGuests === 0 ? "No remote guest" : `${goal.remoteGuests} guest${app ? ` on ${app}` : ""}`}</dd>
          <dt>Computer</dt><dd>{PORTS.find((p) => p[0] === goal.hostPort)?.[1]} port, {OSES.find((o) => o[0] === goal.os)?.[1]}</dd>
          <dt>Budget</dt><dd className="num">{usd(goal.budgetCents)} all-in</dd>
          <dt>Ready by</dt><dd>{when(goal.pickupBy, tz)}</dd>
        </dl>
        <div className="btn-row" style={{ marginTop: 16 }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setEditing(true)} disabled={!canEdit}>Edit requirements</button>
        </div>
        {!canEdit && <p className="hint" style={{ marginTop: 8 }}>Locked while a PayPal hold is open.</p>}
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="req-h" ref={ref}>
      <div className="panel-head"><h2 id="req-h">What you need</h2>{goal && <button className="btn btn-quiet btn-sm" onClick={() => setEditing(false)}>Cancel</button>}</div>
      <div className="field">
        <label htmlFor="req">Describe your recording in your own words</label>
        <textarea id="req" className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={1500} />
      </div>
      <Beacon block on={target === "read" && !reading}><button className={`btn btn-block ${target === "read" ? "btn-primary" : "btn-secondary"}${reading ? " request-reading" : ""}`} onClick={read} disabled={!!act.busy || !text.trim()} aria-busy={reading}>{reading ? "Reading your request" : "Read my request"}</button></Beacon>
      {reading && <DraftWaiting />}
      {limited && <Notice tone="attention" title="AI drafting is busy from your network" role="alert">{limited} Fill in the form below yourself; everything else works.</Notice>}
      {source && !reading && (
        <div className="inset draft-result" style={{ marginTop: 12 }}>
          <Pill tone={source.startsWith("AI") ? "action" : "attention"}>{source}</Pill>
          {extraction && (
            <ul className="small" style={{ margin: "10px 0 0", paddingLeft: 18 }}>
              {(["localPeople", "remoteGuests", "hostPort", "os", "callApp", "budgetCents", "recordingDate", "recordingTime"] as const).filter((k) => extraction[k]).map((k) => (
                <li key={k}>{FIELD_LABEL[k]}: <strong>{String(k === "budgetCents" ? usd(extraction[k].value) : extraction[k].value)}</strong> <span className="quote-span">from “{extraction[k].span}”</span></li>
              ))}
            </ul>
          )}
          {extraction?.conflicts?.length > 0 && <Notice tone="attention">{extraction.conflicts.map((c: any, i: number) => <div key={i}>{c.detail}</div>)}</Notice>}
          {extraction?.questions?.length > 0 && <ul className="small" style={{ margin: "8px 0 0", paddingLeft: 18, color: "var(--attention)" }}>{extraction.questions.map((q: string, i: number) => <li key={i}>{q}</li>)}</ul>}
        </div>
      )}
      {source && reading && <p className="hint draft-waiting-previous">The fields below keep your previous values while you wait for the new draft.</p>}
      <form onSubmit={(e) => { e.preventDefault(); void confirm(); }} style={{ marginTop: 16 }} noValidate>
        <div className="grid-2">
          <div className="field"><label htmlFor="lp">People in the room</label>{at("localPeople", <input id="lp" className={`input ${miss("localPeople")}`} type="number" min={1} max={8} value={form.localPeople} onChange={set("localPeople")} />)}</div>
          <div className="field"><label htmlFor="rg">Remote guests</label>{at("remoteGuests", <input id="rg" className={`input ${miss("remoteGuests")}`} type="number" min={0} max={8} value={form.remoteGuests} onChange={set("remoteGuests")} />)}</div>
        </div>
        <div className="grid-2">
          <div className="field"><label htmlFor="hp">Computer port</label>{at("hostPort", <select id="hp" className={`input ${miss("hostPort")}`} value={form.hostPort} onChange={set("hostPort")}><option value="">Choose</option>{PORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>)}</div>
          <div className="field"><label htmlFor="os">Operating system</label>{at("os", <select id="os" className={`input ${miss("os")}`} value={form.os} onChange={set("os")}><option value="">Choose</option>{OSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>)}</div>
        </div>
        {form.remoteGuests !== "0" && <div className="field"><label htmlFor="app">Call app for the remote guest</label>{at("callApp", <select id="app" className={`input ${miss("callApp")}`} value={form.callApp} onChange={set("callApp")}><option value="">Choose</option>{APPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>)}</div>}
        <div className="field"><label htmlFor="bud">All-in budget (USD, tax included)</label>{at("budget", <input id="bud" className={`input ${miss("budget")}`} inputMode="decimal" value={form.budget} onChange={set("budget")} />)}</div>
        <div className="grid-2">
          <div className="field"><label htmlFor="dt">Recording day</label>{at("date", <input id="dt" className={`input ${miss("date")}`} type="date" value={form.date} onChange={set("date")} />)}</div>
          <div className="field"><label htmlFor="tm">Start time</label>{at("time", <input id="tm" className={`input ${miss("time")}`} type="time" value={form.time} onChange={set("time")} />)}</div>
        </div>
        <p className="hint">Pickup must finish before the recording starts ({tz}).</p>
        <details className="disclosure" style={{ marginBottom: 14 }}>
          <summary>Gear you already own, and preferences</summary>
          <div className="grid-2">
            <div className="field"><label htmlFor="oh">Headphones owned</label><input id="oh" className="input" type="number" min={0} max={8} value={form.ownedHeadphones} onChange={set("ownedHeadphones")} /></div>
            <div className="field"><label htmlFor="os2">Mic stands owned</label><input id="os2" className="input" type="number" min={0} max={8} value={form.ownedStands} onChange={set("ownedStands")} /></div>
          </div>
          <div className="grid-2">
            <div className="field"><label htmlFor="oc">XLR cables owned</label><input id="oc" className="input" type="number" min={0} max={8} value={form.ownedCables} onChange={set("ownedCables")} /></div>
            <div className="field"><label htmlFor="ht">Headphone style</label><select id="ht" className="input" value={form.headphoneType} onChange={set("headphoneType")}><option value="">No preference</option><option value="closed">Closed-back</option><option value="open">Open-back</option></select></div>
          </div>
        </details>
        {attempted && missing.length > 0 && <Notice tone="attention" role="alert" title="A few details are missing">Add {missing.join(", ")}. ReCart does not guess hard requirements.</Notice>}
        <Beacon block on={target === "confirm"}><button className="btn btn-primary btn-block" type="submit" disabled={!!act.busy}>{act.busy === "confirm" ? <Spinner label="Checking every combination" /> : "Confirm requirements"}</button></Beacon>
      </form>
    </section>
  );
}
