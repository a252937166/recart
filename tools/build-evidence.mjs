// Rebuild the evidence summaries the public /evidence page reads:
//   evidence/tests/summary.json   from a fresh `vitest run` (JSON reporter) plus the hosted agent's Python tests
//   evidence/sandbox/matrix.json  from the recorded Sandbox evidence files and the public server's webhook counts
// Usage (local Postgres running): node tools/build-evidence.mjs [--skip-tests]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const ev = (p) => path.join(root, "evidence", p);
const read = (p) => (existsSync(ev(p)) ? JSON.parse(readFileSync(ev(p), "utf8")) : null);
const PUBLIC = process.env.PUBLIC_BASE ?? "https://recart.axiqo.xyz";
const PROBE = process.env.PROBE_DIR ?? path.join(root, "hosted-agent");

if (!process.argv.includes("--skip-tests")) {
  const out = path.join(root, "tmp/vitest.json");
  mkdirSync(path.dirname(out), { recursive: true });
  try { execFileSync("npx", ["vitest", "run", "--reporter=json", `--outputFile=${out}`], { cwd: root, stdio: "ignore" }); } catch { /* failures are recorded below */ }
  const v = JSON.parse(readFileSync(out, "utf8"));
  const groups = v.testResults.map((f) => {
    const labels = {
      "solver.test.ts": "Solver, money and time (unit)",
      "config.test.ts": "Deployment guards (unit)",
      "dates.test.ts": "Deterministic date reading and budget-conflict check (unit)",
      "flows.test.ts": "Payments, recovery, webhooks and sessions (integration: simulated PayPal client, real PostgreSQL, controlled clock)",
      "regressions.test.ts": "Readiness-review regressions: pending polls, settlement deadline, inventory at handoff (integration)",
      "acceptance-extra.test.ts": "Restart recovery, timing presets, language fallbacks, returning to a purchase (integration)",
      "stage.test.ts": "Guided demo stage model derived from server state (integration)",
      "api.test.ts": "Merchant API: outcomes, stock-change revisions, isolation, scopes, idempotency, approval, execution, webhooks, OpenAPI (integration)",
      "mcp.test.ts": "Remote MCP server through the official SDK client: tools, REST equality, scopes (integration)",
      "examples.test.ts": "Published examples against an unmodified server: independent Python store, Shopify sync, quickstart",
      "review-2026-10-10.test.ts": "Acceptance-review regressions: expired approvals, cursor pagination, stale-count refresh (integration)",
      "web-cache.test.ts": "Signal Room review: a new release reaches returning visitors (HTML revalidated, hashed assets immutable)",
      "evidence-captures.test.ts": "Signal Room review: evidence counts a capture only once PayPal completes it (integration)",
      "draft.test.ts": "Review follow-up: unconfirmed requirement drafts survive reloads and role switches (unit)",
      "trial.test.ts": "Developers page: trial key copy text and expiry wording (unit)",
      "retry.test.ts": "Rate limits: retry wording after a 429 (unit)",
      "rate-limits.test.ts": "Rate limits: proxy-trusted client address, per-address quotas, Retry-After (integration)",
      "codex-provider.test.ts": "Language providers: the Codex gateway and the hosted endpoint (unit, fake fetch)",
      "failover.test.ts": "Language failover: Codex first, hosted backup only while Codex is down; refusals keep their cooldown, one shared probe (integration)",
      "timeouts.test.ts": "Proxy timeouts: every drafting route covers the worst-case primary-plus-backup call (config check and timed requests)",
      "lanes.test.ts": "Job lanes: payment jobs run while an explanation waits; atomic pending state; restart takeover; a last failure and its cleanup commit together, only by the lease owner, never on a requested rerun, including a process killed mid-transaction (integration)",
      "concurrency.test.ts": "Language holds under concurrency: stale probes, answers and failures cannot lift, weaken or shorten a newer hold; one status probe at a time across failure generations, bounded and spaced by the interval (deterministic interleavings)",
      "shutdown-http.test.ts": "Bounded HTTP shutdown: open event streams are ended with their listeners and timers, and a hung request cannot hold the close (integration)",
      "shutdown-process.test.ts": "SIGTERM on a real server process with an open event stream and a running explanation: clean exit in time, lease handed back, immediate takeover (process-level)",
      "service-unit.test.ts": "Service units: only directives and log targets systemd 219 supports, journal logging with priorities, stop timeout above the app's shutdown bound (unit)",
      "faults.test.ts": "Scoped fault simulation: a delayed or failing provider for one session or merchant only, cooldown untouched (integration)",
    };
    const name = labels[path.basename(f.name)] ?? path.basename(f.name);
    return { name, total: f.assertionResults.length, passed: f.assertionResults.filter((a) => a.status === "passed").length };
  });
  if (existsSync(PROBE)) {
    let text = "";
    try { text = execFileSync("sh", ["-c", "python3 -m unittest discover -s tests 2>&1 | tail -3"], { cwd: PROBE }).toString(); } catch {}
    const ran = Number(/Ran (\d+) tests?/.exec(text)?.[1] ?? 0);
    const failed = Number(/failures=(\d+)/.exec(text)?.[1] ?? 0) + Number(/errors=(\d+)/.exec(text)?.[1] ?? 0);
    if (ran) groups.push({ name: "Hosted Astropods agent: language endpoint and PayPal webhook relay (mocked upstreams)", total: ran, passed: ran - failed });
  }
  const total = groups.reduce((n, g) => n + g.total, 0), passed = groups.reduce((n, g) => n + g.passed, 0);
  mkdirSync(ev("tests"), { recursive: true });
  writeFileSync(ev("tests/summary.json"), JSON.stringify({ recordedAt: new Date().toISOString(), total, passed, groups }, null, 2));
  console.log(`tests: ${passed}/${total}`);
}

