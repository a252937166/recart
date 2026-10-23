import { clock } from "../server/clock.js";
import { enqueueJob } from "../server/context.js";
import { many, maybeOne, withTx } from "../server/db/pool.js";
import { ApiError, canonicalJson, iso, type PlatformCtx, type Queryable } from "./core.js";
import { emitEvent } from "./events.js";
import type { MerchantRow } from "./merchants.js";
import type { ApiAttribute, ApiRole } from "./pack.js";
import type { ProductInput } from "./schemas.js";

export interface ProductRow {
  merchant_id: string; product_id: string; sku: string | null; name: string; role: ApiRole; description: string | null;
  attributes: Record<string, ApiAttribute>; price_cents: number; currency: string; status: "active" | "draft" | "archived";
  source_updated_at: Date | null; updated_at: Date;
}
export interface StockRow { fresh: number; stale: number; newestAsOf: Date | null; locations: number }

export function productView(p: ProductRow) {
  return {
    product_id: p.product_id, sku: p.sku, name: p.name, role: p.role, description: p.description, attributes: p.attributes,
    price_cents: p.price_cents, currency: p.currency, status: p.status, source_updated_at: iso(p.source_updated_at), updated_at: iso(p.updated_at),
  };
}

const comparable = (p: { sku?: string | null | undefined; name: string; role: string; description?: string | null | undefined; attributes: unknown; price_cents: number; currency: string; status: string }) =>
  canonicalJson({ sku: p.sku ?? null, name: p.name, role: p.role, description: p.description ?? null, attributes: p.attributes, price_cents: p.price_cents, currency: p.currency, status: p.status });

/** Queue re-planning of this merchant's open recoveries after its catalog or stock changed. */
async function queueRevalidation(q: Queryable, merchantId: string, reason: "catalog_changed" | "inventory_changed" | "inventory_refreshed") {
  // One job per merchant and cause: a re-queued job keeps its original payload, so the cause is part of the key.
  await enqueueJob(q, "revalidate_recoveries", { merchantId, reason }, clock.now(), `reval:${merchantId}:${reason}`);
}

/**
 * Create or update products in the standard format. A product whose `source_updated_at` is older than the stored one
 * is ignored, so a delayed sync cannot overwrite newer data. Any change bumps the merchant's catalog version.
 */
export async function upsertProducts(ctx: PlatformCtx, merchant: MerchantRow, products: ProductInput[]) {
  const seen = new Set<string>();
  products.forEach((p, i) => {
    if (p.currency !== merchant.currency) throw new ApiError("invalid_request", "currency_mismatch", `products[${i}].currency is ${p.currency}; this merchant uses ${merchant.currency}.`, { index: i });
    if (seen.has(p.product_id)) throw new ApiError("invalid_request", "duplicate_product", `product_id ${p.product_id} appears more than once.`, { index: i });
    seen.add(p.product_id);
  });
  return withTx(ctx.db, async (tx) => {
    const m = (await maybeOne<{ catalog_version: number }>(tx, "select catalog_version from merchants where id=$1 for update", [merchant.id]))!;
    const existing = new Map((await many<ProductRow>(tx, "select * from catalog_products where merchant_id=$1 and product_id = any($2)", [merchant.id, [...seen]])).map((r) => [r.product_id, r]));
    const now = clock.now();
    const results: { product_id: string; result: "created" | "updated" | "unchanged" | "ignored_older_update" }[] = [];
    for (const p of products) {
      const prior = existing.get(p.product_id);
      const sourceAt = p.source_updated_at ? new Date(p.source_updated_at) : null;
      if (prior?.source_updated_at && sourceAt && sourceAt.getTime() < prior.source_updated_at.getTime()) { results.push({ product_id: p.product_id, result: "ignored_older_update" }); continue; }
      if (prior && comparable(prior) === comparable(p)) {
        if (sourceAt) await tx.query("update catalog_products set source_updated_at=$3 where merchant_id=$1 and product_id=$2", [merchant.id, p.product_id, sourceAt]);
        results.push({ product_id: p.product_id, result: "unchanged" });
        continue;
      }
      await tx.query(`insert into catalog_products(merchant_id,product_id,sku,name,role,description,attributes,price_cents,currency,status,source_updated_at,updated_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        on conflict (merchant_id, product_id) do update set sku=excluded.sku, name=excluded.name, role=excluded.role, description=excluded.description,
          attributes=excluded.attributes, price_cents=excluded.price_cents, currency=excluded.currency, status=excluded.status, source_updated_at=excluded.source_updated_at, updated_at=excluded.updated_at`,
        [merchant.id, p.product_id, p.sku ?? null, p.name, p.role, p.description ?? null, JSON.stringify(p.attributes ?? {}), p.price_cents, p.currency, p.status, sourceAt, now]);
      results.push({ product_id: p.product_id, result: prior ? "updated" : "created" });
    }
    const changed = results.filter((r) => r.result === "created" || r.result === "updated");
    let version = m.catalog_version;
    if (changed.length) {
      version += 1;
      await tx.query("update merchants set catalog_version=$2 where id=$1", [merchant.id, version]);
      await emitEvent(tx, merchant, "catalog.updated", { catalog_version: version, changed_count: changed.length, changed_product_ids: changed.slice(0, 50).map((c) => c.product_id) });
      await queueRevalidation(tx, merchant.id, "catalog_changed");
    }
    const count = (r: string) => results.filter((x) => x.result === r).length;
    return { catalog_version: version, created: count("created"), updated: count("updated"), unchanged: count("unchanged"), ignored_older_updates: count("ignored_older_update"), products: results };
  });
}

