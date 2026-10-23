import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { clock } from "../server/clock.js";
import { enqueueJob } from "../server/context.js";
import { many, maybeOne } from "../server/db/pool.js";
import { ApiError, iso, newId, signCallback, type PlatformCtx, type Queryable } from "./core.js";
import { receiveInbox } from "./inbox.js";
import type { MerchantRow } from "./merchants.js";

export const EVENT_TYPES = [
  "catalog.updated", "inventory.updated", "recovery.created", "proposal.created", "proposal.revised",
  "proposal.approved", "proposal.declined", "proposal.expired", "recovery.requirements_updated", "recovery.cancelled",
  "execution.started", "execution.succeeded", "execution.failed", "execution.unknown", "webhook.test",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Record an event and, when the merchant has a callback URL, queue a signed delivery. */
export async function emitEvent(q: Queryable, merchant: Pick<MerchantRow, "id" | "webhook_url">, type: EventType, data: Record<string, unknown>): Promise<string> {
  const id = newId("evt");
  const now = clock.now();
  await q.query("insert into platform_events(id,merchant_id,type,data,created_at) values ($1,$2,$3,$4,$5)", [id, merchant.id, type, JSON.stringify(data), now]);
  if (merchant.webhook_url) {
    const delivery = newId("whd");
    await q.query("insert into webhook_deliveries(id,merchant_id,event_id,url,status,created_at,next_attempt_at) values ($1,$2,$3,$4,'pending',$5,$5)", [delivery, merchant.id, id, merchant.webhook_url, now]);
    await enqueueJob(q, "deliver_webhook", { deliveryId: delivery }, now, `whd:${delivery}`);
  }
  return id;
}

export function eventView(e: { id: string; type: string; data: unknown; created_at: Date }) {
  return { id: e.id, type: e.type, created_at: e.created_at.toISOString(), data: e.data };
}

export async function listEvents(q: Queryable, merchantId: string, a: { after?: string | undefined; limit: number; type?: string | undefined }) {
  const after = a.after ? await maybeOne<{ created_at: Date; id: string }>(q, "select created_at, id from platform_events where id=$1 and merchant_id=$2", [a.after, merchantId]) : null;
  if (a.after && !after) throw new ApiError("invalid_request", "invalid_cursor", "`after` must be the id of an event from an earlier page.");
  // Composite (created_at, id) cursor matching the sort order: events written in the same millisecond are never skipped.
  const rows = await many<any>(q, `select * from platform_events where merchant_id=$1 and ($2::timestamptz is null or (created_at, id) > ($2::timestamptz, $3::text))
    and ($4::text is null or type=$4) order by created_at asc, id asc limit $5`, [merchantId, after?.created_at ?? null, after?.id ?? null, a.type ?? null, a.limit + 1]);
  const page = rows.slice(0, a.limit);
  return { data: page.map(eventView), has_more: rows.length > a.limit, next_after: page.length ? page[page.length - 1].id : a.after ?? null };
}

export async function listDeliveries(q: Queryable, merchantId: string, limit: number) {
  const rows = await many<any>(q, "select d.*, e.type event_type from webhook_deliveries d join platform_events e on e.id=d.event_id where d.merchant_id=$1 order by d.created_at desc limit $2", [merchantId, limit]);
  return rows.map((d) => ({ id: d.id, event_id: d.event_id, event_type: d.event_type, url: d.url, status: d.status, attempts: d.attempts, last_status_code: d.last_status_code, last_error: d.last_error, created_at: iso(d.created_at), delivered_at: iso(d.delivered_at), next_attempt_at: d.status === "pending" ? iso(d.next_attempt_at) : null }));
}

const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200, 21600];

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}

