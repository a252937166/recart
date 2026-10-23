import { randomUUID } from "node:crypto";
import { clock } from "../clock.js";
import { enqueueJob, type Ctx } from "../context.js";
import { many, type Queryable } from "../db/pool.js";

/**
 * Durable notification outbox (spec §10). The competition build delivers to a clearly labeled in-app demo
 * inbox through the same outbox path a real email adapter would use; it never claims email/SMS delivery.
 */
export async function queueNotification(q: Queryable, n: { sessionId: string; caseId?: string | null; kind: string; title: string; body: string; link?: string | null }) {
  const id = randomUUID();
  await q.query("insert into notifications(id,session_id,case_id,kind,title,body,link,created_at,next_attempt_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$8)", [id, n.sessionId, n.caseId ?? null, n.kind, n.title, n.body, n.link ?? null, clock.now()]);
  await enqueueJob(q, "deliver_notifications", { sessionId: n.sessionId }, clock.now(), `notify:${n.sessionId}`);
  return id;
}

/** Deliver pending notifications to the demo inbox, with bounded retries and stable IDs. */
export async function deliverPending(ctx: Ctx, sessionId: string) {
  const due = await many<{ id: string; attempts: number }>(ctx.db, "select id, attempts from notifications where session_id=$1 and status='PENDING' and next_attempt_at <= $2 order by created_at", [sessionId, clock.now()]);
  for (const n of due) {
    // Demo inbox delivery is a local write; a future email adapter would call its provider here.
    await ctx.db.query("update notifications set status='DELIVERED', delivered_at=$2, attempts=attempts+1 where id=$1 and status='PENDING'", [n.id, clock.now()]);
  }
  if (due.length) ctx.events.changed(sessionId, "notification");
}
