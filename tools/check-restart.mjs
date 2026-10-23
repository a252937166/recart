// Proves on the live deployment that a SIGTERM restart ends cleanly while an event stream is open and an explanation
// job is running: the old process exits on its own (no SIGKILL), hands the job's lease back, the stream ends with a
// shutdown event, and the new process takes the job over at once and finishes it. Writes
// evidence/checks/restart.<release>.json.
//
// Usage: BASE=https://recart.example.com SSH="ssh -o ControlPath=... root@host" [WAIT_FOR_FILE=<story output>] node tools/check-restart.mjs
// It waits for a RUNNING explain_case job whose session has an active scoped language fault (a story run sets one with
// ON_SESSION_CMD). With WAIT_FOR_FILE it also waits for that story to log "handed over", so the restart does not land
// in the story's payment steps.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:4060";
const SSH = (process.env.SSH ?? "").split(/\s+/).filter(Boolean);
if (!SSH.length) throw new Error("SSH is required, e.g. SSH=\"ssh -o ControlPath=... root@host\"");
const WAIT_FOR_FILE = process.env.WAIT_FOR_FILE;
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
// Remote calls are asynchronous, so the event-stream reader keeps running while they wait. Durations that matter are
// taken from server-side timestamps (the journal, the jobs table, the process start), not from SSH round trips.
const run = promisify(execFile);
const remote = async (cmd) => (await run(SSH[0], [...SSH.slice(1), cmd], { encoding: "utf8", maxBuffer: 1 << 20 })).stdout.trim();
const sql = (q) => remote(`echo ${Buffer.from(q).toString("base64")} | base64 -d | docker exec -i recart-pg psql -U recart -d recart -At -F '|'`);
/** journalctl -o short-precise timestamps ("Oct 11 15:54:48.123456") in host local time, as epoch ms. */
const tzOffset = async () => remote("date +%z");
const journalMs = (line, year, tz) => { const m = /^(\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6})/.exec(line); if (!m) return null; const mon = "JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(m[1]) / 3; const iso = `${year}-${String(mon + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}T${m[3]}:${m[4]}:${m[5]}.${m[6].slice(0, 3)}${tz.slice(0, 3)}:${tz.slice(3)}`; return Date.parse(iso); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { recordedAt: new Date().toISOString(), base: BASE, checks: [] };
const check = (label, ok, detail = {}) => { out.checks.push({ label, ok, ...detail }); log(`${ok ? "PASS" : "FAIL"} ${label}${Object.keys(detail).length ? " " + JSON.stringify(detail) : ""}`); };

const health = async () => (await fetch(`${BASE}/api/health`)).json();
const before = await health();
out.release = before.release;
const oldPid = Number(await remote("systemctl show -p MainPID recart | cut -d= -f2"));
const tz = await tzOffset();
log(`release ${before.release}; serving PID ${oldPid}`);

// 1. A running explanation job, held by a scoped fault, after the story's payments are done.
let target = null;
for (const t0 = Date.now(); Date.now() - t0 < 15 * 60_000; await sleep(2000)) {
  const storyDone = !WAIT_FOR_FILE || (existsSync(WAIT_FOR_FILE) && readFileSync(WAIT_FOR_FILE, "utf8").includes("handed over"));
  const row = await sql("select j.id, j.lease_owner, j.payload->>'sessionId' from jobs j join language_faults f on f.scope = 'session:' || (j.payload->>'sessionId') and f.expires_at > now() where j.kind = 'explain_case' and j.status = 'RUNNING' order by j.id desc limit 1");
  if (row && storyDone) { const [id, owner, session] = row.split("|"); target = { id: Number(id), owner, session }; break; }
}
if (!target) throw new Error("no running explanation job with a scoped fault appeared");
log(`explanation job #${target.id} running under ${target.owner} for session ${target.session}`);
check("explanation job is running in the old process before the restart", target.owner.includes(`:${oldPid}:language`), { job: target.id, owner: target.owner });

// 2. An open event stream through the proxy.
const s = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: "A" }) });
const cookie = (s.headers.get("set-cookie") ?? "").split(";")[0];
const stream = { text: "", ended: false, endedAt: null };
const es = await fetch(`${BASE}/api/events`, { headers: { cookie, accept: "text/event-stream" } });
(async () => {
  const reader = es.body.getReader(); const dec = new TextDecoder();
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; stream.text += dec.decode(value); } } catch { /* reset */ }
  stream.ended = true; stream.endedAt = Date.now();
})();
for (let i = 0; i < 100 && !stream.text.includes("event: hello"); i++) await sleep(100);
check("event stream open through the proxy", stream.text.includes("event: hello"));

// 3. Restart.
const since = await remote("date '+%Y-%m-%d %H:%M:%S'");
const t0 = Date.now();
const restartCmdMs = Number(await remote("s=$(date +%s%3N); systemctl restart recart; e=$(date +%s%3N); echo $((e - s))"));
const t1 = Date.now();
const newPid = Number(await remote("systemctl show -p MainPID recart | cut -d= -f2"));
log(`systemctl restart took ${restartCmdMs} ms on the host; new PID ${newPid}`);
check("systemctl restart completed well inside TimeoutStopSec (45 s)", restartCmdMs < 30_000, { ms: restartCmdMs });

