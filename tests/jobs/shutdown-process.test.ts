import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { one } from "../../src/server/db/pool.js";
import { runOneJob } from "../../src/server/jobs/worker.js";
import type { LanguageAdapter } from "../../src/server/language/adapter.js";
import { reportMissing } from "../../src/server/services/recovery.js";
import { authorizedPurchase, setup, TEST_DB, type Harness } from "../integration/harness.js";

// A real server process with an open event stream and an explanation job stuck on the model receives SIGTERM. It must
// exit on its own in time, hand the job's lease back, and a replacement runner must take the job over at once.
// RECART_IMPL_DIR runs a compiled tree's main.js instead of the sources.
// The core lane's grace is 4 s and the language lane's 1 s: the stuck explanation is handed back after 1 s.
const GRACE_S = 4, LANGUAGE_GRACE_S = 1, DRAIN_S = 3;

let h: Harness;
let gateway: http.Server;
const held: http.ServerResponse[] = [];
let completions = 0;
let child: ChildProcess | null = null;
let out = "";

const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); }); });
const until = async (cond: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
  const t0 = Date.now();
  while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}\n--- server output ---\n${out}`); await new Promise((r) => setTimeout(r, 25)); }
};

beforeAll(async () => {
  h = await setup();
  // The fake Codex gateway: its status answers, its completions never do.
  gateway = http.createServer((req, res) => {
    if (req.url?.startsWith("/v1/status")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ model: "gpt-6-luna", running: false })); return; }
    if (req.url?.startsWith("/v1/chat/completions")) { completions++; held.push(res); req.resume(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => gateway.listen(0, "127.0.0.1", r));
});
afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const r of held) r.destroy();
  await new Promise<void>((r) => gateway.close(() => r()));
  await h.db.end();
});

describe("SIGTERM with an open event stream and a running explanation", () => {
  it("exits in time without SIGKILL, hands the lease back, and a replacement runner takes the job over at once", async () => {
    // A recovery case whose explanation job is due now, by the real clock the server process uses.
    h.clock.set(new Date());
    const p = await authorizedPurchase(h, "A");
    await reportMissing(h.ctx, p.session, { checkoutId: p.checkoutId, sku: "IF-2C-LB" });
    const rc = await one<any>(h.db, "select id, solve_run_id from recovery_cases where intent_id=$1", [p.intentId]);
    const key = `explain:${rc.id}:${rc.solve_run_id}`;
    await h.db.query("update jobs set status='DONE' where dedupe_key is distinct from $1 and status <> 'DONE'", [key]);
    const job = () => one<any>(h.db, "select status, lease_owner, lease_until, attempts from jobs where dedupe_key=$1", [key]);
    const pending = async () => (await one<any>(h.db, "select detail from recovery_cases where id=$1", [rc.id])).detail.explanation.pending;
    expect(await job()).toMatchObject({ status: "PENDING", attempts: 0 });

    const port = await freePort();
    const impl = process.env.RECART_IMPL_DIR;
    const args = impl ? [path.resolve(impl, "server/main.js")] : ["--import", "tsx", "src/server/main.ts"];
    child = spawn(process.execPath, args, {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: TEST_DB, PORT: String(port), HOST: "127.0.0.1", PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
        PAYPAL_MODE: "fake", WORKER_ENABLED: "true", TIMING_PRESET: "test", COOKIE_SECURE: "false", RELEASE_ID: "shutdown-test",
        CODEX_API_URL: `http://127.0.0.1:${(gateway.address() as net.AddressInfo).port}`, CODEX_API_KEY: "test-key", LANGUAGE_URL: "", LANGUAGE_TOKEN: "",
        SHUTDOWN_DRAIN_SECONDS: String(DRAIN_S), SHUTDOWN_JOB_GRACE_SECONDS: String(GRACE_S), SHUTDOWN_LANGUAGE_GRACE_SECONDS: String(LANGUAGE_GRACE_S),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.on("data", (d) => { out += d; });
    child.stderr!.on("data", (d) => { out += d; });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child!.on("exit", (code, signal) => resolve({ code, signal })));
    await until(() => out.includes("listening on"), "the server to start");

    // An open event stream.
    const s = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: "A" }) });
    const cookie = (s.headers.get("set-cookie") ?? "").split(";")[0]!;
    const stream = { text: "", ended: false };
    http.get({ host: "127.0.0.1", port, path: "/api/events", headers: { cookie, accept: "text/event-stream" } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (d) => { stream.text += d; });
      res.on("end", () => { stream.ended = true; });
      res.on("close", () => { stream.ended = true; });
    });
    await until(() => stream.text.includes("event: hello"), "the event stream to open");

    // The explanation job is running in the server and waiting on the model.
    await until(async () => completions >= 1 && (await job()).status === "RUNNING", "the explanation job to be running");
    const running = await job();
    expect(running.lease_owner).toMatch(/:language$/);

    const t0 = Date.now();
    child.kill("SIGTERM");
    const result = await Promise.race([exited, new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
    const took = Date.now() - t0;
    console.log(`[shutdown test] exit ${JSON.stringify(result)} ${took} ms after SIGTERM\n${out.split("\n").filter((l) => /SIGTERM|stopped|shutdown complete/.test(l)).join("\n")}`);
    expect(result, `the server did not exit within 15 s of SIGTERM\n--- server output ---\n${out}`).not.toBeNull();
    expect(result).toEqual({ code: 0, signal: null });
    expect(took).toBeGreaterThanOrEqual(LANGUAGE_GRACE_S * 1000 - 100);
    expect(took).toBeLessThan((LANGUAGE_GRACE_S + 3) * 1000);
    expect(stream.ended).toBe(true);
    expect(stream.text).toMatch(/event: shutdown/);
    expect(out).toMatch(/\[worker:language\] stopped \(a job was still running after 1000 ms\); handed back explain_case#\d+ for the next process/);
    expect(out).toMatch(/shutdown complete in \d+ ms/);

    // The lease was handed back; the case still waits for its explanation.
    expect(await job()).toMatchObject({ status: "PENDING", lease_owner: null, lease_until: null, attempts: 1 });
    expect(await pending()).toBe(true);

    // A replacement runner takes it over at once (no lease to wait out) and saves the answer.
    const original = h.ctx.language;
    h.ctx.language = { ...original, async explainChange() { return { status: "OK", summary: "Answer from the replacement runner.", options: [], model: "fake-model", error: null }; } } as LanguageAdapter;
    try {
      expect(await runOneJob(h.ctx, "replacement", "language")).toBe(true);
    } finally { h.ctx.language = original; }
    expect(await job()).toMatchObject({ status: "DONE", lease_owner: null, attempts: 2 });
    const settled = (await one<any>(h.db, "select detail from recovery_cases where id=$1", [rc.id])).detail.explanation;
    expect(settled).toMatchObject({ pending: false, source: "model", text: "Answer from the replacement runner." });
  }, 60_000);
});
