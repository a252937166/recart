// PP03 re-check after the merchant float: pay, capture, then fully refund a fresh Sandbox order and record whether the
// refund completes immediately (it was PENDING / ECHECK while the new merchant had no balance). Sandbox money only.
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { launchTemporaryProfile } from "./browser.mjs";
const env = Object.fromEntries(readFileSync(path.join(os.homedir(), ".config/recart/paypal-sandbox.env"), "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }));
const API = "https://api-m.sandbox.paypal.com";
const tok = (await (await fetch(`${API}/v1/oauth2/token`, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" })).json()).access_token;
const pp = async (m, p, b) => { const r = await fetch(API + p, { method: m, headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Prefer: "return=representation", "PayPal-Request-Id": randomUUID() }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const amount = process.argv[2] ?? "12.34";
const order = await pp("POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [{ description: "ReCart refund re-check (Sandbox only)", amount: { currency_code: "USD", value: amount } }], payment_source: { paypal: { experience_context: { brand_name: "ReCart Demo Audio (Sandbox)", shipping_preference: "NO_SHIPPING", user_action: "PAY_NOW", return_url: "https://example.com/recart/return", cancel_url: "https://example.com/recart/cancel" } } } });
const approve = order.json.links.find((l) => l.rel === "payer-action").href;
const ctx = await launchTemporaryProfile("recart-refund", { headless: true });
const page = ctx.pages()[0];
await page.goto(approve);
const vis = (s, t) => page.locator(s).first().isVisible({ timeout: t }).catch(() => false);
if (await vis("#acceptAllButton", 4000)) await page.locator("#acceptAllButton").click();
await page.locator("#email").waitFor({ timeout: 45000 });
await page.locator("#email").fill(env.PP_SANDBOX_TESTER_EMAIL);
if (await vis("#btnNext", 3000)) { await page.locator("#btnNext").click(); await page.waitForTimeout(1200); }
await page.locator("#password").fill(env.PP_SANDBOX_TESTER_PASSWORD);
await page.locator("#btnLogin").click();
for (let i = 0; i < 40 && !page.url().startsWith("https://example.com/"); i++) {
  for (const s of ["[data-testid=submit-button-initial]", "#payment-submit-btn", "button:has-text('Pay Now')", "button:has-text('Complete Purchase')"]) if (await vis(s, 400)) { await page.locator(s).first().click(); break; }
  await page.waitForTimeout(1000);
}
await page.waitForURL(/example\.com\/recart\/return/, { timeout: 60000 });
await ctx.close();
const cap = await pp("POST", `/v2/checkout/orders/${order.json.id}/capture`, {});
const c = cap.json?.purchase_units?.[0]?.payments?.captures?.[0];
const refund = await pp("POST", `/v2/payments/captures/${c.id}/refund`, {});
let r = refund.json;
for (let i = 0; i < 10 && r?.status === "PENDING"; i++) { await new Promise((s) => setTimeout(s, 3000)); r = (await pp("GET", `/v2/payments/refunds/${r.id}`)).json; }
const capAfter = (await pp("GET", `/v2/payments/captures/${c.id}`)).json;
const out = { test: "PP03 full refund after merchant float", at: new Date().toISOString(), orderId: order.json.id, captureId: c.id, captureStatus: c.status, amount,
  refund: { httpStatus: refund.status, id: r?.id, status: r?.status, statusDetails: r?.status_details ?? null, amount: r?.amount }, captureStatusAfter: capAfter?.status };
writeFileSync(new URL("../evidence/sandbox/pp03-refund-after-float.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
