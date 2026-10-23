import { useEffect, useState } from "react";
import { Page } from "../components/Shell";
import { Pill, Spinner } from "../components/ui";
import { api, Link, when, type Config } from "../lib/core";

export function Evidence({ cfg }: { cfg?: Config | null }) {
  const [e, setE] = useState<any>(null);
  const [mine, setMine] = useState<any>(null);
  useEffect(() => { api("GET", "/api/evidence").then(setE).catch(() => setE({})); api<any>("GET", "/api/state").then((r) => setMine(r.state)).catch(() => {}); }, []);
  return (
    <Page cfg={cfg}>
      <div className="wrap" style={{ paddingTop: 48, maxWidth: 1040 }}>
        <h1>Evidence</h1>
        <p className="measure" style={{ marginTop: 12, color: "var(--ink-2)", fontSize: "var(--s1)" }}>Each line names the layer it comes from. Sandbox rows are real PayPal Sandbox resources; automated fault tests run against a simulated PayPal client; fixture products are team-authored. PayPal webhooks reach this server through a relay on the Astropods-hosted agent, and the server verifies every one with PayPal.</p>

        {mine && mine.attempts?.length > 0 && (
          <section className="panel" aria-labelledby="mine-h">
            <div className="panel-head"><h2 id="mine-h">Your current demo session</h2><Pill tone="action">PayPal Sandbox</Pill></div>
            <div className="table-wrap"><table className="data"><thead><tr><th>Attempt</th><th>State</th><th>PayPal resources</th></tr></thead><tbody>
              {mine.attempts.map((a: any, i: number) => <tr key={a.id}><td>{i + 1}</td><td>{a.state.replaceAll("_", " ").toLowerCase()}</td><td><code>{[a.paypalOrderId && `order ${a.paypalOrderId}`, a.authorizationId && `authorization ${a.authorizationId}`, a.captureId && `capture ${a.captureId}`, a.refundId && `refund ${a.refundId}`].filter(Boolean).join(", ")}</code></td></tr>)}
            </tbody></table></div>
            {mine.webhooks?.length > 0 && <p className="small" style={{ marginTop: 10 }}>Verified PayPal webhooks for this purchase: {mine.webhooks.map((w: any) => w.event_type).join(", ")}.</p>}
            <Link to="/demo" className="small">Back to the demo</Link>
          </section>
        )}

        <section className="panel" aria-labelledby="live-h">
          <div className="panel-head"><h2 id="live-h">Live totals on this server</h2><Pill tone="action">PayPal Sandbox</Pill></div>
          {e?.live ? (
            <div className="table-wrap"><table className="data"><tbody>
              <tr><th>Demo sessions</th><td>{e.live.sessions}</td></tr>
              <tr><th>Authorizations created</th><td>{e.live.authorizations}</td></tr>
              <tr><th>Captures completed</th><td>{e.live.captures}{e.live.captures_pending ? `; ${e.live.captures_pending} accepted by PayPal and still pending` : ""}</td></tr>
              <tr><th>Authorizations voided</th><td>{e.live.voids}</td></tr>
              <tr><th>Refunds</th><td>{e.live.refunds}</td></tr>
              <tr><th>Webhooks verified with PayPal</th><td>{e.live.webhooks_verified}: {e.live.webhooks_processed} matched a purchase here and triggered reconciliation; {e.live.webhooks_ignored} belonged to other Sandbox test orders. Rejected: {e.live.webhooks_rejected}</td></tr>
              <tr><th>Recovery cases</th><td>{e.live.recovery_cases}</td></tr>
              <tr><th>AI calls</th><td>{e.live.language_ok} answered by a model{Array.isArray(e.live.language_models) && e.live.language_models.length ? ` (${e.live.language_models.map((m: any) => `${m.model}: ${m.n}`).join(", ")})` : ""}; {e.live.language_fallback} used the rules or template fallback{e.live.language_ungrounded ? ` (${e.live.language_ungrounded} explanations rejected as ungrounded)` : ""}. Median {(e.live.language_p50_ms / 1000).toFixed(1)} s, p95 {(e.live.language_p95_ms / 1000).toFixed(1)} s</td></tr>
            </tbody></table></div>
          ) : <Spinner label="Loading live totals" />}
          {e?.recentWebhooks?.length > 0 && <><h3 style={{ marginTop: 14 }}>Recent webhook deliveries</h3><div className="table-wrap"><table className="data"><thead><tr><th>Event</th><th>Signature</th><th>Handling</th><th>Received</th></tr></thead><tbody>{e.recentWebhooks.map((w: any, i: number) => <tr key={i}><td>{w.event_type}</td><td>{w.verification}</td><td>{w.status === "PROCESSED" ? "matched a purchase here; reconciled" : w.status === "IGNORED" ? "not a purchase on this server" : "rejected and quarantined"}</td><td>{when(w.received_at)}</td></tr>)}</tbody></table></div></>}
        </section>

        {e?.sandboxMatrix && (
          <section className="panel" aria-labelledby="matrix-h">
            <div className="panel-head"><h2 id="matrix-h">Required Sandbox paths</h2><Pill tone="action">PayPal Sandbox</Pill></div>
            <div className="table-wrap"><table className="data"><thead><tr><th>ID</th><th>Path</th><th>Result</th><th>Resources</th></tr></thead><tbody>
              {e.sandboxMatrix.rows.map((r: any) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: "nowrap" }}>{r.id}</td>
                  <td>{r.path}</td>
                  <td>{r.result}{r.recordedAt && <div className="small muted" style={{ marginTop: 4 }}>Run {when(r.recordedAt)}, {r.release ? <>release <span className="mono">{r.release}</span></> : "release not recorded"}</div>}</td>
                  <td><code>{r.resources}</code></td>
                </tr>
              ))}
            </tbody></table></div>
            <p className="small muted" style={{ marginTop: 8 }}>Recorded {when(e.sandboxMatrix.recordedAt)}.</p>
          </section>
        )}

        {e?.tests && (
          <section className="panel" aria-labelledby="tests-h">
            <div className="panel-head"><h2 id="tests-h">Automated checks</h2><Pill>simulated PayPal client and real PostgreSQL</Pill></div>
            <p>{e.tests.passed} of {e.tests.total} passed on {when(e.tests.recordedAt)}.</p>
            <div className="table-wrap"><table className="data"><tbody>{e.tests.groups?.map((g: any) => <tr key={g.name}><th>{g.name}</th><td>{g.passed}/{g.total}</td></tr>)}</tbody></table></div>
          </section>
        )}

        {e?.benchmark?.solver && (() => {
          const s = e.benchmark.solver, b = e.benchmark.baseline;
          const label: Record<string, string> = { v1: "Frozen first pass", v2: "Rerun: prompt date rule (reverted)", v3: "Rerun: dates read by code", v4: "Rerun: conflict rule and budget check", "holdout-v1": "8 new cases, run once" };
          return (
            <section className="panel" aria-labelledby="bench-h">
              <div className="panel-head"><h2 id="bench-h">Frozen fixture evaluation</h2><Pill>team-authored cases</Pill></div>
              <p className="small" style={{ maxWidth: "70ch" }}>Twenty buyer requests written from the declared catalog, with hand-derived expectations, hashed before the solver or the model saw them. This is an engineering check on simulated products, not a real-user study.</p>
              <h3 style={{ marginTop: 12 }}>Solver</h3>
              <div className="table-wrap"><table className="data"><tbody>
                <tr><th>Classification correct</th><td>{s.classificationCorrect}</td></tr>
                <tr><th>Feasible cases solved with the exact expected bundle and total</th><td>{s.feasibleSolved}</td></tr>
                <tr><th>Stopped correctly: no fix, evidence missing, unsupported</th><td>{s.infeasibleCorrect}, {s.evidenceIncompleteCorrect}, {s.unsupportedCorrect}</td></tr>
                <tr><th>Invalid payable bundles</th><td>{s.invalidPayableBundles}</td></tr>
                <tr><th>Solve time</th><td>median {s.durationMs.median} ms, max {s.durationMs.max} ms</td></tr>
              </tbody></table></div>
              {b && <>
                <h3 style={{ marginTop: 14 }}>Whole-bundle recovery against item-only swaps</h3>
                <p style={{ maxWidth: "70ch" }}>In {b.recoveryCases} recovery cases ReCart found a complete bundle {b.recartFeasible} times; replacing only the missing item worked {b.baselineSucceeded} times. Only ReCart succeeded in {b.recartOnly.length} cases ({b.recartOnly.join(", ")}), each needing a dependent change such as a cable plus adapter. {b.baselineOnly.length ? `The item swap alone succeeded in ${b.baselineOnly.join(", ")}.` : "There was no case where only the item swap succeeded."}</p>
              </>}
              {e.benchmarkRuns?.some((r: any) => r.summary.extraction) && <>
                <h3 style={{ marginTop: 14 }}>First-pass AI extraction (benchmark runs: Claude Haiku 4.5 through Astropods)</h3>
                <div className="table-wrap"><table className="data"><thead><tr><th>Run</th><th>Whole case</th><th>Precision</th><th>Recall</th><th>Unsupported</th><th>Unknowns kept</th><th>Conflicts flagged</th><th>Failed calls</th></tr></thead><tbody>
                  {e.benchmarkRuns.filter((r: any) => r.summary.extraction).map((r: any) => { const x = r.summary.extraction; return (
                    <tr key={r.id}><td style={{ whiteSpace: "nowrap" }}><strong>{r.id}</strong><br /><span className="small muted">{label[r.id] ?? ""}</span></td><td>{x.wholeCaseCorrect}</td><td>{x.precision.truePositives}/{x.precision.assertions}</td><td>{x.recall.truePositives}/{x.recall.statedFacts}</td><td>{x.unsupportedAssertions}</td><td>{x.unknownsPreserved}</td><td>{x.conflictsFlagged}</td><td>{x.calls.failed}</td></tr>
                  ); })}
                </tbody></table></div>
                <p className="small muted" style={{ marginTop: 8, maxWidth: "70ch" }}>v1 is the untouched result. v2 to v4 were rerun on the same cases after examining failures, so they are not holdouts; the holdout is eight new requests labeled before one run. From v3 on, scores include the deterministic date and budget checks that run after the model, so they are not bare-model accuracy. The full report, every case and every freeze record are in the source under evaluation/.</p>
              </>}
            </section>
          );
        })()}
      </div>
    </Page>
  );
}
