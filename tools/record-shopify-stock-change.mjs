// Records how a real Shopify stock change revises an open ReCart recovery proposal (evidence for the Shopify example).
// Polls the recovery and the synced stock count until two revisions are seen or the time limit passes.
//   RECART_BASE_URL=... RECART_API_KEY=... RECOVERY_ID=rec_... SKU=IF-2C-LB node tools/record-shopify-stock-change.mjs
import { writeFileSync } from "node:fs";
const BASE = process.env.RECART_BASE_URL ?? "https://recart.axiqo.xyz";
const KEY = process.env.RECART_API_KEY;
const ID = process.env.RECOVERY_ID;
const SKU = process.env.SKU ?? "IF-2C-LB";
const OUT = process.env.OUT ?? new URL(`../evidence/shopify/stock-change-${new Date().toISOString().slice(0, 10)}.json`, import.meta.url).pathname;
const LIMIT_MS = Number(process.env.LIMIT_MINUTES ?? 180) * 60_000;
const get = async (p) => { const r = await fetch(BASE + p, { headers: { authorization: `Bearer ${KEY}` } }); if (!r.ok) throw new Error(`${p} -> ${r.status}`); return r.json(); };
const products = (await get("/v1/catalog/products?limit=500")).data;
const product = products.find((p) => p.sku === SKU);
const record = { purpose: "A stock change made in Shopify admin reaches ReCart through the read-only Shopify reference sync and revises the open recovery proposal.", base: BASE, recovery_id: ID, watched_product: { sku: SKU, product_id: product.product_id, name: product.name }, started_at: new Date().toISOString(), versions: [] };
let last = 0;
const started = Date.now();
while (Date.now() - started < LIMIT_MS) {
  const rec = await get(`/v1/recoveries/${ID}`);
  const p = rec.proposal;
  if (p.version !== last) {
    const levels = (await get(`/v1/inventory/levels?product_id=${encodeURIComponent(product.product_id)}`)).data;
    const r = p.replacement;
    record.versions.push({
      observed_at: new Date().toISOString(), version: p.version, outcome: p.outcome, recovery_status: rec.status, proposal_created_at: p.created_at,
      watched_stock: levels.map((l) => ({ location_id: l.location_id, available: l.available, as_of: l.as_of })),
      total_cents: r?.totals?.total_cents ?? null, difference_cents: r?.difference_cents ?? null,
      added: r ? r.items.filter((i) => i.change !== "kept").map((i) => i.name) : [], removed: r ? r.removed_items.map((i) => i.name) : [], summary: p.summary,
    });
    last = p.version;
    writeFileSync(OUT, JSON.stringify(record, null, 2));
    console.log(`v${p.version} ${p.outcome} (stock ${levels.map((l) => l.available).join(",")})`);
    if (record.versions.length >= 3) break;
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
const events = await get("/v1/events?limit=100");
record.events = events.data.filter((e) => e.data?.recovery_id === ID || e.type === "inventory.updated").map((e) => ({ id: e.id, type: e.type, created_at: e.created_at, reason: e.data?.reason ?? null, version: e.data?.proposal?.version ?? null }));
record.finished_at = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(record, null, 2));
console.log(`recorded ${record.versions.length} version(s) to ${OUT}`);
