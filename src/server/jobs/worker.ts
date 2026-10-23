import { hostname } from "node:os";
import { clock } from "../clock.js";
import type { Ctx } from "../context.js";
import { maybeOne, withTx, type Tx } from "../db/pool.js";
import { within } from "../shutdown.js";
import { releaseRetained } from "../services/inventory.js";
import { deliverPending } from "../services/notifications.js";
import { onApprovalDeadline, onReleaseDeadline, reconcileCheckout, runOperation } from "../services/payments.js";
import { enqueueJob } from "../context.js";
import { deliverWebhook } from "../../platform/events.js";
import { platformMaintenance, revalidateOpenRecoveries } from "../../platform/recoveries.js";
import { explainCase, settleExplanation } from "../services/recovery.js";
import { fingerprint } from "../build-info.js";

fingerprint(import.meta.url, "jobs/worker.js");

interface JobRow { id: number; kind: string; payload: any; attempts: number }

/**
 * Two lanes over one durable table. Money, notifications and webhooks run on the core lane; jobs that wait on a
 * language model run on their own lane, so a slow explanation never delays a hold release, a reconciliation or a
 * refund poll. Each lane is a runner; a lane's runner never claims the other lane's kinds.
 */
export type Lane = "core" | "language";
export const LANGUAGE_KINDS = ["explain_case"] as const;
const CORE_LEASE_MS = 60_000;
/** Retries before a job is failed for good. The explanation is optional (the template is already shown), so few. */
const MAX_ATTEMPTS: Record<string, number> = { explain_case: 5 };
const DEFAULT_MAX_ATTEMPTS = 25;

/** A language job may run as long as the worst-case model call; the lease must outlast it or a second runner takes it over mid-flight. */
export function leaseMs(ctx: Ctx, lane: Lane): number {
  if (lane === "core") return CORE_LEASE_MS;
  const worst = ctx.language.worstCaseSeconds?.("explain_change") ?? 300;
  return (worst + 60) * 1000;
}

/**
 * Durable job loop (spec §11, §12): work and leases live in PostgreSQL, so a restart or a second runner
 * resumes safely. Money reconciliation never depends on the browser, the model, or notifications.
 */
export function startWorker(ctx: Ctx, opts: { intervalMs?: number; owner?: string; lane?: Lane } = {}) {
  const lane = opts.lane ?? "core";
  const owner = opts.owner ?? `${hostname()}:${process.pid}:${lane}`;
  const interval = opts.intervalMs ?? 750;
  let stopped = false;
  let running: Promise<void> | null = null;
  const tick = async () => {
    if (stopped) return;
    try { while (!stopped && (await runOneJob(ctx, owner, lane))) { /* drain due jobs */ } }
    catch (e: any) { console.error(`[worker:${lane}] tick failed`, e?.message ?? e); }
    if (!stopped) timer = setTimeout(() => { running = tick(); }, interval);
  };
  let timer: NodeJS.Timeout = setTimeout(() => { running = tick(); }, 50);
  return {
    owner, lane,
    /**
     * Stop claiming; wait up to the grace for the current job, then hand back any lease still held so the next process
     * resumes the job at once. A job still running here past that point is safe to run again: every job is idempotent
     * or guarded (payments by request ID and in-flight checks, explanations by the pending flag and solve run).
     */
    async stop(graceMs = 10_000) {
      stopped = true;
      clearTimeout(timer);
      const finished = running ? await within(running, graceMs) : true;
      const r = await ctx.db.query<{ id: number; kind: string }>("update jobs set status='PENDING', lease_owner=null, lease_until=null, updated_at=$2 where lease_owner=$1 and status='RUNNING' returning id, kind", [owner, clock.now()])
        .catch((e: any) => { console.error(`[worker:${lane}] lease release failed; the lease will expire instead:`, e?.message ?? e); return null; });
      const handed = r?.rows ?? [];
      console.log(`[worker:${lane}] stopped${finished ? "" : ` (a job was still running after ${graceMs} ms)`}${handed.length ? `; handed back ${handed.map((j) => `${j.kind}#${j.id}`).join(", ")} for the next process` : ""}`);
    },
  };
}

