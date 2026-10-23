// Proves, on a running deployment, that every route which drafts survives a slow primary and fails over to the
// backup within the proxy's timeouts. Faults are scoped to the demo session and the sandbox merchant this script
// creates, so no other caller and no shared cooldown is touched. Writes evidence/checks/proxy-timeouts.json.
//
// Usage:
//   BASE=https://recart.example.com \
//   FAULT_CMD="ssh host 'cd /opt/recart/app && set -a && . /opt/recart/recart.env && set +a && node dist/server/server/admin.js language-fault {args}'" \
//   node tools/check-proxy-timeouts.mjs
// {args} becomes `--scope <scope> --fault-b64 <base64 json> --ttl-seconds 600` or `--scope <scope> --clear` (base64 survives the shells in between).
// SLOW_MS (default 70000) is the simulated primary delay: it must exceed the default location's 60 s timeout.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:4060";
const SLOW_MS = Number(process.env.SLOW_MS ?? 70_000);
const FAULT_CMD = process.env.FAULT_CMD;
if (!FAULT_CMD) throw new Error("FAULT_CMD is required (how to run the admin language-fault command on the server)");
const TEXT = "Two of us in the room and one remote guest on Zoom, USB-C laptop, $450 all in.";
const out = { recordedAt: new Date().toISOString(), base: BASE, release: null, language: null, slowMs: SLOW_MS, checks: [] };
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

function fault(scope, spec) {
  const args = spec ? `--scope ${scope} --fault-b64 ${Buffer.from(JSON.stringify(spec)).toString("base64")} --ttl-seconds 600` : `--scope ${scope} --clear`;
  const r = execFileSync("sh", ["-c", FAULT_CMD.replaceAll("{args}", args)], { encoding: "utf8" });
  log(`fault ${scope}: ${spec ? JSON.stringify(spec) : "cleared"} -> ${r.trim().split("\n").pop()}`);
}
async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    const ms = Date.now() - t0;
    return { label, ms, ...r };
  } catch (e) { return { label, ms: Date.now() - t0, status: null, error: String(e?.message ?? e) }; }
}
function check(c, expect) {
  const problems = [];
  if (c.status !== 200) problems.push(`HTTP ${c.status ?? c.error}`);
  if (expect.minMs && c.ms < expect.minMs) problems.push(`answered in ${c.ms} ms, expected at least ${expect.minMs}`);
  if (expect.maxMs && c.ms > expect.maxMs) problems.push(`took ${c.ms} ms, over ${expect.maxMs}`);
  if (expect.provider && c.provider !== expect.provider) problems.push(`provider ${c.provider}, expected ${expect.provider}`);
  if (expect.providers && !expect.providers.includes(c.provider)) problems.push(`provider ${c.provider}, expected one of ${expect.providers.join(", ")}`);
  if (expect.fallbackWhenHosted && c.provider === "hosted" && c.fallbackFrom !== "codex") problems.push(`answered by hosted without falling back from codex`);
  if (expect.fallbackFrom !== undefined && (c.fallbackFrom ?? null) !== expect.fallbackFrom) problems.push(`fallback_from ${c.fallbackFrom}, expected ${expect.fallbackFrom}`);
  if (expect.source && c.source !== expect.source) problems.push(`source ${c.source}, expected ${expect.source}`);
  const row = { ...c, expect, ok: problems.length === 0, problems };
  out.checks.push(row);
  log(`${row.ok ? "PASS" : "FAIL"} ${c.label}: HTTP ${c.status} in ${(c.ms / 1000).toFixed(1)} s, ${c.source ?? "-"} via ${c.provider ?? "-"}${c.fallbackFrom ? ` (fell back from ${c.fallbackFrom})` : ""}${problems.length ? ": " + problems.join("; ") : ""}`);
  return row.ok;
}

const health = await (await fetch(`${BASE}/api/health`)).json();
out.release = health.release;
out.language = { active: health.language?.active, worstCaseSeconds: health.language?.worstCaseSeconds, codex: health.language?.providers?.codex, hosted: health.language?.providers?.hosted };
const worstMs = (health.language?.worstCaseSeconds?.extract ?? 140) * 1000;
log(`release ${health.release}; language active=${health.language?.active}; worst case ${health.language?.worstCaseSeconds?.extract} s for a draft`);

