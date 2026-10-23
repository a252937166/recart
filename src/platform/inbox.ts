import { clock } from "../server/clock.js";
import { many, maybeOne } from "../server/db/pool.js";
import { iso, newId, verifyCallback, type Queryable } from "./core.js";

/**
 * The ReCart-hosted webhook inbox for sandbox merchants: a real receiver that checks each callback's signature with
 * the merchant's secret, so developers can watch signed notifications before running their own endpoint.
 */
export async function receiveInbox(q: Queryable, merchantId: string, headers: Record<string, string | string[] | undefined>, body: string): Promise<{ status: number; body: unknown }> {
  const m = await maybeOne<{ kind: string; webhook_secret: string | null }>(q, "select kind, webhook_secret from merchants where id=$1", [merchantId]);
  if (!m || m.kind !== "sandbox") return { status: 404, body: { error: "unknown_inbox" } };
  const signature = typeof headers["recart-signature"] === "string" ? headers["recart-signature"] : undefined;
  const valid = !!m.webhook_secret && verifyCallback(m.webhook_secret, body, signature, Math.floor(clock.now().getTime() / 1000));
  const kept: Record<string, string> = {};
  for (const h of ["recart-event-id", "recart-event-type", "recart-signature", "content-type", "user-agent"]) if (typeof headers[h] === "string") kept[h] = headers[h] as string;
  await q.query("insert into sandbox_inbox(id,merchant_id,received_at,headers,body,signature_valid) values ($1,$2,$3,$4,$5,$6)", [newId("inb"), merchantId, clock.now(), JSON.stringify(kept), body.slice(0, 64 * 1024), valid]);
  await q.query("delete from sandbox_inbox where merchant_id=$1 and id not in (select id from sandbox_inbox where merchant_id=$1 order by received_at desc limit 200)", [merchantId]);
  return valid ? { status: 200, body: { received: true } } : { status: 400, body: { error: "invalid_signature" } };
}

export async function listInbox(q: Queryable, merchantId: string, limit: number) {
  const rows = await many<any>(q, "select id, received_at, headers, body, signature_valid from sandbox_inbox where merchant_id=$1 order by received_at desc limit $2", [merchantId, limit]);
  return rows.map((r) => {
    let parsed: unknown = null;
    try { parsed = JSON.parse(r.body); } catch { /* keep raw */ }
    return { id: r.id, received_at: iso(r.received_at), signature_valid: r.signature_valid, headers: r.headers, raw_body: r.body as string, event: parsed };
  });
}
