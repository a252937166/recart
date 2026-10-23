import { randomUUID } from "node:crypto";
import { clock } from "../clock.js";
import { audit, enqueueJob, type Ctx } from "../context.js";
import { maybeOne } from "../db/pool.js";

/**
 * PayPal webhook inbox (spec §11): verify authenticity against PayPal, persist and de-duplicate by event ID,
 * bind to our app's checkout, then trigger reconciliation of the referenced resource. A webhook is payment
 * evidence only; it never moves state directly and never supplies buyer consent.
 */
export async function receivePayPalWebhook(ctx: Ctx, headers: Record<string, string | string[] | undefined>, rawBody: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let event: any;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "invalid_json" } }; }
  const eventId = typeof event?.id === "string" ? event.id : null;
  if (!eventId) return { status: 400, body: { error: "missing_event_id" } };
  const h = (k: string) => { const v = headers[k]; return Array.isArray(v) ? v[0] ?? "" : v ?? ""; };

  const existing = await maybeOne<{ status: string }>(ctx.db, "select status from webhook_events where event_id=$1", [eventId]);
  if (existing) return { status: 200, body: { duplicate: true, status: existing.status } };

  let verification = "FAILURE";
  let note: string | null = null;
  if (!ctx.cfg.PAYPAL_WEBHOOK_ID && ctx.paypal.mode !== "fake") note = "webhook id not configured";
  else {
    const v = await ctx.paypal.verifyWebhook({
      authAlgo: h("paypal-auth-algo"), certUrl: h("paypal-cert-url"), transmissionId: h("paypal-transmission-id"), transmissionSig: h("paypal-transmission-sig"), transmissionTime: h("paypal-transmission-time"),
      webhookId: ctx.cfg.PAYPAL_WEBHOOK_ID || "WH-FAKE", event, rawEvent: rawBody,
    });
    if (v.status === 0) return { status: 503, body: { error: "verification_unavailable" } }; // let PayPal retry
    verification = v.body?.verification_status === "SUCCESS" ? "SUCCESS" : "FAILURE";
    if (verification !== "SUCCESS") note = `verification_status=${v.body?.verification_status ?? v.status}`;
  }

  const resource = event.resource ?? {};
  const related = resource?.supplementary_data?.related_ids ?? {};
  const ids = [resource.id, related.order_id, related.authorization_id, related.capture_id].filter((x): x is string => typeof x === "string");
  const checkout = verification === "SUCCESS" && ids.length
    ? await maybeOne<{ id: string; session_id: string; intent_id: string }>(ctx.db, `select c.id, i.session_id, c.intent_id from checkouts c join intents i on i.id=c.intent_id
         where c.paypal_order_id = any($1) or c.authorization_id = any($1) or c.capture_id = any($1) or c.refund_id = any($1) limit 1`, [ids])
    : null;
  const status = verification !== "SUCCESS" ? "QUARANTINED" : checkout ? "PROCESSED" : "IGNORED";
  const id = randomUUID();
  const inserted = await ctx.db.query(
    `insert into webhook_events(id,event_id,event_type,resource_type,resource_id,verification,payload,status,checkout_id,note,received_at,processed_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) on conflict (event_id) do nothing`,
    [id, eventId, String(event.event_type ?? ""), String(event.resource_type ?? ""), typeof resource.id === "string" ? resource.id : null, verification, rawBody, status, checkout?.id ?? null, note, clock.now()],
  );
  if (!inserted.rowCount) return { status: 200, body: { duplicate: true } };
  if (checkout) {
    await enqueueJob(ctx.db, "reconcile_checkout", { checkoutId: checkout.id }, clock.now(), `reconcile:${checkout.id}`);
    await audit(ctx.db, { sessionId: checkout.session_id, intentId: checkout.intent_id, actor: "paypal-webhook", action: "webhook.verified", entity: "webhook_event", entityId: eventId, detail: { type: event.event_type, resource: resource.id } });
    ctx.events.changed(checkout.session_id, "webhook");
  }
  if (verification !== "SUCCESS") return { status: 400, body: { error: "verification_failed" } };
  return { status: 200, body: { received: true, status } };
}
