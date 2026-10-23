// Tests for the example's declared capabilities: catalog sync, inventory sync, stock-change watch, recovery requests
// and buyer review links. The ReCart side is a real server (RECART_BASE_URL); Shopify is a local mock.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { mapCatalog, toCents } from "../src/map.mjs";
import { ReCartClient } from "../src/recart.mjs";
import { ShopifyClient } from "../src/shopify.mjs";
import { createDemoRecovery, createWatcher, fullSync } from "../src/sync.mjs";
import { mockShopify } from "./mock-shopify.mjs";

const mapping = JSON.parse(readFileSync(new URL("../mapping.json", import.meta.url), "utf8"));
const PRICES = { "MIC-DX-A": 4900, "MIC-DX-B": 6900, "MIC-CX-C": 5900, "MIC-USB-D": 7900, "IF-2C-LB": 12900, "IF-2C-NL": 9900, "IF-2B-LB": 15900, "IF-4C-LB": 24900, "IF-2C-UK": 11900, "HP-CB-A": 2900, "HP-OB-B": 4500, "CBL-XLR-3": 1200, "CBL-CC-1": 1000, "CBL-BA-1": 1000, "ADP-AC": 1200, "STD-DK-A": 1500, "STD-BM-B": 2500, "SPL-HP-2": 900 };
const STOCK = { "MIC-DX-A": 4, "MIC-DX-B": 3, "MIC-CX-C": 3, "MIC-USB-D": 2, "IF-2C-LB": 1, "IF-2C-NL": 3, "IF-2B-LB": 2, "IF-4C-LB": 1, "IF-2C-UK": 0, "HP-CB-A": 6, "HP-OB-B": 2, "CBL-XLR-3": 10, "CBL-CC-1": 5, "CBL-BA-1": 5, "ADP-AC": 4, "STD-DK-A": 6, "STD-BM-B": 2, "SPL-HP-2": 3 };
const catalog = [...Object.entries(PRICES).map(([sku, price_cents]) => ({ sku, name: `Fixture ${sku}`, price_cents })), { sku: "GIFT-CARD", name: "Gift card", price_cents: 2500, status: "ACTIVE" }];
const BASE = process.env.RECART_BASE_URL ?? "http://127.0.0.1:4060";
const quiet = () => {};

describe("mapping", () => {
  it("converts prices exactly and keeps drafts out of proposals unless explicitly included", () => {
    assert.equal(toCents("129.00"), 12900);
    assert.equal(toCents("9.9"), 990);
    const products = [{ id: "p1", title: "Mic", status: "DRAFT", updatedAt: "2026-10-10T00:00:00Z", variants: [{ id: "v1", title: "Default Title", sku: "MIC-DX-A", price: "49.00" }] }];
    assert.equal(mapCatalog({ products, currency: "USD", mapping }).products[0].status, "draft");
    assert.equal(mapCatalog({ products, currency: "USD", mapping, includeDrafts: true }).products[0].status, "active");
    const unmapped = mapCatalog({ products: [{ ...products[0], variants: [{ ...products[0].variants[0], sku: "UNKNOWN" }] }], currency: "USD", mapping });
    assert.equal(unmapped.products.length, 0);
    assert.equal(unmapped.skipped[0].reason, "no reviewed mapping for this SKU");
  });
});

describe("watcher delivery (in-memory clients)", () => {
  it("keeps a count that failed to upload and resends it on the next check", async () => {
    let available = 1;
    const shopify = { locations: async () => [{ id: "loc-1" }], inventoryLevels: async () => [{ variantId: "v-1", sku: "IF-2C-LB", locationId: "loc-1", available }] };
    const accepted = [];
    let failNext = false;
    const recart = { call: async (_m, _p, body) => { if (failNext) { failNext = false; throw new Error("simulated network failure"); } accepted.push(body.levels.map((l) => l.available)); return { applied: body.levels.length }; } };
    const watch = createWatcher({ shopify, recart, productIds: new Set(["v-1"]), log: quiet });
    assert.deepEqual(await watch(), { changed: 0, sent: 1, result: { applied: 1 } }); // first check sends the baseline
    available = 0;
    failNext = true;
    await assert.rejects(watch(), /simulated network failure/);
    const retry = await watch();
    assert.equal(retry.sent, 1, "the count ReCart never accepted is sent again");
    assert.equal(retry.changed, 1);
    assert.deepEqual(accepted, [[1], [0]]);
    assert.deepEqual(await watch(), { changed: 0, sent: 0 }); // nothing left to send once accepted
  });
});

