import { faultInjectionRefusal, loadConfig } from "./config.js";
import { enqueueJob, SessionEvents, type Ctx } from "./context.js";
import { createPool } from "./db/pool.js";
import { migrate } from "./db/migrations.js";
import { buildApp } from "./http/app.js";
import { startWorker } from "./jobs/worker.js";
import { languageFromConfig } from "./language/adapter.js";
import { LostResponseInjector, PayPalRestClient } from "./paypal/client.js";
import { FakePayPal } from "./paypal/fake.js";
import { installJournalPriorities, installLogCheck } from "./logging.js";
import { drainHttp, shutdownPlan, within } from "./shutdown.js";
import { fingerprint } from "./build-info.js";

fingerprint(import.meta.url, "main.js");

async function main() {
  const cfg = loadConfig();
  if (cfg.LOG_PRIORITY_PREFIX === "true") installJournalPriorities();
  installLogCheck();
  const db = createPool(cfg.DATABASE_URL);
  const applied = await migrate(db);
  if (applied.length) console.log("[db] applied migrations:", applied.join(", "));
  if (cfg.PAYPAL_MODE === "sandbox" && (!cfg.PAYPAL_CLIENT_ID || !cfg.PAYPAL_CLIENT_SECRET)) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required in sandbox mode");
  const base = cfg.PAYPAL_MODE === "fake" ? new FakePayPal() : new PayPalRestClient(cfg.PAYPAL_API_BASE, cfg.PAYPAL_CLIENT_ID, cfg.PAYPAL_CLIENT_SECRET);
  let paypal: Ctx["paypal"] = base;
  if (cfg.PAYPAL_FAULT_INJECTION === "1") {
    const refusal = faultInjectionRefusal(cfg);
    if (refusal) throw new Error(refusal);
    paypal = new LostResponseInjector(base);
    console.warn("[recart] PayPal fault injection enabled (local PP04 recording only)");
  }
  const ctx: Ctx = { db, paypal, cfg, events: new SessionEvents(), language: languageFromConfig(db, cfg) };
  ctx.events.setMaxListeners(500);
  await enqueueJob(db, "platform_maintenance", {}, new Date(), "platform_maintenance");
  // Money and notifications on one runner, model-bound jobs on another: a slow explanation never holds a payment job.
  const workers = cfg.WORKER_ENABLED === "true" ? [startWorker(ctx, { lane: "core" }), startWorker(ctx, { lane: "language" })] : [];
  const app = await buildApp(ctx);
  await app.listen({ port: cfg.PORT, host: cfg.HOST });
  console.log(`[recart] listening on ${cfg.HOST}:${cfg.PORT} (paypal=${paypal.mode}, preset=${cfg.TIMING_PRESET}, workers=${workers.map((w) => w.lane).join("+") || "off"}, language=${cfg.CODEX_API_URL && cfg.CODEX_API_KEY && cfg.LANGUAGE_PROVIDER !== "hosted" ? "codex" : "-"}${cfg.LANGUAGE_URL && cfg.LANGUAGE_PROVIDER !== "codex" ? "+hosted" : ""})`);
  // SIGTERM: stop the job runners and drain HTTP at the same time, each with a bound. Open event streams are ended
  // by the app's preClose hook; a running job gets the grace, then its lease is handed back so the next process takes
  // it over at once. Everything finishes well inside the service's stop timeout, so systemd never needs SIGKILL.
  const plan = shutdownPlan(cfg);
  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    const t0 = Date.now();
    console.log(`[recart] ${sig}: shutting down (HTTP drain ${plan.drainMs} ms, job grace ${plan.graceMs} ms, language job grace ${plan.languageGraceMs} ms, exit by ${plan.hardMs} ms)`);
    setTimeout(() => { console.error(`[recart] shutdown not finished after ${plan.hardMs} ms; exiting now`); process.exit(1); }, plan.hardMs).unref();
    const [http] = await Promise.all([drainHttp(app, plan.drainMs), Promise.all(workers.map((w) => w.stop(w.lane === "language" ? plan.languageGraceMs : plan.graceMs)))]);
    if (http.forced) console.warn(`[recart] HTTP requests were still open after ${plan.drainMs} ms; their connections were closed`);
    await within(db.end(), plan.dbMs);
    console.log(`[recart] shutdown complete in ${Date.now() - t0} ms`);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e) => { console.error("[recart] fatal", e); process.exit(1); });