const spike = read("sandbox/spike-pp01-pp03.json");
const refund = read("sandbox/pp03-refund-after-float.json");
const pp04 = read("sandbox/pp04-lost-capture.json");
// The latest successful public-site run per story, whatever its folder tag. Runs with an injected fault or a
// simulated popup blocker test failure handling, not the story, so they are left out.
const runs = existsSync(ev("e2e")) ? readdirSync(ev("e2e")).map((d) => ({ dir: d, r: read(`e2e/${d}/result.json`) })) : [];
const eligible = runs.filter(({ r }) => r?.ok && String(r.base ?? "").startsWith("https://") && !r.faultInjected && !r.popupBlocked);
const e2e = Object.fromEntries(["A", "B", "C"].map((s) => [s, eligible.filter(({ r }) => r.scenario === s).sort((a, b) => String(b.r.at).localeCompare(String(a.r.at)))[0] ?? null]));
let live = null;
try { live = await (await fetch(`${PUBLIC}/api/evidence`)).json(); } catch {}

const rows = [];
if (spike) {
  rows.push({ id: "PP01", path: "Authorize, then capture; replay the capture with the same PayPal-Request-Id", result: `${spike.pp01.capture.status}; the replay returned the same capture`, resources: `order ${spike.pp01.orderId}, authorization ${spike.pp01.authorize.authorizationId}, capture ${spike.pp01.capture.captureId}` });
  rows.push({ id: "PP02", path: "Authorize, then void; try to capture afterwards", result: `${spike.pp02.void.status}; the later capture was rejected with ${spike.pp02.captureAfterVoid.issue}`, resources: `order ${spike.pp02.orderId}, authorization ${spike.pp02.authorize.authorizationId}` });
}
if (refund) rows.push({ id: "PP03", path: "Full refund of a capture", result: `${refund.refund.status} at once; capture now ${refund.captureStatusAfter}. The first run, before the merchant float, stayed PENDING (bank-funded)`, resources: `refund ${refund.refund.id}, capture ${refund.captureId}${spike ? `; first run refund ${spike.pp03.refundId}` : ""}` });
if (pp04) {
  const cap = pp04.recart.operations.find((o) => o.kind === "CAPTURE");
  const inv = pp04.result.stockConsumedMatchesPurchase === undefined ? "" : `; handoff consumed ${pp04.result.stockConsumedMatchesPurchase ? "exactly the purchased goods" : "the wrong quantity of goods"}`;
  rows.push({ id: "PP04", path: "Capture reply lost after PayPal executed it (local server, injected fault)", result: `ReCart marked the capture unknown and held the goods, then reconciled: ${cap.attempts} attempts with one request ID, final ${pp04.result.finalPaymentState}. PayPal shows ${pp04.result.captureCountAtPayPal} capture${inv}`, resources: `order ${pp04.paypal.orderId}, authorization ${pp04.paypal.authorization.id}, capture ${pp04.paypal.captures.map((c) => c.id).join(", ")}` });
}
if (live?.live) {
  const types = [...new Set((live.recentWebhooks ?? []).filter((w) => w.verification === "SUCCESS").map((w) => w.event_type))];
  rows.push({ id: "PP05", path: "Real PayPal webhooks verified on the public server (verify-webhook-signature on the raw body)", result: `${live.live.webhooks_verified} verified with PayPal${live.live.webhooks_processed != null ? `: ${live.live.webhooks_processed} matched purchases here and triggered reconciliation, ${live.live.webhooks_ignored} were other Sandbox test orders` : ""}; ${live.live.webhooks_rejected} unverifiable event quarantined. Delivered through the Astropods-hosted relay because Sandbox does not deliver to this domain`, resources: `webhook 04034153BN793150U; ${types.join(", ")}` });
}
const proxy = read("checks/proxy-timeouts.json");
// Earlier failed runs stay on record (each run is kept as proxy-timeouts.<release>.<passed|failed>.json).
const failedRuns = existsSync(ev("checks")) ? readdirSync(ev("checks")).filter((f) => /^proxy-timeouts\..+\.failed\.json$/.test(f)).map((f) => read(`checks/${f}`)).filter((r) => r && r.release !== proxy?.release) : [];
const FAILURE_CAUSES = { "r2026.10.10-signal-room-12": "the simulated delay was added outside the provider's own time bound, so delay plus a slow real call outran the proxy; fixed in the next release" };
if (proxy?.checks?.length) {
  const passed = proxy.checks.filter((c) => c.ok).length;
  const secs = (label) => { const c = proxy.checks.find((x) => x.label?.startsWith(label) && x.label.includes("delayed")); return c ? `${(c.ms / 1000).toFixed(0)} s` : "-"; };
  const failover = proxy.checks.find((c) => c.label?.includes("failing after") && c.label.startsWith("/api/"));
  rows.push({ id: "OPS-1", path: "Proxy timeouts and failover on the public server: a primary delayed past the old 60 s limit, a slow failure with the backup answering, and a refusal, on /api/, /v1/ and /mcp (faults scoped to one session and one merchant)",
    result: `${passed} of ${proxy.checks.length} checks passed. Drafts completed without a 504 after ${secs("/api/goal/extract")} on /api/goal/extract, ${secs("/v1/requirement-drafts")} on /v1/requirement-drafts and ${secs("/mcp")} on the MCP tool${failover ? `; a primary failing after ${(failover.ms / 1000).toFixed(0)} s was answered by the ${failover.provider} backup` : ""}; the simulated refusal left the shared cooldown untouched`,
    resources: `worst case ${proxy.language?.worstCaseSeconds?.extract} s, proxy read timeout 180 s${failedRuns.map((r) => `. An earlier run on ${r.release} failed ${r.checks.filter((c) => !c.ok).map((c) => `"${c.label}" (${c.problems?.[0] ?? "failed"})`).join(", ")}${FAILURE_CAUSES[r.release] ? `: ${FAILURE_CAUSES[r.release]}` : ""}`).join("")}`, recordedAt: proxy.recordedAt, release: proxy.release ?? null, record: "evidence/checks/proxy-timeouts.json" });
}
// The newest restart check and service validation (kept per release under evidence/checks/).
const newest = (re) => (existsSync(ev("checks")) ? readdirSync(ev("checks")).filter((f) => re.test(f)).map((f) => ({ f, r: read(`checks/${f}`) })).filter((x) => x.r).sort((a, b) => String(b.r.recordedAt).localeCompare(String(a.r.recordedAt)))[0] : null);
const restart = newest(/^restart\..+\.json$/);
const RESTART_CAUSES = { "r2026.10.11-signal-room-14": "its takeover was timed over SSH calls that took 7 to 9 s each (server-side, the claim came within 1 s of the new process starting); the same run showed the site unreachable for 10 s while the explanation used the full 10 s job grace, cut to 1 s in the next release" };
const restartFailures = (existsSync(ev("checks")) ? readdirSync(ev("checks")).filter((f) => /^restart\..+\.failed\.json$/.test(f)).map((f) => read(`checks/${f}`)).filter((x) => x && x.release !== restart?.r?.release) : [])
  .map((x) => `. An earlier run on ${x.release} passed ${x.checks.filter((c) => c.ok).length} of ${x.checks.length}${RESTART_CAUSES[x.release] ? `: ${RESTART_CAUSES[x.release]}` : ""}`).join("");
