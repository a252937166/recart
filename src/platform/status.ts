import { clock } from "../server/clock.js";
import { many, maybeOne } from "../server/db/pool.js";
import { iso, type Queryable } from "./core.js";
import type { MerchantRow } from "./merchants.js";

/**
 * Integration health for one merchant, computed from stored data only: what the integration reported about itself,
 * how complete and fresh its catalog and stock are, recovery states and callback delivery.
 */
export async function integrationStatus(q: Queryable, m: MerchantRow) {
  const now = clock.now();
  const cutoff = new Date(now.getTime() - m.inventory_max_age_seconds * 1000);
  const catalog = await maybeOne<any>(q, `select count(*)::int total, count(*) filter (where status='active')::int active, count(*) filter (where status='draft')::int draft,
      count(*) filter (where status='archived')::int archived, max(updated_at) last_change, max(source_updated_at) last_source_change from catalog_products where merchant_id=$1`, [m.id]);
  const stock = await maybeOne<any>(q, `select count(*)::int levels, count(*) filter (where as_of >= $2)::int fresh, count(*) filter (where as_of < $2)::int stale,
      coalesce(sum(available) filter (where as_of >= $2),0)::int fresh_units, count(distinct location_id)::int locations, max(as_of) newest, min(as_of) oldest, max(received_at) last_received
      from inventory_levels where merchant_id=$1`, [m.id, cutoff]);
  const recoveries = await many<{ status: string; n: number }>(q, "select status, count(*)::int n from recoveries where merchant_id=$1 group by status", [m.id]);
  const hooks = await maybeOne<any>(q, `select count(*) filter (where status='delivered')::int delivered, count(*) filter (where status='pending')::int pending, count(*) filter (where status='failed')::int failed,
      max(delivered_at) last_delivered from webhook_deliveries where merchant_id=$1`, [m.id]);
  const keys = await maybeOne<any>(q, "select count(*) filter (where revoked_at is null)::int active, max(last_used_at) last_used from api_keys where merchant_id=$1", [m.id]);
  const unpriced = await maybeOne<any>(q, `select count(*)::int n from catalog_products p where merchant_id=$1 and status='active'
      and not exists (select 1 from inventory_levels l where l.merchant_id=p.merchant_id and l.product_id=p.product_id)`, [m.id]);
  const warnings: string[] = [];
  if (!catalog.total) warnings.push("No products yet: send your catalog with POST /v1/catalog/products.");
  if (catalog.total && !catalog.active) warnings.push("No active products: only active products are used in proposals.");
  if (stock.stale) warnings.push(`${stock.stale} stock count(s) are older than ${Math.round(m.inventory_max_age_seconds / 3600)} h and are not used for planning.`);
  if (unpriced.n) warnings.push(`${unpriced.n} active product(s) have no stock count and are treated as out of stock.`);
  if (hooks.failed) warnings.push(`${hooks.failed} webhook delivery(ies) failed after all retries.`);
  const notes: string[] = [];
  if (!m.webhook_url) notes.push("No webhook endpoint: this integration polls GET /v1/events (PUT /v1/webhook-endpoint enables signed callbacks).");
  return {
    merchant: { id: m.id, name: m.name, kind: m.kind, currency: m.currency },
    integration: m.integration ? { ...m.integration, reported_at: iso(m.integration_reported_at) } : null,
    catalog: { products: catalog.total, active: catalog.active, draft: catalog.draft, archived: catalog.archived, catalog_version: m.catalog_version, last_change_at: iso(catalog.last_change), last_source_change_at: iso(catalog.last_source_change) },
    inventory: { levels: stock.levels, fresh_levels: stock.fresh, stale_levels: stock.stale, fresh_units: stock.fresh_units, locations: stock.locations, newest_count_at: iso(stock.newest), oldest_count_at: iso(stock.oldest), last_received_at: iso(stock.last_received), max_age_seconds: m.inventory_max_age_seconds },
    recoveries: Object.fromEntries(recoveries.map((r) => [r.status, r.n])),
    webhooks: { endpoint_set: !!m.webhook_url, delivered: hooks.delivered, pending: hooks.pending, failed: hooks.failed, last_delivered_at: iso(hooks.last_delivered) },
    api_keys: { active: keys.active, last_used_at: iso(keys.last_used) },
    health: warnings.length === 0 ? "ok" : catalog.total ? "attention" : "not_connected",
    warnings,
    notes,
    checked_at: now.toISOString(),
  };
}