/**
 * Record stock counts per product and location. Counts older than the stored one (by `as_of`) are ignored; a newer
 * count replaces it. Counts for products ReCart does not know yet are kept and reported.
 */
export async function upsertInventory(ctx: PlatformCtx, merchant: MerchantRow, levels: { product_id: string; location_id: string; available: number; as_of: string }[]) {
  const keys = new Set<string>();
  levels.forEach((l, i) => {
    const k = `${l.product_id}\u0000${l.location_id}`;
    if (keys.has(k)) throw new ApiError("invalid_request", "duplicate_level", `levels[${i}] repeats ${l.product_id} at ${l.location_id}.`, { index: i });
    keys.add(k);
  });
  return withTx(ctx.db, async (tx) => {
    await tx.query("select 1 from merchants where id=$1 for update", [merchant.id]);
    const now = clock.now();
    const cutoff = new Date(now.getTime() - merchant.inventory_max_age_seconds * 1000);
    const changes: { product_id: string; location_id: string; available: number; previous: number | null }[] = [];
    let ignored = 0;
    let refreshed = 0;
    for (const l of levels) {
      const prior = await maybeOne<{ available: number; as_of: Date }>(tx, "select available, as_of from inventory_levels where merchant_id=$1 and product_id=$2 and location_id=$3", [merchant.id, l.product_id, l.location_id]);
      const asOf = new Date(l.as_of);
      if (prior && asOf.getTime() < prior.as_of.getTime()) { ignored++; continue; }
      await tx.query(`insert into inventory_levels(merchant_id,product_id,location_id,available,as_of,received_at) values ($1,$2,$3,$4,$5,$6)
        on conflict (merchant_id, product_id, location_id) do update set available=excluded.available, as_of=excluded.as_of, received_at=excluded.received_at`,
        [merchant.id, l.product_id, l.location_id, l.available, asOf, now]);
      if (!prior || prior.available !== l.available) changes.push({ product_id: l.product_id, location_id: l.location_id, available: l.available, previous: prior?.available ?? null });
      // Same quantity, but a count too old to plan with is usable again: planning eligibility changed.
      else if (prior.as_of < cutoff && asOf >= cutoff) refreshed++;
    }
    const known = new Set((await many<{ product_id: string }>(tx, "select product_id from catalog_products where merchant_id=$1 and product_id = any($2)", [merchant.id, [...new Set(levels.map((l) => l.product_id))]])).map((r) => r.product_id));
    const unknown = [...new Set(levels.map((l) => l.product_id))].filter((id) => !known.has(id));
    if (changes.length) {
      await emitEvent(tx, merchant, "inventory.updated", { changed_count: changes.length, changes: changes.slice(0, 50) });
      await queueRevalidation(tx, merchant.id, "inventory_changed");
    } else if (refreshed) await queueRevalidation(tx, merchant.id, "inventory_refreshed");
    return { applied: levels.length - ignored, changed: changes.length, refreshed, ignored_older_updates: ignored, unknown_product_ids: unknown.slice(0, 50) };
  });
}