export async function runOneJob(ctx: Ctx, owner: string, lane: Lane = "core"): Promise<boolean> {
  const now = clock.now();
  const job = await maybeOne<JobRow>(ctx.db, `update jobs set status='RUNNING', lease_owner=$1, lease_until=$3, attempts=attempts+1, updated_at=$2
     where id = (select id from jobs where ((status='PENDING' and run_at <= $2) or (status='RUNNING' and lease_until < $2)) and (kind = any($4::text[])) = $5
                 order by run_at, id limit 1 for update skip locked)
     returning id, kind, payload, attempts`, [owner, now, new Date(now.getTime() + leaseMs(ctx, lane)), [...LANGUAGE_KINDS], lane === "language"]);
  if (!job) return false;
  try {
    await handle(ctx, job);
    // A follow-up requested during this run (rerun_at) becomes the next scheduled run instead of being dropped.
    await ctx.db.query(`update jobs set status = case when rerun_at is null then 'DONE' else 'PENDING' end, run_at = coalesce(rerun_at, run_at), rerun_at = null,
        lease_owner = null, lease_until = null, last_error = null, updated_at = $2 where id = $1 and status = 'RUNNING' and lease_owner = $3`, [job.id, clock.now(), owner]);
  } catch (e: any) {
    const message = String(e?.message ?? e).slice(0, 500);
    const lastAttempt = job.attempts >= (MAX_ATTEMPTS[job.kind] ?? DEFAULT_MAX_ATTEMPTS);
    const retryAt = new Date(clock.now().getTime() + Math.min(300_000, 2000 * job.attempts * job.attempts));
    try {
      const outcome = await recordFailure(ctx, job, owner, { lastAttempt, retryAt, message });
      console.error(`[worker:${lane}] job ${job.kind}#${job.id} attempt ${job.attempts} failed (${outcome}):`, e?.message ?? e);
    } catch (e2: any) {
      // Neither the job's new state nor its cleanup committed. Give the lease back (only if still ours) so the job runs
      // again soon; if even that fails, the lease expires and another runner takes the job over.
      console.error(`[worker:${lane}] recording the failure of ${job.kind}#${job.id} failed; it stays retryable:`, e2?.message ?? e2);
      await ctx.db.query(`update jobs set status = 'PENDING', run_at = $3, lease_owner = null, lease_until = null, last_error = $4, updated_at = $5 where id = $1 and status = 'RUNNING' and lease_owner = $2`,
        [job.id, owner, retryAt, `${message} (failure not recorded: ${String(e2?.message ?? e2)})`.slice(0, 500), clock.now()])
        .catch((e3: any) => console.error(`[worker:${lane}] releasing ${job.kind}#${job.id} failed; its lease will expire:`, e3?.message ?? e3));
    }
  }
  return true;
}

/**
 * Record a failed run. Only the runner that still holds the lease may change the job (status RUNNING, lease owner
 * itself); the RETURNING row says what the job became. It becomes FAILED only on its last attempt with no rerun
 * requested meanwhile; only then is the cleanup a dead job owes (an explanation stops waiting) applied, in the same
 * transaction, so a crash or a cleanup error leaves the job retryable rather than FAILED beside a case that still
 * waits. A runner that lost its lease changes nothing: the runner that took over decides.
 */
async function recordFailure(ctx: Ctx, job: JobRow, owner: string, f: { lastAttempt: boolean; retryAt: Date; message: string }): Promise<"lost" | "retry" | "failed"> {
  const { outcome, announce } = await withTx(ctx.db, async (tx) => {
    const r = await maybeOne<{ status: string }>(tx, `update jobs set status = case when $2::boolean and rerun_at is null then 'FAILED' else 'PENDING' end, run_at = least($3, coalesce(rerun_at, $3)), rerun_at = null,
        lease_owner = null, lease_until = null, last_error = $4, updated_at = $5 where id = $1 and status = 'RUNNING' and lease_owner = $6 returning status`, [job.id, f.lastAttempt, f.retryAt, f.message, clock.now(), owner]);
    if (!r) return { outcome: "lost" as const, announce: null };
    if (r.status !== "FAILED") return { outcome: "retry" as const, announce: null };
    return { outcome: "failed" as const, announce: await settle(ctx, tx, job, f.message) };
  });
  announce?.();
  return outcome;
}

async function handle(ctx: Ctx, job: JobRow) {
  switch (job.kind) {
    case "run_operation": return runOperation(ctx, job.payload.opId);
    case "reconcile_checkout": return reconcileCheckout(ctx, job.payload.checkoutId);
    case "approval_deadline": return onApprovalDeadline(ctx, job.payload.checkoutId);
    case "release_deadline": return onReleaseDeadline(ctx, job.payload.checkoutId);
    case "deliver_notifications": return deliverPending(ctx, job.payload.sessionId);
    case "explain_case": return explainCase(ctx, job.payload);
    case "expire_retained": {
      // Release this intent's retained goods if the buyer has not started a replacement checkout in time.
      await withTx(ctx.db, async (tx) => {
        const open = await maybeOne(tx, "select 1 from checkouts where intent_id=$1 and not terminal", [job.payload.intentId]);
        if (!open) await releaseRetained(tx, job.payload.intentId);
      });
      return;
    }
    case "deliver_webhook": return deliverWebhook(ctx, job.payload.deliveryId);
    case "revalidate_recoveries": { await revalidateOpenRecoveries(ctx, job.payload.merchantId, job.payload.reason ?? "inventory_changed"); return; }
    case "platform_maintenance": {
      await platformMaintenance(ctx);
      await enqueueJob(ctx.db, "platform_maintenance", {}, new Date(clock.now().getTime() + 60_000), "platform_maintenance");
      return;
    }
    default: throw new Error(`unknown job kind ${job.kind}`);
  }
}

/** What a terminal failure must still put right, inside its transaction; returns what to announce after the commit. */
async function settle(ctx: Ctx, tx: Tx, job: JobRow, error: string): Promise<(() => void) | null> {
  if (job.kind === "explain_case" && (await settleExplanation(tx, job.payload, error))) return () => ctx.events.changed(job.payload.sessionId, "explanation");
  return null;
}
