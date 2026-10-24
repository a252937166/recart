// PayPal Sandbox feasibility spike: PP01 (authorize -> capture), PP02 (authorize -> void), PP03 (full refund).
// Uses REST + redirect approval driven by an isolated headless Chrome (temporary profile).
// Credentials are read from ~/.config/recart/paypal-sandbox.env and never printed.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { launchTemporaryProfile } from "./browser.mjs";

const envFile = process.env.RECART_PAYPAL_ENV || path.join(os.homedir(), ".config/recart/paypal-sandbox.env");
const env = Object.fromEntries(readFileSync(envFile, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }));
const API = "https://api-m.sandbox.paypal.com";
const evidenceDir = new URL("../evidence/sandbox/", import.meta.url).pathname;
mkdirSync(evidenceDir, { recursive: true });

let cachedToken = null;
async function token() {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.value;
  const r = await fetch(`${API}/v1/oauth2/token`, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  if (!r.ok) throw new Error("oauth failed " + r.status);
  const j = await r.json(); cachedToken = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 }; return cachedToken.value;
}
async function pp(method, p, body, requestId) {
  const headers = { Authorization: "Bearer " + (await token()), "Content-Type": "application/json", Prefer: "return=representation" };
  if (requestId) headers["PayPal-Request-Id"] = requestId;
  const r = await fetch(API + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, debugId: r.headers.get("paypal-debug-id"), json, text: json ? undefined : text.slice(0, 300) };
}
const usd = (cents) => (cents / 100).toFixed(2);
async function createOrder(label, items, taxCents) {
  const itemTotal = items.reduce((s, it) => s + it.unitCents * it.qty, 0);
  const body = {
    intent: "AUTHORIZE",
    purchase_units: [{
      reference_id: label, description: "ReCart fixture podcast setup (Sandbox)",
      amount: { currency_code: "USD", value: usd(itemTotal + taxCents), breakdown: { item_total: { currency_code: "USD", value: usd(itemTotal) }, tax_total: { currency_code: "USD", value: usd(taxCents) } } },
      items: items.map((it) => ({ name: it.name, sku: it.sku, quantity: String(it.qty), unit_amount: { currency_code: "USD", value: usd(it.unitCents) }, category: "PHYSICAL_GOODS" })),
    }],
    payment_source: { paypal: { experience_context: { brand_name: "ReCart Demo Audio (Sandbox)", shipping_preference: "NO_SHIPPING", user_action: "CONTINUE", return_url: "https://example.com/recart/return", cancel_url: "https://example.com/recart/cancel" } } },
  };
  const r = await pp("POST", "/v2/checkout/orders", body, randomUUID());
  if (r.status !== 200 && r.status !== 201) throw new Error(`create order ${r.status} ${r.debugId} ${JSON.stringify(r.json || r.text)}`);
  const approve = (r.json.links || []).find((l) => l.rel === "payer-action" || l.rel === "approve");
  return { id: r.json.id, status: r.json.status, approveUrl: approve && approve.href, total: body.purchase_units[0].amount.value };
}
async function approveWithBuyer(approveUrl, email, password, shotPrefix) {
  const ctx = await launchTemporaryProfile("recart-spike", { headless: true, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const shot = async (n) => { try { await page.screenshot({ path: path.join(evidenceDir, `${shotPrefix}-${n}.png`) }); } catch {} };
  try {
    await page.goto(approveUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    const clickIf = async (sel, t = 4000) => { const el = page.locator(sel).first(); if (await el.isVisible({ timeout: t }).catch(() => false)) { await el.click(); return true; } return false; };
    await clickIf("#acceptAllButton", 5000);
    const emailBox = page.locator("#email");
    await emailBox.waitFor({ state: "visible", timeout: 45000 });
    await emailBox.fill(email);
    if (await clickIf("#btnNext", 3000)) await page.waitForTimeout(1500);
    const pw = page.locator("#password");
    await pw.waitFor({ state: "visible", timeout: 30000 });
    await pw.fill(password);
    await page.locator("#btnLogin").click();
    await shot("1-after-login");
    // Review page: click the primary submit button.
    const candidates = ["[data-testid=submit-button-initial]", "#payment-submit-btn", "button[data-id=payment-submit-btn]", "button:has-text('Continue to Review Order')", "button:has-text('Complete Purchase')", "button:has-text('Pay Now')", "button:has-text('Continue')", "button:has-text('Agree & Continue')"];
    let clicked = false;
    for (let i = 0; i < 40 && !clicked; i++) {
      if (page.url().startsWith("https://example.com/")) break;
      for (const sel of candidates) { if (await clickIf(sel, 500)) { clicked = true; break; } }
      if (!clicked) await page.waitForTimeout(1000);
    }
    await page.waitForURL(/^https:\/\/example\.com\/recart\/return/, { timeout: 60000 });
    const u = new URL(page.url());
    await shot("2-returned");
    return { returned: true, token: u.searchParams.get("token"), payerId: u.searchParams.get("PayerID") };
  } catch (e) {
    await shot("error");
    return { returned: false, error: e.message.split("\n")[0], url: page.url().split("?")[0] };
  } finally { await ctx.close(); }
}
const fixtureItems = [
  { sku: "MIC-DYN-XLR-A", name: "Dynamic XLR microphone (fixture)", unitCents: 4900, qty: 2 },
  { sku: "IF-2X-USBC-B", name: "2-input USB-C interface (fixture)", unitCents: 12900, qty: 1 },
  { sku: "HP-CLOSED-A", name: "Closed-back headphones (fixture)", unitCents: 2900, qty: 2 },
  { sku: "CBL-XLR-3M", name: "XLR cable 3 m (fixture)", unitCents: 1200, qty: 2 },
  { sku: "CBL-USBC-C", name: "USB-C host cable (fixture)", unitCents: 1000, qty: 1 },
  { sku: "STD-DESK-A", name: "Desk microphone stand (fixture)", unitCents: 1500, qty: 2 },
];
const results = { startedAt: new Date().toISOString(), merchant: env.PP_SANDBOX_MERCHANT_EMAIL, app: env.PAYPAL_APP_NAME };
const save = () => writeFileSync(path.join(evidenceDir, "spike-pp01-pp03.json"), JSON.stringify(results, null, 2));

// PP01: authorize then capture
const o1 = await createOrder("PP01", fixtureItems, 2792);
results.pp01 = { orderId: o1.id, createStatus: o1.status, total: o1.total };
const a1 = await approveWithBuyer(o1.approveUrl, env.PP_SANDBOX_TESTER_EMAIL, env.PP_SANDBOX_TESTER_PASSWORD, "pp01");
results.pp01.approval = { returned: a1.returned, payerIdPresent: !!a1.payerId, error: a1.error, url: a1.url };
save();
if (a1.returned) {
  const auth = await pp("POST", `/v2/checkout/orders/${o1.id}/authorize`, {}, randomUUID());
  const authObj = auth.json?.purchase_units?.[0]?.payments?.authorizations?.[0];
  results.pp01.authorize = { http: auth.status, debugId: auth.debugId, orderStatus: auth.json?.status, authorizationId: authObj?.id, authorizationStatus: authObj?.status, expiration: authObj?.expiration_time, error: auth.json?.details?.[0]?.issue };
  save();
  if (authObj?.id) {
    const capReq = randomUUID();
    const cap = await pp("POST", `/v2/payments/authorizations/${authObj.id}/capture`, { amount: { currency_code: "USD", value: o1.total }, final_capture: true }, capReq);
    results.pp01.capture = { http: cap.status, debugId: cap.debugId, captureId: cap.json?.id, status: cap.json?.status, statusDetails: cap.json?.status_details, error: cap.json?.details?.[0]?.issue };
    // Idempotent replay with the same request id must return the same capture.
    const replay = await pp("POST", `/v2/payments/authorizations/${authObj.id}/capture`, { amount: { currency_code: "USD", value: o1.total }, final_capture: true }, capReq);
    results.pp01.captureReplay = { http: replay.status, sameCaptureId: replay.json?.id === cap.json?.id, status: replay.json?.status };
    const authAfter = await pp("GET", `/v2/payments/authorizations/${authObj.id}`);
    results.pp01.authorizationAfter = { status: authAfter.json?.status };
    save();
    // PP03: full refund of PP01 capture
    if (cap.json?.id) {
      const ref = await pp("POST", `/v2/payments/captures/${cap.json.id}/refund`, {}, randomUUID());
      results.pp03 = { captureId: cap.json.id, http: ref.status, debugId: ref.debugId, refundId: ref.json?.id, status: ref.json?.status, amount: ref.json?.amount, error: ref.json?.details?.[0]?.issue };
      const capAfter = await pp("GET", `/v2/payments/captures/${cap.json.id}`);
      results.pp03.captureAfter = { status: capAfter.json?.status };
      save();
    }
  }
}
// PP02: separate authorization then void
const o2 = await createOrder("PP02", fixtureItems.slice(0, 2), 1408);
results.pp02 = { orderId: o2.id, createStatus: o2.status, total: o2.total };
const a2 = await approveWithBuyer(o2.approveUrl, env.PP_SANDBOX_TESTER_EMAIL, env.PP_SANDBOX_TESTER_PASSWORD, "pp02");
results.pp02.approval = { returned: a2.returned, payerIdPresent: !!a2.payerId, error: a2.error, url: a2.url };
if (a2.returned) {
  const auth = await pp("POST", `/v2/checkout/orders/${o2.id}/authorize`, {}, randomUUID());
  const authObj = auth.json?.purchase_units?.[0]?.payments?.authorizations?.[0];
  results.pp02.authorize = { http: auth.status, authorizationId: authObj?.id, authorizationStatus: authObj?.status };
  if (authObj?.id) {
    const v = await pp("POST", `/v2/payments/authorizations/${authObj.id}/void`, null, randomUUID());
    results.pp02.void = { http: v.status, debugId: v.debugId, status: v.json?.status, error: v.json?.details?.[0]?.issue };
    const after = await pp("GET", `/v2/payments/authorizations/${authObj.id}`);
    results.pp02.authorizationAfter = { status: after.json?.status };
    const capTry = await pp("POST", `/v2/payments/authorizations/${authObj.id}/capture`, { final_capture: true }, randomUUID());
    results.pp02.captureAfterVoid = { http: capTry.status, issue: capTry.json?.details?.[0]?.issue };
  }
}
results.finishedAt = new Date().toISOString();
save();
console.log(JSON.stringify(results, null, 2));