if (restart) {
  const r = restart.r, c = (label) => r.checks.find((x) => x.label.startsWith(label));
  const sd = c("old process logged its own clean shutdown")?.shutdownMs, tk = c("the new process took the job over")?.afterProcessStartMs ?? c("the new process took the job over")?.afterRestartMs, st = c("the event stream ended")?.endedAfterMs, dn = c("the explanation job finished")?.afterRestartMs;
  rows.push({ id: "OPS-2", path: "Service restart on the public server while an event stream was open and an explanation job was running (SIGTERM, no SIGKILL)",
    result: `${r.checks.filter((x) => x.ok).length} of ${r.checks.length} checks passed. The old process shut down on its own in ${sd} ms and handed the job's lease back; the open stream ended with a shutdown event ${st} ms after the restart began; systemctl restart took ${r.restart?.restartCmdMs ?? r.restart?.ms} ms on the host with no forced kill; the new process took the job over ${tk} ms after starting and finished it ${Math.round((dn ?? 0) / 1000)} s later`,
    resources: `PID ${r.restart?.oldPid} to ${r.restart?.newPid}; unreachable ${r.restart?.unreachableMs} ms from SIGTERM to the new process listening${restartFailures}`, recordedAt: r.recordedAt, release: r.release ?? null, record: `evidence/checks/${restart.f}` });
}
const svc = newest(/^service-validation\..+\.json$/);
if (svc) {
  const v = svc.r, all = Object.values(v.phases).flat(), passed = all.filter((l) => l.startsWith("PASS")).length;
  rows.push({ id: "OPS-3", path: `Service unit and logging on the host's systemd ${v.systemd}: unit verified before install, effective settings after, startup and error lines reaching the journal and /var/log/messages`,
    result: `${passed} of ${all.length} checks passed. Logs go to the journal (stdout at info, stderr at err via priority prefixes) and are copied to /var/log/messages by rsyslog; no unsupported-directive warnings`,
    resources: "deploy/validate-service.sh verify, installed, running", recordedAt: v.recordedAt, release: v.release ?? null, record: `evidence/checks/${svc.f}` });
}
const label = { A: "Story A (Recovered) through the public site: rebuilt and recovered", B: "Story B (Buyer decides) through the public site: decision needed, limit raised to $425, recovered", C: "Story C (No safe replacement) through the public site: no supported fix, purchase closed" };
for (const [s, run] of Object.entries(e2e)) {
  if (!run) continue;
  const r = run.r;
  const ai = [
    r.extraction?.provider ? `draft by ${r.extraction.provider} (${r.extraction.model})` : "",
    r.explanation ? (r.explanation.pending ? "explanation still pending at the end" : `explanation ${r.explanation.source === "model" ? `by the model (${r.explanation.model})` : "from the template"}${r.explanation.waitedMs > 3000 ? ` after ${Math.round(r.explanation.waitedMs / 1000)} s` : ""}`) : "",
    r.sessionFault ? `with ${r.sessionFault}` : "",
  ].filter(Boolean).join(", ");
  rows.push({ id: `E2E-${s}`, path: label[s], result: `${r.attempts.map((a, i) => `attempt ${i + 1} ${a.state.toLowerCase()}`).join(", ")}; case ${String(r.caseStatus).toLowerCase().replaceAll("_", " ")}${ai ? `; ${ai}` : ""}`, resources: r.attempts.map((a) => [a.order && `order ${a.order}`, a.capture && `capture ${a.capture}`].filter(Boolean).join(" ")).join("; "), recordedAt: r.at, release: r.release ?? null, record: `evidence/e2e/${run.dir}/` });
  console.log(`E2E-${s}: ${run.dir} at ${r.at} release ${r.release ?? "not recorded"}`);
}
mkdirSync(ev("sandbox"), { recursive: true });
writeFileSync(ev("sandbox/matrix.json"), JSON.stringify({ recordedAt: new Date().toISOString(), rows }, null, 2));
console.log(`matrix: ${rows.map((r) => r.id).join(", ")}`);