describe("Shopify store → ReCart (real ReCart server, mock Shopify)", () => {
  let shop; let shopify; let recart; let synced;
  before(async () => {
    shop = mockShopify({ catalog, quantities: STOCK });
    const apiBase = await shop.listen();
    shopify = new ShopifyClient({ shop: "recart-audio-lab.myshopify.com", clientId: "id", clientSecret: "secret", apiBase });
    const r = await fetch(`${BASE}/v1/sandbox/merchants`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Shopify example test", seed: "empty" }) });
    const sandbox = await r.json();
    assert.equal(r.status, 201, JSON.stringify(sandbox));
    recart = new ReCartClient({ baseUrl: BASE, apiKey: sandbox.api_key });
  });
  after(() => shop.server.close());

  it("syncs every mapped variant with its reviewed facts and reports the integration's capabilities", async () => {
    synced = await fullSync({ shopify, recart, mapping, includeDrafts: true, log: quiet });
    assert.equal(synced.products.length, 18);
    assert.deepEqual(synced.skipped.map((s) => s.sku), ["GIFT-CARD"]);
    assert.match(synced.products[0].product_id, /^gid:\/\/shopify\/ProductVariant\//);
    const status = await recart.call("GET", "/v1/merchant/status");
    assert.equal(status.catalog.active, 18);
    assert.equal(status.inventory.fresh_units, 62);
    assert.equal(status.integration.platform, "shopify");
    assert.ok(status.integration.not_supported.includes("Shopify checkout"));
  });

  it("a stock change in Shopify revises the open recovery proposal", async () => {
    const rec = await createDemoRecovery({ recart, products: synced.products, locationIds: ["gid://shopify/Location/86563356766"], orderId: "demo-test-1" });
    assert.equal(rec.proposal.outcome, "no_change_needed"); // Shopify still counts another IF-2C-LB
    const watch = createWatcher({ shopify, recart, productIds: new Set(synced.products.map((p) => p.product_id)), log: quiet });
    await watch();
    shop.state.quantities["IF-2C-LB"] = 0; // the merchant records that the counted unit does not exist
    const step = await watch();
    assert.equal(step.changed, 1);
    const v2 = await waitForVersion(recart, rec.id, 2);
    assert.equal(v2.proposal.outcome, "proposal_ready");
    assert.equal(v2.proposal.replacement.difference_cents, 4536);
    shop.state.quantities["IF-2B-LB"] = 0;
    await watch();
    const v3 = await waitForVersion(recart, rec.id, 3);
    assert.equal(v3.proposal.outcome, "budget_conflict");
    const link = await recart.call("POST", `/v1/recoveries/${rec.id}/review-links`, { expires_in_minutes: 30 });
    assert.match(link.url, /\/review\/rvw_/);
  });

  it("renews an expired Shopify token once and continues", async () => {
    const before = shop.state.tokens;
    shop.state.failNextWith401 = true;
    const info = await shopify.shopInfo();
    assert.equal(info.myshopifyDomain, "recart-audio-lab.myshopify.com");
    assert.equal(shop.state.tokens, before + 1);
  });
});

async function waitForVersion(recart, id, version) {
  for (let i = 0; i < 60; i++) {
    const rec = await recart.call("GET", `/v1/recoveries/${id}`);
    if (rec.proposal.version >= version) return rec;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`proposal v${version} did not appear`);
}
