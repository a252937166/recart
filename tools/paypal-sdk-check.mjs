// Runs the checkout button's three PayPal SDK start steps (script, connect, eligibility) in a fresh browser profile on a
// ReCart page, times each, and lists any PayPal request that never answered. No credentials: it uses the public client ID
// from /api/config. Exit code 1 when a step fails or stalls.
// Usage: BASE=https://recart.axiqo.xyz node tools/paypal-sdk-check.mjs
import { launchTemporaryProfile } from "./browser.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:4060";
const STEP_MS = Number(process.env.STEP_MS ?? 20_000);
const ctx = await launchTemporaryProfile("recart-sdk-check", { headless: process.env.HEADLESS !== "0" });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const pending = new Map();
const t0 = Date.now();
const isPayPal = (url) => /(^|\.)paypal(objects)?\.com$/.test(new URL(url).hostname);
page.on("request", (r) => { if (isPayPal(r.url())) pending.set(r, Date.now()); });
page.on("requestfinished", (r) => pending.delete(r));
page.on("requestfailed", (r) => { if (pending.has(r)) { console.log(`request failed: ${r.url().replace(/\?.*/, "")} (${r.failure()?.errorText})`); pending.delete(r); } });
try {
  await page.goto(`${BASE}/developers`, { waitUntil: "domcontentloaded" });
  const steps = await page.evaluate(async (stepMs) => {
    const cfg = await (await fetch("/api/config")).json();
    if (cfg.paypal.mode === "fake") return [{ step: "config", ok: false, detail: "this server runs PAYPAL_MODE=fake" }];
    const out = [];
    const step = async (name, run) => {
      const s = performance.now();
      let timer;
      try {
        const v = await Promise.race([run(), new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`no answer within ${stepMs} ms`), { timeout: true })), stepMs); })]);
        out.push({ step: name, ok: true, ms: Math.round(performance.now() - s) });
        return v;
      } catch (e) {
        out.push({ step: name, ok: false, ms: Math.round(performance.now() - s), detail: `${e?.code ? e.code + " " : ""}${e?.message ?? e}` });
        throw e;
      } finally { clearTimeout(timer); }
    };
    try {
      const paypal = await step("script", () => new Promise((res, rej) => { const s = document.createElement("script"); s.src = cfg.paypal.sdkUrl; s.async = true; s.onload = () => res(window.paypal); s.onerror = () => rej(new Error("script request failed")); document.head.appendChild(s); }));
      const sdk = await step("connect", () => paypal.createInstance({ clientId: cfg.paypal.clientId, components: ["paypal-payments"], pageType: "checkout" }));
      const methods = await step("eligibility", () => sdk.findEligibleMethods({ currencyCode: "USD" }));
      out.push({ step: "paypal eligible", ok: methods.isEligible("paypal") });
    } catch {}
    return out;
  }, STEP_MS);
  const ok = steps.every((s) => s.ok);
  for (const s of steps) console.log(`${s.ok ? "ok    " : "FAILED"} ${s.step}${s.ms != null ? ` ${s.ms} ms` : ""}${s.detail ? ` (${s.detail})` : ""}`);
  // PayPal's logging beacons may still be in flight after a good start; open requests matter only when a step stopped.
  if (!ok) for (const [r, at] of pending) console.log(`no answer after ${Math.round((Date.now() - at) / 1000)} s: ${r.method()} ${r.url().replace(/\?.*/, "")}`);
  console.log(`${BASE}: ${ok ? "PayPal started" : "PayPal did not start"} in ${Math.round((Date.now() - t0) / 1000)} s`);
  if (!ok) process.exitCode = 1;
} finally {
  await ctx.close();
}
