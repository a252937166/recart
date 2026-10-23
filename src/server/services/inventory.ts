import { randomUUID } from "node:crypto";
import { clock } from "../clock.js";
import { AppError } from "../context.js";
import { many, type Queryable, type Tx } from "../db/pool.js";

const HELD = "('RESERVED','COMMITTED','FROZEN')";

/**
 * Ownership-aware availability (spec §7): units held by other intents are excluded; this intent's own
 * RESERVED/COMMITTED units remain usable by its own recovery search; FROZEN units are never counted.
 */
export async function availabilityFor(q: Queryable, sessionId: string, intentId: string): Promise<Record<string, number>> {
  const stock = await many<{ sku: string; on_hand: number }>(q, "select sku, on_hand from inventory where session_id=$1", [sessionId]);
  const others = await many<{ sku: string; qty: number }>(q, `select sku, sum(qty)::int as qty from reservations where session_id=$1 and intent_id<>$2 and status in ${HELD} group by sku`, [sessionId, intentId]);
  const frozenSelf = await many<{ sku: string; qty: number }>(q, "select sku, sum(qty)::int as qty from reservations where session_id=$1 and intent_id=$2 and status='FROZEN' group by sku", [sessionId, intentId]);
  const out: Record<string, number> = {};
  for (const s of stock) out[s.sku] = s.on_hand;
  for (const o of others) out[o.sku] = (out[o.sku] ?? 0) - o.qty;
  for (const f of frozenSelf) out[f.sku] = (out[f.sku] ?? 0) - f.qty;
  for (const k of Object.keys(out)) out[k] = Math.max(0, out[k]!);
  return out;
}

/**
 * Atomically migrate this intent's retained units to a new checkout and reserve the complete bundle.
 * Inventory rows for the involved SKUs are locked in SKU order to avoid deadlocks.
 */
export async function reserveBundle(tx: Tx, args: { sessionId: string; intentId: string; checkoutId: string; lines: { sku: string; qty: number }[]; expiresAt: Date }) {
  const now = clock.now();
  const skus = [...new Set(args.lines.map((l) => l.sku))].sort();
  await tx.query("select sku from inventory where session_id=$1 and sku = any($2) order by sku for update", [args.sessionId, skus]);
  // Release retained (checkout-less) holds of this intent inside the same transaction.
  await tx.query("update reservations set status='RELEASED', updated_at=$3 where session_id=$1 and intent_id=$2 and checkout_id is null and status='RESERVED'", [args.sessionId, args.intentId, now]);
  const avail = await availabilityFor(tx, args.sessionId, args.intentId);
  // Units this intent still holds for other (non-terminal) checkouts are not reusable here.
  const ownHeld = await many<{ sku: string; qty: number }>(tx, "select sku, sum(qty)::int qty from reservations where session_id=$1 and intent_id=$2 and checkout_id is not null and status in ('RESERVED','COMMITTED') group by sku", [args.sessionId, args.intentId]);
  for (const h of ownHeld) avail[h.sku] = Math.max(0, (avail[h.sku] ?? 0) - h.qty);
  const short = args.lines.filter((l) => (avail[l.sku] ?? 0) < l.qty);
  if (short.length) throw new AppError(409, "stock_changed", "Part of this setup is no longer available.", { short: short.map((l) => ({ sku: l.sku, need: l.qty, available: avail[l.sku] ?? 0 })) });
  for (const l of args.lines) {
    await tx.query("insert into reservations(id,session_id,intent_id,checkout_id,sku,qty,status,expires_at,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,'RESERVED',$7,$8,$8)", [randomUUID(), args.sessionId, args.intentId, args.checkoutId, l.sku, l.qty, args.expiresAt, now]);
  }
}

export async function setCheckoutReservations(tx: Tx, checkoutId: string, status: "RESERVED" | "COMMITTED" | "FROZEN" | "RELEASED" | "FULFILLED", expiresAt?: Date | null) {
  await tx.query(`update reservations set status=$2, expires_at=coalesce($3, expires_at), updated_at=$4 where checkout_id=$1 and status in ('RESERVED','COMMITTED','FROZEN')`, [checkoutId, status, expiresAt ?? null, clock.now()]);
}

/** After an old attempt ends during recovery, keep its units held for the intent (no checkout) for a short decision window. */
export async function retainForIntent(tx: Tx, checkoutId: string, holdUntil: Date) {
  await tx.query("update reservations set checkout_id=null, status='RESERVED', expires_at=$2, updated_at=$3 where checkout_id=$1 and status in ('RESERVED','COMMITTED','FROZEN')", [checkoutId, holdUntil, clock.now()]);
}

export async function releaseRetained(tx: Tx, intentId: string) {
  await tx.query("update reservations set status='RELEASED', updated_at=$2 where intent_id=$1 and checkout_id is null and status='RESERVED'", [intentId, clock.now()]);
}