// 4. How the old process ended.
const oldLines = await remote(`journalctl _PID=${oldPid} --no-pager -o cat | tail -8`);
const unitLines = await remote(`journalctl -u recart --since '${since}' --no-pager -o cat | grep -E 'Stopping|Stopped|Starting|Started|Killing|timed out|SIGKILL|status=' || true`);
const precise = (await remote(`journalctl -u recart --since '${since}' --no-pager -o short-precise`)).split("\n");
const year = new Date().getFullYear();
const at = (re) => { const l = precise.find((x) => re.test(x)); return l ? journalMs(l, year, tz) : null; };
const sigterm = at(new RegExp(`recart\\[${oldPid}\\]: \\[recart\\] SIGTERM`)), handedBack = at(new RegExp(`recart\\[${oldPid}\\]: \\[worker:language\\] stopped`)), listening = at(new RegExp(`recart\\[${newPid}\\]: \\[recart\\] listening on`));
out.restart = { since, restartCmdMs, oldPid, newPid, sigterm: sigterm && new Date(sigterm).toISOString(), languageStopped: handedBack && new Date(handedBack).toISOString(), newListening: listening && new Date(listening).toISOString(), unreachableMs: sigterm && listening ? listening - sigterm : null };
out.oldProcessLog = oldLines.split("\n"); out.unitLog = unitLines.split("\n");
log(`server-side: SIGTERM ${out.restart.sigterm}, language lane stopped ${out.restart.languageStopped}, new process listening ${out.restart.newListening}`);
check("the site was unreachable for under 5 s (SIGTERM to the new process listening)", out.restart.unreachableMs !== null && out.restart.unreachableMs < 5000, { ms: out.restart.unreachableMs });
const complete = /shutdown complete in (\d+) ms/.exec(oldLines);
check("old process logged its own clean shutdown", !!complete, { shutdownMs: complete ? Number(complete[1]) : null });
check(`old process handed explain_case#${target.id} back`, new RegExp(`handed back[^\\n]*explain_case#${target.id}`).test(oldLines));
check("systemd did not escalate to SIGKILL", !/Killing|timed out|SIGKILL/.test(unitLines), { unitLog: out.unitLog });
for (let i = 0; i < 50 && !stream.ended; i++) await sleep(100);
check("the event stream ended with a shutdown event", stream.ended && stream.text.includes("event: shutdown"), { endedAfterMs: stream.endedAt ? stream.endedAt - t0 : null, restartRoundTripMs: t1 - t0 });

// 5. The new process takes the job over and finishes it. The claim time is the job row's updated_at, set when a runner
// claims it; the start is the new process's own start time from /api/health.
const started = Date.parse((await health()).build?.startedAt ?? "");
let takeover = null;
for (let i = 0; i < 100 && !takeover; i++) {
  const [status, owner, claimed] = (await sql(`select status, coalesce(lease_owner, ''), (extract(epoch from updated_at) * 1000)::bigint from jobs where id = ${target.id}`)).split("|");
  if (status === "RUNNING" && owner.includes(`:${newPid}:language`)) takeover = { owner, claimedAt: new Date(Number(claimed)).toISOString(), afterProcessStartMs: Number(claimed) - started };
  else await sleep(300);
}
check("the new process took the job over at once (claim within 3 s of its start)", !!takeover && takeover.afterProcessStartMs < 3000, takeover ?? {});
let done = null;
for (const tw = Date.now(); Date.now() - tw < 6 * 60_000; await sleep(3000)) {
  const [status, attempts] = (await sql(`select status, attempts from jobs where id = ${target.id}`)).split("|");
  const pending = await sql(`select detail->'explanation'->>'pending' || '|' || coalesce(detail->'explanation'->>'source', '') from recovery_cases where id = (select (payload->>'caseId')::uuid from jobs where id = ${target.id})`);
  if (status === "DONE" && pending.startsWith("false")) { done = { attempts: Number(attempts), source: pending.split("|")[1], afterRestartMs: Date.now() - t1 }; break; }
}
check("the explanation job finished and the case stopped waiting", !!done, done ?? {});
const after = await health();
check("health after the restart", after.release === before.release && after.build?.pid === newPid, { release: after.release, pid: after.build?.pid });

out.ok = out.checks.every((c) => c.ok);
const file = path.join(new URL("..", import.meta.url).pathname, `evidence/checks/restart.${out.release}.${out.ok ? "passed" : "failed"}.json`);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2));
log(`${out.ok ? "ALL PASSED" : "FAILURES"}: ${out.checks.filter((c) => c.ok).length}/${out.checks.length}; written ${path.relative(process.cwd(), file)}`);
process.exitCode = out.ok ? 0 : 1;