// ---- Demo API: /api/goal/extract, scoped to a fresh demo session ----
const sr = await fetch(`${BASE}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: "A" }) });
if (sr.status !== 201 && sr.status !== 200) throw new Error(`session: HTTP ${sr.status} ${await sr.text()}`);
const cookie = (sr.headers.get("set-cookie") ?? "").split(";")[0];
const sessionId = cookie.split("=")[1];
const csrf = (await sr.json()).csrf;
const demoScope = `session:${sessionId}`;
log(`demo session ${sessionId}`);
const draftDemo = (label) => timed(label, async () => {
  const r = await fetch(`${BASE}/api/goal/extract`, { method: "POST", headers: { "content-type": "application/json", "x-recart-csrf": csrf, cookie }, body: JSON.stringify({ text: TEXT }) });
  const j = r.status === 200 ? await r.json() : null;
  return { status: r.status, source: j?.result?.source, provider: j?.result?.provider, fallbackFrom: j?.result?.fallbackFrom, model: j?.result?.model, body: j ? undefined : (await r.text()).slice(0, 300) };
});
check(await draftDemo("/api/goal/extract baseline"), { provider: "codex", source: "model", maxMs: worstMs });
fault(demoScope, { primary: { delay_ms: SLOW_MS } });
// A delay spends part of the primary's own bound (as a slow real call would), so a busy gateway may not fit in what is
// left and the backup answers instead. Either provider is correct; the point is a draft over 60 s completing in time.
check(await draftDemo(`/api/goal/extract with the primary delayed ${SLOW_MS / 1000} s`), { providers: ["codex", "hosted"], fallbackWhenHosted: true, source: "model", minMs: SLOW_MS, maxMs: worstMs });
fault(demoScope, { primary: { delay_ms: SLOW_MS, outcome: "unreachable" } });
check(await draftDemo(`/api/goal/extract with the primary failing after ${SLOW_MS / 1000} s, backup answering`), { provider: "hosted", fallbackFrom: "codex", source: "model", minMs: SLOW_MS, maxMs: worstMs });
fault(demoScope, { primary: { outcome: "refused", status: 429, message: "simulated quota refusal" } });
check(await draftDemo("/api/goal/extract with the primary refusing (429), backup answering"), { provider: "hosted", fallbackFrom: "codex", source: "model", maxMs: worstMs });
fault(demoScope, null);
const after = await (await fetch(`${BASE}/api/health`)).json();
const untouched = after.language?.providers?.codex?.coolingDown === false && after.language?.active === "codex";
out.checks.push({ label: "shared cooldown untouched by the scoped refusal", ok: untouched, codex: after.language?.providers?.codex, active: after.language?.active });
log(`${untouched ? "PASS" : "FAIL"} shared cooldown untouched: active=${after.language?.active} coolingDown=${after.language?.providers?.codex?.coolingDown}`);

// ---- Merchant API and MCP, scoped to a fresh sandbox merchant ----
const mr = await fetch(`${BASE}/v1/sandbox/merchants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Proxy timeout check" }) });
if (mr.status !== 201) throw new Error(`sandbox merchant: HTTP ${mr.status} ${await mr.text()}`);
const m = await mr.json();
const key = m.api_key, merchantScope = `merchant:${m.merchant.id}`;
log(`sandbox merchant ${m.merchant.id} (expires ${m.expires_at})`);
const draftV1 = (label) => timed(label, async () => {
  const r = await fetch(`${BASE}/v1/requirement-drafts`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ text: TEXT, timezone: "America/Los_Angeles" }) });
  const j = r.status === 200 ? await r.json() : null;
  return { status: r.status, source: j?.source, provider: j?.provider, model: j?.model, body: j ? undefined : (await r.text()).slice(0, 300) };
});
const draftMcp = (label) => timed(label, async () => {
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "draft_requirements", arguments: { text: TEXT, timezone: "America/Los_Angeles" } } }) });
  const j = r.status === 200 ? await r.json() : null;
  const d = j?.result?.structuredContent;
  return { status: r.status, source: d?.source, provider: d?.provider, model: d?.model, isError: j?.result?.isError, body: j ? undefined : (await r.text()).slice(0, 300) };
});
check(await draftV1("/v1/requirement-drafts baseline"), { provider: "codex", source: "model", maxMs: worstMs });
fault(merchantScope, { primary: { delay_ms: SLOW_MS } });
check(await draftV1(`/v1/requirement-drafts with the primary delayed ${SLOW_MS / 1000} s`), { providers: ["codex", "hosted"], source: "model", minMs: SLOW_MS, maxMs: worstMs });
check(await draftMcp(`/mcp draft_requirements with the primary delayed ${SLOW_MS / 1000} s`), { providers: ["codex", "hosted"], source: "model", minMs: SLOW_MS, maxMs: worstMs });
fault(merchantScope, { primary: { delay_ms: SLOW_MS, outcome: "unreachable" } });
check(await draftV1(`/v1/requirement-drafts with the primary failing after ${SLOW_MS / 1000} s, backup answering`), { provider: "hosted", source: "model", minMs: SLOW_MS, maxMs: worstMs });
check(await draftMcp(`/mcp draft_requirements with the primary failing after ${SLOW_MS / 1000} s, backup answering`), { provider: "hosted", source: "model", minMs: SLOW_MS, maxMs: worstMs });
fault(merchantScope, null);

out.ok = out.checks.every((c) => c.ok);
const file = path.join(new URL("..", import.meta.url).pathname, "evidence/checks/proxy-timeouts.json");
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2));
// Every run is also kept under its release, so a later run never overwrites an earlier failure.
writeFileSync(file.replace(/\.json$/, `.${out.release}.${out.ok ? "passed" : "failed"}.json`), JSON.stringify(out, null, 2));
log(`${out.ok ? "ALL PASSED" : "FAILURES"}: ${out.checks.filter((c) => c.ok).length}/${out.checks.length} checks; written ${path.relative(process.cwd(), file)}`);
process.exitCode = out.ok ? 0 : 1;
