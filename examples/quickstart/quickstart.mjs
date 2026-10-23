#!/usr/bin/env node
// ReCart quickstart: a sandbox store, a recovery for an order whose interface went missing, a buyer review link,
// and a stock change that revises the proposal. Node 20+, no dependencies.
//   node quickstart.mjs                       # against https://recart.axiqo.xyz
//   RECART_BASE_URL=http://127.0.0.1:4060 node quickstart.mjs
const BASE = (process.env.RECART_BASE_URL ?? "https://recart.axiqo.xyz").replace(/\/$/, "");

async function call(method, path, key, body, headers = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${json.error?.code}: ${json.error?.message}`);
  return json;
}
const usd = (c) => `$${(c / 100).toFixed(2)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForVersion(key, id, version) {
  for (let i = 0; i < 40; i++) {
    const rec = await call("GET", `/v1/recoveries/${id}`, key);
    if (rec.proposal.version >= version) return rec;
    await sleep(500);
  }
  throw new Error("the proposal was not revised in time");
}
function show(rec) {
  const p = rec.proposal;
  console.log(`  proposal v${p.version}: ${p.outcome} (recovery ${rec.status}; next: ${rec.next_action.actor} → ${rec.next_action.code})`);
  console.log(`  ${p.summary}`);
  for (const c of p.changes) console.log(`    ${c.role}: ${c.before.map((b) => b.name).join(", ") || "—"} → ${c.after.map((a) => a.name).join(", ") || "—"}`);
  if (p.replacement) console.log(`    total ${usd(p.original.totals.total_cents)} → ${usd(p.replacement.totals.total_cents)} (${p.replacement.difference_cents >= 0 ? "+" : ""}${usd(p.replacement.difference_cents)})`);
}

const sandbox = await call("POST", "/v1/sandbox/merchants", null, { name: "Quickstart audio store" });
const key = sandbox.api_key;
console.log(`1. Sandbox merchant ${sandbox.merchant.id}: ${sandbox.seed.products} fictional products, reference order ${sandbox.seed.reference_order.external_order_id}`);

const rec = await call("POST", "/v1/recoveries", key, sandbox.try_next.body, { "Idempotency-Key": `quickstart-${sandbox.merchant.id}` });
console.log(`2. Recovery ${rec.id} for order ${rec.external_order_id}`);
show(rec);

const link = await call("POST", `/v1/recoveries/${rec.id}/review-links`, key, { expires_in_minutes: 60 });
console.log(`3. Buyer review link (only the buyer can approve there): ${link.url}`);

const asOf = new Date().toISOString();
await call("POST", "/v1/inventory/levels", key, { levels: [{ product_id: "IF-2B-LB", location_id: "main", available: 0, as_of: asOf }, { product_id: "IF-4C-LB", location_id: "main", available: 0, as_of: asOf }] });
console.log("4. Stock change: the last loopback interfaces sold out");
show(await waitForVersion(key, rec.id, 2));

await call("POST", "/v1/inventory/levels", key, { levels: [{ product_id: "IF-2B-LB", location_id: "main", available: 2, as_of: new Date().toISOString() }] });
console.log("5. Stock change: two USB-B interfaces restocked");
show(await waitForVersion(key, rec.id, 3));

await sleep(1500);
const events = await call("GET", "/v1/events?limit=50", key);
console.log(`6. Events: ${events.data.map((e) => e.type).join(", ")}`);
const inbox = await call("GET", "/v1/sandbox/inbox?limit=50", key);
console.log(`   Hosted inbox: ${inbox.data.length} signed callbacks, ${inbox.data.filter((m) => m.signature_valid).length} verified`);
