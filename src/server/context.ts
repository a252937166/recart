import { EventEmitter } from "node:events";
import type { Config } from "./config.js";
import type { Db, Queryable } from "./db/pool.js";
import type { PayPalApi } from "./paypal/types.js";
import type { LanguageAdapter } from "./language/adapter.js";
import { clock } from "./clock.js";

/** In-process change notifications for SSE (single application process; polling is the fallback). */
export class SessionEvents extends EventEmitter {
  changed(sessionId: string, reason: string) { this.emit("changed", { sessionId, reason, at: clock.now().toISOString() }); }
}

export interface Ctx {
  db: Db;
  paypal: PayPalApi;
  cfg: Config;
  events: SessionEvents;
  language: LanguageAdapter;
}

export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) { super(message); }
}

export async function audit(q: Queryable, e: { sessionId?: string | null; intentId?: string | null; actor: string; action: string; entity?: string; entityId?: string | null; detail?: unknown }) {
  await q.query("insert into audit_events(session_id,intent_id,actor,action,entity,entity_id,detail,at) values ($1,$2,$3,$4,$5,$6,$7,$8)", [
    e.sessionId ?? null, e.intentId ?? null, e.actor, e.action, e.entity ?? null, e.entityId ?? null, e.detail === undefined ? null : JSON.stringify(e.detail), clock.now(),
  ]);
}

/**
 * Schedule a job; a dedupe key keeps one row per purpose. A pending job keeps its earliest run time. A finished job
 * runs again at the requested time. A job that is running right now (it may be the caller) records the request in
 * rerun_at, and the worker schedules that run when the current one ends, so a self-rescheduling poll is never lost.
 */
export async function enqueueJob(q: Queryable, kind: string, payload: Record<string, unknown>, runAt: Date = clock.now(), dedupeKey?: string) {
  await q.query(
    `insert into jobs(kind,payload,run_at,dedupe_key) values ($1,$2,$3,$4) on conflict (dedupe_key) do update set
       run_at = case when jobs.status in ('DONE','FAILED') then excluded.run_at when jobs.status = 'PENDING' then least(jobs.run_at, excluded.run_at) else jobs.run_at end,
       rerun_at = case when jobs.status = 'RUNNING' then least(coalesce(jobs.rerun_at, excluded.run_at), excluded.run_at) else jobs.rerun_at end,
       attempts = case when jobs.status in ('DONE','FAILED') then 0 else jobs.attempts end,
       status = case when jobs.status in ('DONE','FAILED') then 'PENDING' else jobs.status end,
       updated_at = now()`,
    [kind, JSON.stringify(payload), runAt, dedupeKey ?? null],
  );
}
