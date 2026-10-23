import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { fingerprint } from "./build-info.js";

fingerprint(import.meta.url, "shutdown.js");

/**
 * How long each part of a SIGTERM shutdown may take. HTTP draining and the job runners' grace run at the same time;
 * the database pool closes after both. `hardMs` is the point at which the process exits on its own even if something
 * is stuck, so systemd never has to escalate to SIGKILL: it must stay below TimeoutStopSec (checked by the tests).
 */
export interface ShutdownPlan { drainMs: number; graceMs: number; languageGraceMs: number; dbMs: number; hardMs: number }
export const FORCE_CLOSE_WAIT_MS = 2000;
export const DB_CLOSE_MS = 5000;
export function shutdownPlan(cfg: Pick<Config, "SHUTDOWN_DRAIN_SECONDS" | "SHUTDOWN_JOB_GRACE_SECONDS" | "SHUTDOWN_LANGUAGE_GRACE_SECONDS">): ShutdownPlan {
  const drainMs = Math.round(cfg.SHUTDOWN_DRAIN_SECONDS * 1000);
  const graceMs = Math.round(cfg.SHUTDOWN_JOB_GRACE_SECONDS * 1000);
  const languageGraceMs = Math.round(cfg.SHUTDOWN_LANGUAGE_GRACE_SECONDS * 1000);
  // Workers: the longer grace, then one lease-release query (bounded by the database close budget).
  const parallel = Math.max(drainMs + FORCE_CLOSE_WAIT_MS, Math.max(graceMs, languageGraceMs) + DB_CLOSE_MS);
  return { drainMs, graceMs, languageGraceMs, dbMs: DB_CLOSE_MS, hardMs: parallel + DB_CLOSE_MS + 3000 };
}

/** Wait for `work` at most `ms`; resolves `true` if it finished in time. Never rejects, never holds the event loop. */
export function within(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); });
  return Promise.race([work.then(() => true, () => true), limit]).finally(() => clearTimeout(timer));
}

/**
 * Stop the HTTP server with a bound. `app.close()` first runs the preClose hooks, which end every open event stream,
 * then waits for in-flight requests. A request still running after `drainMs` (a draft waiting on a model, say) has its
 * connection closed, so the close completes.
 */
export async function drainHttp(app: FastifyInstance, drainMs: number): Promise<{ drained: boolean; forced: boolean }> {
  const closed = app.close();
  if (await within(closed, drainMs)) return { drained: true, forced: false };
  app.server.closeAllConnections?.();
  await within(closed, FORCE_CLOSE_WAIT_MS);
  return { drained: false, forced: true };
}
