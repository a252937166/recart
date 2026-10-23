// Shopify data -> ReCart standard format. All Shopify-specific knowledge lives here, outside ReCart.

/** "129.00" -> 12900 without floating point. */
export function toCents(price) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(price).trim());
  if (!m) throw new Error(`unexpected price ${price}`);
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

const variantName = (p, v) => (!v.title || v.title === "Default Title" ? p.title : `${p.title} — ${v.title}`);

/**
 * Products: identity is the variant GID (stable across SKU edits); the SKU selects the reviewed compatibility facts in
 * mapping.json. Draft products are sent as `draft` (never proposed) unless includeDrafts is set explicitly.
 */
export function mapCatalog({ products, currency, mapping, includeDrafts = false }) {
  const out = [];
  const skipped = [];
  for (const p of products) for (const v of p.variants) {
    const m = v.sku ? mapping.products[v.sku] : undefined;
    if (!m) { skipped.push({ variant_id: v.id, sku: v.sku ?? null, reason: "no reviewed mapping for this SKU" }); continue; }
    const status = p.status === "ACTIVE" ? "active" : p.status === "DRAFT" ? (includeDrafts ? "active" : "draft") : "archived";
    out.push({
      product_id: v.id, sku: v.sku, name: variantName(p, v), role: m.role, description: m.description ?? null,
      price_cents: toCents(v.price), currency, status, source_updated_at: p.updatedAt, attributes: m.attributes,
    });
  }
  return { products: out, skipped };
}

/** Stock counts for mapped variants. `as_of` is the moment the count was read from Shopify. */
export function mapLevels({ levels, productIds, asOf }) {
  return levels.filter((l) => productIds.has(l.variantId)).map((l) => ({ product_id: l.variantId, location_id: l.locationId, available: Math.max(0, l.available), as_of: asOf }));
}
