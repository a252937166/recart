#!/usr/bin/env node
// ReCart Shopify reference sync (read-only). See README.md for setup, supported capabilities and limits.
//   node --env-file=shopify.env cli.mjs sync --include-drafts
//   node --env-file=shopify.env cli.mjs watch --include-drafts --interval 15
//   node --env-file=shopify.env cli.mjs demo-order
//   node --env-file=shopify.env cli.mjs status
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { ReCartClient } from "./src/recart.mjs";
import { ShopifyClient } from "./src/shopify.mjs";
import { createDemoRecovery, createWatcher, fullSync } from "./src/sync.mjs";

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  "include-drafts": { type: "boolean", default: false }, interval: { type: "string", default: "15" }, budget: { type: "string", default: "45000" }, "order-id": { type: "string" },
} });
const command = positionals[0] ?? "help";
const env = process.env;

function shopifyConfig() {
  let file = {};
  if (env.SHOPIFY_CREDENTIALS_FILE) file = JSON.parse(readFileSync(env.SHOPIFY_CREDENTIALS_FILE, "utf8"));
  const shop = env.SHOPIFY_SHOP ?? file.shop;
  const clientId = env.SHOPIFY_CLIENT_ID ?? file.client_id;
  const clientSecret = env.SHOPIFY_CLIENT_SECRET ?? file.client_secret;
  if (!shop || !clientId || !clientSecret) throw new Error("Set SHOPIFY_SHOP, SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (or SHOPIFY_CREDENTIALS_FILE)");
  return { shop: shop.includes(".") ? shop : `${shop}.myshopify.com`, clientId, clientSecret, ...(env.SHOPIFY_API_BASE ? { apiBase: env.SHOPIFY_API_BASE } : {}) };
}
function recartClient() {
  if (!env.RECART_API_KEY) throw new Error("Set RECART_API_KEY (a key with catalog:write, recoveries:write and settings:write)");
  return new ReCartClient({ baseUrl: env.RECART_BASE_URL ?? "https://recart.axiqo.xyz", apiKey: env.RECART_API_KEY });
}
const mapping = () => JSON.parse(readFileSync(env.MAPPING_FILE ?? new URL("./mapping.json", import.meta.url), "utf8"));

async function main() {
  if (command === "status") return console.log(JSON.stringify(await recartClient().call("GET", "/v1/merchant/status"), null, 2));
  if (!["sync", "watch", "demo-order"].includes(command)) {
    console.log("usage: cli.mjs sync|watch|demo-order|status [--include-drafts] [--interval seconds] [--budget cents] [--order-id id]");
    return;
  }
  const shopify = new ShopifyClient(shopifyConfig());
  const recart = recartClient();
  const synced = await fullSync({ shopify, recart, mapping: mapping(), includeDrafts: values["include-drafts"] });
  if (command === "demo-order") {
    const locations = [...new Set(synced.levels.map((l) => l.location_id))];
    const rec = await createDemoRecovery({ recart, products: synced.products, locationIds: locations, currency: synced.shop.currencyCode, budgetCents: Number(values.budget), ...(values["order-id"] ? { orderId: values["order-id"] } : {}) });
    const link = await recart.call("POST", `/v1/recoveries/${rec.id}/review-links`, { expires_in_minutes: 1440 }, { idempotencyKey: `shopify-link-${rec.id}-${rec.proposal.version}` });
    console.log(`recovery ${rec.id} (${rec.external_order_id}): proposal v${rec.proposal.version} ${rec.proposal.outcome}\n${rec.proposal.summary}\nbuyer review link: ${link.url}`);
    return;
  }
  if (command === "watch") {
    let step = createWatcher({ shopify, recart, productIds: new Set(synced.products.map((p) => p.product_id)) });
    await step();
    const seconds = Math.max(5, Number(values.interval));
    // A full catalog sync (prices, titles, status) runs about hourly; stock is read every interval.
    const fullEvery = Math.max(1, Math.round(3600 / seconds));
    console.log(`watching Shopify stock every ${seconds} s, full catalog sync every ${fullEvery} checks (Ctrl+C to stop)`);
    for (let tick = 1; ; tick++) {
      await new Promise((r) => setTimeout(r, seconds * 1000));
      try {
        if (tick % fullEvery === 0) {
          const again = await fullSync({ shopify, recart, mapping: mapping(), includeDrafts: values["include-drafts"] });
          step = createWatcher({ shopify, recart, productIds: new Set(again.products.map((p) => p.product_id)) });
          await step();
        } else await step();
      } catch (e) { console.error(`watch step failed: ${e.message}`); }
    }
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