/** Callback URLs must be public HTTPS endpoints; loopback is allowed only when the operator enables it (tests). */
export async function assertDeliverableUrl(raw: string, allowLoopback: boolean): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiError("invalid_request", "invalid_webhook_url", "The webhook URL is not a valid URL."); }
  const loopbackHost = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.username || url.password) throw new ApiError("invalid_request", "invalid_webhook_url", "Webhook URLs cannot contain credentials.");
  if (allowLoopback && loopbackHost) return url;
  if (url.protocol !== "https:") throw new ApiError("invalid_request", "invalid_webhook_url", "Webhook URLs must use HTTPS.");
  const addresses = isIP(url.hostname) ? [url.hostname] : (await lookup(url.hostname, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) throw new ApiError("invalid_request", "invalid_webhook_url", "The webhook host does not resolve.");
  if (addresses.some(privateAddress)) throw new ApiError("invalid_request", "invalid_webhook_url", "Webhook URLs must resolve to public addresses.");
  return url;
}

/** The hosted sandbox inbox on this server is delivered in-process (same signed bytes, no network hairpin). */
export function inboxUrl(cfg: PlatformCtx["cfg"], merchantId: string) {
  return `${cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/v1/sandbox/inbox/${merchantId}`;
}
function ownInbox(ctx: PlatformCtx, raw: string): string | null {
  const prefix = inboxUrl(ctx.cfg, "");
  if (!raw.startsWith(prefix)) return null;
  const id = raw.slice(prefix.length);
  return /^mch_[a-z0-9]{20}$/.test(id) ? id : null;
}

/** Deliver one queued callback. Non-2xx and network failures retry with backoff, then the delivery is marked failed. */
export async function deliverWebhook(ctx: PlatformCtx, deliveryId: string): Promise<void> {
  const d = await maybeOne<any>(ctx.db, "select d.*, e.type, e.data, e.created_at event_created_at, m.webhook_secret from webhook_deliveries d join platform_events e on e.id=d.event_id join merchants m on m.id=d.merchant_id where d.id=$1", [deliveryId]);
  if (!d || d.status !== "pending" || !d.webhook_secret) return;
  const body = JSON.stringify({ id: d.event_id, type: d.type, created_at: new Date(d.event_created_at).toISOString(), data: d.data });
  const timestamp = Math.floor(clock.now().getTime() / 1000);
  const headers = { "content-type": "application/json", "user-agent": "ReCart-Webhooks/1", "recart-event-id": d.event_id, "recart-event-type": d.type, "recart-signature": signCallback(d.webhook_secret, body, timestamp) };
  let status: number | null = null; let error: string | null = null;
  try {
    const inbox = ownInbox(ctx, d.url);
    if (inbox) status = (await receiveInbox(ctx.db, inbox, headers, body)).status;
    else {
      const url = await assertDeliverableUrl(d.url, ctx.cfg.WEBHOOK_ALLOW_LOOPBACK === "true");
      const r = await fetch(url, { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), body, headers });
      status = r.status;
      await r.body?.cancel().catch(() => {});
    }
  } catch (e: any) { error = String(e?.message ?? e).slice(0, 300); }
  const attempts = d.attempts + 1;
  if (status !== null && status >= 200 && status < 300) {
    await ctx.db.query("update webhook_deliveries set status='delivered', attempts=$2, last_status_code=$3, last_error=null, delivered_at=$4, next_attempt_at=null where id=$1", [d.id, attempts, status, clock.now()]);
    return;
  }
  const wait = BACKOFF_SECONDS[attempts - 1];
  const failed = wait === undefined;
  const next = failed ? null : new Date(clock.now().getTime() + wait * 1000);
  await ctx.db.query("update webhook_deliveries set status=$2, attempts=$3, last_status_code=$4, last_error=$5, next_attempt_at=$6 where id=$1",
    [d.id, failed ? "failed" : "pending", attempts, status, error ?? (status ? `HTTP ${status}` : null), next]);
  if (next) await enqueueJob(ctx.db, "deliver_webhook", { deliveryId: d.id }, next, `whd:${d.id}`);
}
