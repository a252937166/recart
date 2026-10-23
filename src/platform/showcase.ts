import { BASE_STOCK } from "../domain/catalog/fixtures.js";
import type { ProductRow, StockRow } from "./catalog.js";
import type { MerchantRow } from "./merchants.js";
import { fixtureProducts } from "./pack.js";
import { planRecovery, type PlanInput } from "./planning.js";
import { REFERENCE_ORDER_ITEMS, referenceRecoveryRequest } from "./sandbox.js";

/**
 * The homepage's interactive preview, computed by the real planner over the fictional fixture store (nothing is
 * stored): the reference order loses its interface, under three store situations.
 */
export function showcasePreview(now: Date) {
  const merchant: MerchantRow = {
    id: "mch_showcase", name: "ReCart Audio (fictional store)", kind: "sandbox", domain: "audio-recording-v1", currency: "USD", tax_rate_bps: 800,
    inventory_max_age_seconds: 86400, proposal_ttl_seconds: 86400, webhook_url: null, webhook_secret: null, catalog_version: 1,
    integration: null, integration_reported_at: null, created_at: now, expires_at: null, disabled_at: null,
  };
  const products = new Map<string, ProductRow>(fixtureProducts().map((p) => [p.product_id, { ...p, merchant_id: merchant.id, source_updated_at: now, updated_at: now }]));
  const stockFor = (overrides: Record<string, number>) => new Map<string, StockRow>(Object.keys(BASE_STOCK).map((id) => {
    const allocated = REFERENCE_ORDER_ITEMS.find((i) => i.product_id === id)?.quantity ?? 0;
    return [id, { fresh: overrides[id] ?? Math.max(0, BASE_STOCK[id]! - allocated), stale: 0, newestAsOf: now, locations: 1 }];
  }));
  const input = (budgetCents: number): PlanInput => {
    const req = referenceRecoveryRequest(budgetCents);
    return {
      currency: "USD", requirements: req.requirements as PlanInput["requirements"], shipping_cents: 0, fulfillment: req.fulfillment,
      unavailable_items: [{ product_id: "IF-2C-LB", quantity: 1, reason: "missing_at_packing" }],
      original_items: REFERENCE_ORDER_ITEMS.map((i) => ({ ...i, unit_price_cents: products.get(i.product_id)!.price_cents, held_quantity: i.product_id === "IF-2C-LB" ? 0 : i.quantity })),
    };
  };
  const run = (id: string, title: string, budgetCents: number, overrides: Record<string, number>) => ({ id, title, budget_cents: budgetCents, proposal: planRecovery(input(budgetCents), { merchant, products, stock: stockFor(overrides), now }).body });
  return {
    store: merchant.name, fictional: true,
    requirements: referenceRecoveryRequest(45000).requirements,
    catalog: [...products.values()].map((p) => ({ product_id: p.product_id, name: p.name, role: p.role, price_cents: p.price_cents, attributes: p.attributes })),
    situations: [
      run("recovered", "Another complete setup is in stock", 45000, {}),
      run("needs_buyer", "Only a pricier complete setup exists", 40000, {}),
      run("no_safe_replacement", "No complete setup is possible", 45000, { "IF-2B-LB": 0, "IF-4C-LB": 0 }),
    ],
  };
}
