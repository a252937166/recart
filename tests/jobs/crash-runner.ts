// A separate process that runs one language-lane job whose model call fails, so a test can kill it (SIGKILL) while
// it is inside the transaction that records the failure. Run with `node --import tsx tests/jobs/crash-runner.ts`.
// Env: TEST_DB, CLOCK (ISO time for the test clock), OWNER, and optionally RECART_IMPL_DIR (a compiled tree to load
// instead of the sources, as in vitest.config.ts).
import path from "node:path";
import { pathToFileURL } from "node:url";

const base = process.env.RECART_IMPL_DIR ? pathToFileURL(path.resolve(process.env.RECART_IMPL_DIR) + "/").href : new URL("../../src/", import.meta.url).href;
const { installClock, TestClock } = await import(`${base}server/clock.js`);
const { createPool } = await import(`${base}server/db/pool.js`);
const { runOneJob } = await import(`${base}server/jobs/worker.js`);
const { SessionEvents } = await import(`${base}server/context.js`);

installClock(new TestClock(new Date(process.env.CLOCK!)));
const db = createPool(process.env.TEST_DB!, 2);
const language = {
  extractGoal: async () => { throw new Error("not used"); },
  health: async () => ({ configured: false, reachable: null }),
  explainChange: async () => { throw new Error("model exploded in the process that is about to be killed"); },
};
const ctx = { db, paypal: null, cfg: {}, events: new SessionEvents(), language };
process.stdout.write("claiming\n");
const ran = await runOneJob(ctx as any, process.env.OWNER!, "language");
process.stdout.write(`finished ${ran}\n`);
await db.end();
