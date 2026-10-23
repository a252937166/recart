import { mapCatalog, mapLevels } from "./map.mjs";

export const INTEGRATION = {
  name: "Shopify reference sync", platform: "shopify", version: "1.0.0",
  capabilities: ["catalog_sync", "inventory_sync", "stock_change_watch", "recovery_requests", "buyer_review_links"],
  not_supported: ["Shopify checkout", "Shopify order edits", "payments", "writes to Shopify"],
};

/** Full sync: products (with reviewed facts) and current stock at every active location. */
export async function fullSync({ shopify, recart, mapping, includeDrafts, log = console.log, runId = Date.now().toString(36) }) {
  const shop = await shopify.shopInfo();
  await recart.call("PUT", "/v1/merchant/integration", { ...INTEGRATION, source: shop.myshopifyDomain });
  const products = await shopify.products();
  const { products: mapped, skipped } = mapCatalog({ products, currency: shop.currencyCode, mapping, includeDrafts });
  for (const s of skipped) log(`skipped variant ${s.variant_id} (${s.sku ?? "no SKU"}): ${s.reason}`);
  const drafts = products.filter((p) => p.status === "DRAFT").length;
  if (drafts && includeDrafts) log(`treating ${drafts} DRAFT product(s) as sellable because --include-drafts was given`);
  const catalog = mapped.length ? await recart.call("POST", "/v1/catalog/products", { products: mapped }, { idempotencyKey: `shopify-catalog-${runId}` }) : null;
  const levels = await readLevels({ shopify, productIds: new Set(mapped.map((p) => p.product_id)) });
  const stock = levels.length ? await recart.call("POST", "/v1/inventory/levels", { levels }, { idempotencyKey: `shopify-stock-${runId}` }) : null;
  log(`synced ${mapped.length} products (catalog v${catalog?.catalog_version ?? "-"}, ${catalog?.created ?? 0} new, ${catalog?.updated ?? 0} updated) and ${levels.length} stock counts (${stock?.changed ?? 0} changed); ${shopify.requests} Shopify requests`);
  return { shop, products: mapped, levels, catalog, stock, skipped };
}

export async function readLevels({ shopify, productIds }) {
  const asOf = new Date().toISOString();
  const levels = [];
  for (const loc of await shopify.locations()) levels.push(...mapLevels({ levels: await shopify.inventoryLevels(loc.id), productIds, asOf }));
  return levels;
}

/**
 * Watch: read stock every interval and push the counts ReCart has not yet accepted; push every count at least every
 * `refreshEvery` checks so ReCart keeps treating them as fresh. A changed count makes ReCart re-plan open recoveries.
 * The remembered state advances only after ReCart accepts an upload, so a failed upload is retried on the next check.
 */
export function createWatcher({ shopify, recart, productIds, refreshEvery = 10, log = console.log }) {
  const accepted = new Map(); // what ReCart has acknowledged, per product and location
  let checks = 0;
  return async function step() {
    const levels = await readLevels({ shopify, productIds });
    const key = (l) => `${l.product_id}|${l.location_id}`;
    const pending = levels.filter((l) => accepted.get(key(l)) !== l.available);
    const changed = pending.filter((l) => accepted.has(key(l)));
    const send = checks % refreshEvery === 0 ? levels : pending;
    checks++;
    if (!send.length) return { changed: 0, sent: 0 };
    const r = await recart.call("POST", "/v1/inventory/levels", { levels: send });
    for (const l of send) accepted.set(key(l), l.available);
    if (changed.length) log(`stock changed in Shopify: ${changed.map((l) => `${l.product_id.split("/").pop()} → ${l.available}`).join(", ")} (ReCart re-plans open recoveries)`);
    return { changed: changed.length, sent: send.length, result: r };
  };
}

/** The reference order used for the demonstration. It is defined here, not read from Shopify (no order scopes). */
export const DEMO_ORDER = {
  items: [["IF-2C-LB", 1], ["MIC-DX-A", 2], ["CBL-XLR-3", 2], ["HP-CB-A", 2], ["CBL-CC-1", 1], ["STD-DK-A", 2]],
  unavailable: "IF-2C-LB",
  requirements: { local_people: 2, remote_guests: 1, host_port: "usb-c", os: "macos", call_app: "zoom", needed_by: null, timezone: "America/Los_Angeles" },
};

export async function createDemoRecovery({ recart, products, locationIds, currency = "USD", budgetCents = 45000, orderId = `demo-${new Date().toISOString().slice(0, 10)}` }) {
  const bySku = new Map(products.map((p) => [p.sku, p.product_id]));
  const id = (sku) => { const v = bySku.get(sku); if (!v) throw new Error(`SKU ${sku} is not synced`); return v; };
  return recart.call("POST", "/v1/recoveries", {
    external_order_id: orderId, currency,
    requirements: { ...DEMO_ORDER.requirements, budget: { max_total_cents: budgetCents, currency } },
    original_items: DEMO_ORDER.items.map(([sku, quantity]) => ({ product_id: id(sku), quantity })),
    unavailable_items: [{ product_id: id(DEMO_ORDER.unavailable), quantity: 1, reason: "missing_at_packing" }],
    fulfillment: { location_ids: locationIds },
    metadata: { source: "shopify-reference-example", note: "Reference order defined by the example, not a Shopify order" },
  }, { idempotencyKey: `shopify-${orderId}` });
}
