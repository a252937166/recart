// PP04 evidence: after a local run with PAYPAL_FAULT_INJECTION=1 and DROP_NEXT_CAPTURE=1, read ReCart's own records and
// PayPal's view of the same order. Proves the discarded capture reply was recovered with no second capture, and (since the
// readiness-review fix) that handoff consumed exactly the purchased goods.
// Usage: DATABASE_URL=... npx tsx tools/pp04-evidence.mts <paypal-order-id>
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { SCENARIOS } from "../src/domain/catalog/fixtures.js";

const orderId = process.argv[2];
if (!orderId) throw new Error("usage: pp04-evidence.mts <paypal-order-id>");
const env = Object.fromEntries(readFileSync(path.join(os.homedir(), ".config/recart/paypal-sandbox.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }));
const API = "https://api-m.sandbox.paypal.com";
const tok = (await (await fetch(`${API}/v1/oauth2/token`, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" })).json()).access_token;
const get = async (p: string) => (await fetch(API + p, { headers: { Authorization: `Bearer ${tok}` } })).json();

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const checkout = (await db.query("select c.id, c.intent_id, c.payment_state, c.authorization_id, c.capture_id, i.session_id, s.scenario from checkouts c join intents i on i.id=c.intent_id join demo_sessions s on s.id=i.session_id where c.paypal_order_id=$1", [orderId])).rows[0];
if (!checkout) throw new Error("no checkout for that order in this database");
const ops = (await db.query("select kind, status, request_id, attempts, http_status, provider_ref, provider_status, error, created_at, updated_at from payment_operations where checkout_id=$1 order by created_at", [checkout.id])).rows;
const audit = (await db.query("select at, actor, action, detail from audit_events where intent_id=$1 and (action like 'capture.%' or action like 'checkout.%' or action like 'handoff.%' or entity='payment_operation') order by at", [checkout.intent_id])).rows;
const reservations = (await db.query("select sku, qty, status from reservations where checkout_id=$1 order by sku", [checkout.id])).rows;
const stock = Object.fromEntries((await db.query("select sku, on_hand from inventory where session_id=$1", [checkout.session_id])).rows.map((r) => [r.sku, r.on_hand]));
const ticket = (await db.query("select state from fulfillment_tickets where checkout_id=$1", [checkout.id])).rows[0]?.state ?? null;
await db.end();

const initial = SCENARIOS[checkout.scenario as "A" | "B" | "C"].inventory;
const consumption = reservations.map((r) => ({ sku: r.sku, purchased: r.qty, initial: initial[r.sku] ?? 0, onHandNow: stock[r.sku], consumed: (initial[r.sku] ?? 0) - stock[r.sku] }));
const order = await get(`/v2/checkout/orders/${orderId}`);
const auth = await get(`/v2/payments/authorizations/${checkout.authorization_id}`);
const captures = order.purchase_units?.[0]?.payments?.captures ?? [];
const out = {
  test: "PP04 capture response lost after PayPal executed it",
  at: new Date().toISOString(),
  method: "Local ReCart server against the real PayPal Sandbox with PAYPAL_FAULT_INJECTION=1. The capture request reached PayPal; its reply was discarded before ReCart saw it. The run then completed handoff.",
  recart: { checkout: { id: checkout.id, payment_state: checkout.payment_state, authorization_id: checkout.authorization_id, capture_id: checkout.capture_id }, operations: ops, audit, reservations, ticket, consumption },
  paypal: { orderId, orderStatus: order.status, authorization: { id: auth.id, status: auth.status }, captures: captures.map((c: any) => ({ id: c.id, status: c.status, amount: c.amount })) },
  result: {
    captureCountAtPayPal: captures.length,
    recartCaptureMatchesPayPal: captures.length === 1 && captures[0].id === checkout.capture_id,
    finalPaymentState: checkout.payment_state,
    ticket,
    reservationsFulfilled: reservations.length > 0 && reservations.every((r) => r.status === "FULFILLED"),
    stockConsumedMatchesPurchase: consumption.every((c) => c.consumed === c.purchased),
  },
};
writeFileSync(new URL("../evidence/sandbox/pp04-lost-capture.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ops: ops.map((o) => `${o.kind}:${o.status}:attempts=${o.attempts}`), ...out.result, consumption }, null, 1));
