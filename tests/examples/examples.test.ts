import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetClock } from "../../src/server/clock.js";
import { startWorker } from "../../src/server/jobs/worker.js";
import { platformSetup, type P } from "../platform/helpers.js";

/**
 * Acceptance: independently written integrations pass their own tests against an unmodified ReCart server
 * (real HTTP, real worker, wall clock). The examples use only the published API.
 */
let p: P;
let base: string;
let worker: { stop(): Promise<void> };
const root = fileURLToPath(new URL("../../", import.meta.url));

function run(cmd: string, args: string[], cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, RECART_BASE_URL: base } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

beforeAll(async () => {
  p = await platformSetup();
  resetClock();
  await p.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(p.app.server.address() as any).port}`;
  p.h.ctx.cfg = { ...p.h.ctx.cfg, PUBLIC_BASE_URL: base } as any;
  worker = startWorker(p.h.ctx, { intervalMs: 100, owner: "examples-test" });
});
afterAll(async () => { await worker.stop(); await p.app.close(); await p.h.db.end(); });

describe("published examples against an unmodified server", () => {
  it("independent Python sample store passes its capability tests", async () => {
    const r = await run("python3", ["-m", "unittest", "-v", "test_sample_store.py"], `${root}examples/sample-store-python`);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("Ran 5 tests");
  }, 120_000);

  it("Shopify reference sync passes its capability tests (mock Shopify, real ReCart)", async () => {
    const r = await run("node", ["--test", "test/sync.test.mjs"], `${root}examples/shopify-sync`);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("# fail 0");
  }, 120_000);

  it("quickstart runs end to end, including the stock-change revisions", async () => {
    const r = await run("node", ["quickstart.mjs"], `${root}examples/quickstart`);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("proposal v3: proposal_ready");
  }, 120_000);
});