export async function listProducts(q: Queryable, merchantId: string, a: { status?: string | undefined; role?: string | undefined; after?: string | undefined; limit: number }) {
  const rows = await many<ProductRow>(q, `select * from catalog_products where merchant_id=$1 and ($2::text is null or status=$2) and ($3::text is null or role=$3) and ($4::text is null or product_id > $4)
    order by product_id limit $5`, [merchantId, a.status ?? null, a.role ?? null, a.after ?? null, a.limit]);
  return { data: rows.map(productView), has_more: rows.length === a.limit, next_after: rows.length ? rows[rows.length - 1]!.product_id : null };
}

export async function getProduct(q: Queryable, merchantId: string, productId: string) {
  const p = await maybeOne<ProductRow>(q, "select * from catalog_products where merchant_id=$1 and product_id=$2", [merchantId, productId]);
  if (!p) throw new ApiError("not_found", "product_not_found", "No product with this product_id for this merchant.");
  const levels = await many<any>(q, "select location_id, available, as_of, received_at from inventory_levels where merchant_id=$1 and product_id=$2 order by location_id", [merchantId, productId]);
  return { ...productView(p), inventory: levels.map((l) => ({ location_id: l.location_id, available: l.available, as_of: iso(l.as_of), received_at: iso(l.received_at) })) };
}

export async function listInventory(q: Queryable, merchant: MerchantRow, a: { product_id?: string | undefined; limit: number }) {
  const cutoff = new Date(clock.now().getTime() - merchant.inventory_max_age_seconds * 1000);
  const rows = await many<any>(q, "select product_id, location_id, available, as_of, received_at from inventory_levels where merchant_id=$1 and ($2::text is null or product_id=$2) order by product_id, location_id limit $3", [merchant.id, a.product_id ?? null, a.limit]);
  return { data: rows.map((l) => ({ product_id: l.product_id, location_id: l.location_id, available: l.available, as_of: iso(l.as_of), received_at: iso(l.received_at), fresh: l.as_of >= cutoff })) };
}

export async function loadProducts(q: Queryable, merchantId: string): Promise<Map<string, ProductRow>> {
  return new Map((await many<ProductRow>(q, "select * from catalog_products where merchant_id=$1", [merchantId])).map((p) => [p.product_id, p]));
}

/** Units per product at the given locations (all when omitted), split by whether the count is fresh enough to plan with. */
export async function loadStock(q: Queryable, merchant: MerchantRow, locationIds?: string[]): Promise<Map<string, StockRow>> {
  const cutoff = new Date(clock.now().getTime() - merchant.inventory_max_age_seconds * 1000);
  const rows = await many<{ product_id: string; available: number; as_of: Date }>(q, "select product_id, available, as_of from inventory_levels where merchant_id=$1 and ($2::text[] is null or location_id = any($2))", [merchant.id, locationIds?.length ? locationIds : null]);
  const out = new Map<string, StockRow>();
  for (const r of rows) {
    const s = out.get(r.product_id) ?? { fresh: 0, stale: 0, newestAsOf: null, locations: 0 };
    if (r.as_of >= cutoff) s.fresh += r.available; else s.stale += r.available;
    if (!s.newestAsOf || r.as_of > s.newestAsOf) s.newestAsOf = r.as_of;
    s.locations++;
    out.set(r.product_id, s);
  }
  return out;
}
