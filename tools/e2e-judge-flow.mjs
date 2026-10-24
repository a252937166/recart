// End-to-end judge walkthrough (scenarios A, B, C) against a running ReCart server and the real PayPal Sandbox.
// Uses an isolated Chrome profile (never the user's browser). The Sandbox buyer comes from BUYER_EMAIL and BUYER_PASSWORD,
// or from PP_SANDBOX_TESTER_EMAIL and PP_SANDBOX_TESTER_PASSWORD in RECART_PAYPAL_ENV (default ~/.config/recart/paypal-sandbox.env).
// Usage: BASE=http://127.0.0.1:4060 HEADLESS=1 node tools/e2e-judge-flow.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { launchTemporaryProfile } from "./browser.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:4060";
const SCENARIO = process.env.SCENARIO ?? "A";
const envFile = process.env.RECART_PAYPAL_ENV || path.join(os.homedir(), ".config/recart/paypal-sandbox.env");
const env = existsSync(envFile) ? Object.fromEntries(readFileSync(envFile, "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; })) : {};
const buyer = { email: process.env.BUYER_EMAIL ?? env.PP_SANDBOX_TESTER_EMAIL, password: process.env.BUYER_PASSWORD ?? env.PP_SANDBOX_TESTER_PASSWORD };
if (!buyer.email || !buyer.password) throw new Error(`No Sandbox buyer: set BUYER_EMAIL and BUYER_PASSWORD, or add PP_SANDBOX_TESTER_EMAIL and PP_SANDBOX_TESTER_PASSWORD to ${envFile}`);
const outDir = new URL(`../evidence/e2e/${SCENARIO}${process.env.OUT_TAG ? "-" + process.env.OUT_TAG : ""}/`, import.meta.url).pathname;
mkdirSync(outDir, { recursive: true });

const log = [];
const hooks = {};
const step = (msg) => { const line = `${new Date().toISOString()} ${msg}`; log.push(line); console.log(line); };
const ctx = await launchTemporaryProfile("recart-e2e", { headless: process.env.HEADLESS !== "0", viewport: { width: 1440, height: 960 } });
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.setDefaultTimeout(30_000);
const shot = async (name, p = page) => { await p.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true }).catch(() => {}); };

// PayPal opens either a popup window or, when popups are blocked, an in-page overlay (paypal-sdk-iframe-modal).
// Both surfaces expose the same login and review controls, so one routine drives either.
const PAYPAL_CONTROLS = "#email, [data-testid=submit-button-initial], #payment-submit-btn";
async function findPayPal(before, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const popup = ctx.pages().find((p) => !before.has(p) && !p.isClosed());
    if (popup) return { kind: "popup", target: popup };
    for (const f of page.frames()) {
      if (f === page.mainFrame() || !/paypal\.com/.test(f.url())) continue;
      if (await f.locator(PAYPAL_CONTROLS).first().isVisible().catch(() => false)) return { kind: "overlay", target: f };
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function approveInPayPal(trigger) {
  let before = new Set(ctx.pages());
  await trigger();
  let surface = await findPayPal(before, 15_000);
  if (!surface) {
    // The recovery a judge would use. If PayPal's own overlay offers to re-launch its window, use it; otherwise reload
    // (the server keeps the open attempt and its PayPal order) and select PayPal again.
    await shot("paypal-window-missing");
    before = new Set(ctx.pages());
    const relaunch = page.getByRole("button", { name: /Click to Continue/i });
    if (await relaunch.isVisible().catch(() => false)) {
      step("PayPal did not appear; using PayPal's re-launch button");
      await relaunch.click();
    } else {
      step("PayPal did not appear; reloading and selecting PayPal again");
      page.once("dialog", (d) => { step(`dialog (${d.type()}) accepted`); d.accept().catch(() => {}); });
      // Wait for the new document, not the full load event: PayPal's own frames can hold "load" back for a long time.
      const reloaded = page.waitForEvent("domcontentloaded", { timeout: 30_000 });
      await page.getByRole("button", { name: /Reload this page/ }).click({ timeout: 10_000 });
      await reloaded;
      await page.locator("paypal-button").waitFor({ state: "visible", timeout: 45_000 });
      await page.waitForTimeout(1000);
      before = new Set(ctx.pages());
      await page.locator("paypal-button").click();
    }
    surface = await findPayPal(before, 30_000);
    if (!surface) throw new Error("PayPal did not appear after the recovery step");
  }
  const pp = surface.target;
  // The SDK hides its overlay after approval (the frame may stay), so the overlay counts as closed once it is no longer open.
  const isDone = async () => (surface.kind === "popup" ? pp.isClosed() : pp.isDetached() || (await page.locator("paypal-sdk-iframe-modal[open]").count()) === 0);
  step(`PayPal ${surface.kind} opened: ${new URL(pp.url()).host}`);
  if (surface.kind === "popup") await pp.waitForLoadState("domcontentloaded");
  const clickIf = async (sel, t = 3000) => { const el = pp.locator(sel).first(); if (await el.isVisible({ timeout: t }).catch(() => false)) { await el.click(); return true; } return false; };
  await clickIf("#acceptAllButton", 4000);
  // PayPal may remember the Sandbox login in this browser profile; log in only if asked.
  const needsLogin = await pp.locator(PAYPAL_CONTROLS).first().waitFor({ state: "visible", timeout: 45_000 }).then(() => pp.locator("#email").isVisible());
  if (needsLogin) {
    await pp.locator("#email").fill(buyer.email);
    if (await clickIf("#btnNext", 3000)) await page.waitForTimeout(1200);
    await pp.locator("#password").waitFor({ state: "visible", timeout: 30_000 });
    await pp.locator("#password").fill(buyer.password);
    await pp.locator("#btnLogin").click();
    step("PayPal login submitted");
  } else step("PayPal session already signed in");
  const candidates = ["[data-testid=submit-button-initial]", "#payment-submit-btn", "button:has-text('Continue to Review Order')", "button:has-text('Complete Purchase')", "button:has-text('Pay Now')", "button:has-text('Continue')", "button:has-text('Agree & Continue')"];
  for (let i = 0; i < 45 && !(await isDone()); i++) {
    let clicked = false;
    for (const sel of candidates) { if (await clickIf(sel, 400)) { clicked = true; step(`PayPal: clicked ${sel}`); break; } }
    if (clicked) {
      for (let w = 0; w < 40 && !(await isDone()); w++) await page.waitForTimeout(500);
      break;
    }
    await page.waitForTimeout(1000);
  }
  if (!(await isDone())) { await shot("paypal-stuck", surface.kind === "popup" ? pp : page); throw new Error(`PayPal ${surface.kind} did not close after approval`); }
  step(`PayPal ${surface.kind} closed (approved)`);
}

try {
  step(`open ${BASE}`);
  // The release this run exercises, recorded so the evidence page can say which build each run covered.
  const releaseOf = () => fetch(`${BASE}/api/health`).then((r) => r.json()).then((h) => h.release ?? null).catch(() => null);
  const release = await releaseOf();
  step(`release ${release}`);
  await page.goto(BASE);
  await page.waitForTimeout(2500);
  await shot("01-landing");
  // The home page's call to action leads to the story chooser (the judge's entry point).
  await page.getByRole("link", { name: "Start guided demo" }).first().click();
  const story = { A: "Recovered", B: "Buyer decides", C: "No safe replacement" }[SCENARIO];
  await page.getByRole("radio", { name: new RegExp(story) }).click();
  await shot("01b-story");
  await page.getByRole("button", { name: `Start the ${story} story` }).click();
  await page.waitForURL(/\/demo$/);
  // The session id is the value of the demo cookie (the state view does not repeat it); the workspace creates the
  // session after it mounts, so wait for the cookie to appear.
  let sessionId = null;
  for (let i = 0; i < 40 && !sessionId; i++) { sessionId = (await ctx.cookies(BASE)).find((c) => c.name === "recart_sid")?.value ?? null; if (!sessionId) await page.waitForTimeout(500); }
  step(`demo session ${sessionId}`);
  if (process.env.ON_SESSION_CMD && !sessionId) throw new Error("no demo session cookie: cannot scope the fault");
  // ON_SESSION_CMD runs once the session exists, with {session} replaced: used to scope a simulated language fault to this run.
  if (process.env.ON_SESSION_CMD) {
    const cmd = process.env.ON_SESSION_CMD.replaceAll("{session}", sessionId);
    const r = execFileSync("sh", ["-c", cmd], { encoding: "utf8" });
    step(`ON_SESSION_CMD: ${r.trim().split("\n").pop()}`);
    hooks.sessionFault = process.env.SESSION_FAULT_NOTE ?? "scoped language fault set by ON_SESSION_CMD";
  }
  await page.getByRole("button", { name: "Read my request" }).waitFor();
  await shot("02-workspace-empty");
  await page.getByRole("button", { name: "Read my request" }).click();
  await page.locator(".pill", { hasText: /AI draft|Rules draft/ }).waitFor({ timeout: 120_000 });
  step("extraction shown: " + (await page.locator(".pill", { hasText: /AI draft|Rules draft/ }).innerText()));
  const ext = await page.evaluate(async () => (await fetch("/api/state").then((r) => r.json())).state?.extraction ?? null);
  if (ext) { hooks.extraction = { status: ext.status, model: ext.model, provider: ext.provider ?? null, fallbackFrom: ext.fallback_from ?? null, durationMs: ext.duration_ms }; step(`draft by ${ext.provider ?? "rules"} (${ext.model ?? "-"}) in ${ext.duration_ms} ms`); }
  await page.locator("#os").selectOption("macos");
  if (await page.locator("#app").isVisible()) await page.locator("#app").selectOption("zoom");
  if (!(await page.locator("#dt").inputValue())) {
    const d = new Date(Date.now() + 3 * 86400_000);
    await page.locator("#dt").fill(d.toISOString().slice(0, 10));
  }
  await page.locator("#tm").fill("10:00");
  await shot("03-goal-filled");
  await page.getByRole("button", { name: "Confirm requirements" }).click();
  await page.getByRole("heading", { name: "Checked setups" }).waitFor();
  await shot("04-checked-setups");
  await page.getByRole("button", { name: /Choose this setup/ }).click();
  await page.getByRole("button", { name: /Accept quote/ }).click();
  await page.locator("paypal-button").waitFor({ state: "visible", timeout: 45_000 });
  await page.waitForTimeout(1500);
  await shot("05-quote-accepted-paypal");
  if (process.env.BLOCK_FIRST_POPUP === "1") {
    // Simulates a popup blocker for the first PayPal window only, to exercise "Reopen it".
    await page.evaluate(() => { const original = window.open; window.open = function () { window.open = original; return null; }; });
    step("first PayPal window will be blocked");
  }
  await approveInPayPal(() => page.locator("paypal-button").click());
  await page.getByText("Payment authorized: a Sandbox hold").waitFor({ timeout: 45_000 });
  step("attempt 1 authorized");
  await shot("06-authorized");

  // The stage guide offers the role switch; following it is what a first-time judge does.
  await page.getByRole("link", { name: "Go to the Store view" }).click();
  await page.getByRole("heading", { name: "Readiness check" }).waitFor();
  await shot("07-store-readiness");
  await page.getByRole("button", { name: "Report 2-in USB-C Interface with Loopback missing" }).click();
  await page.getByText(/hold voided|Waiting for PayPal/).first().waitFor({ timeout: 45_000 });
  step("discrepancy reported");
  await page.waitForTimeout(2500);
  await shot("08-store-after-report");

  await page.getByRole("link", { name: /^Messages/ }).click();
  await page.getByRole("link", { name: "Open recovery case" }).first().click();
  await page.waitForURL(/\/case\//);
  await page.getByRole("heading", { name: /Your setup needs a change|Recovered purchase|Purchase closed/ }).waitFor();
  await page.waitForTimeout(1500);
  await shot("09-recovery-case");
  const recovery = { scenario: SCENARIO, release, ...hooks, ...(process.env.BLOCK_FIRST_POPUP === "1" ? { popupBlocked: true } : {}) };
  const finishRecovery = async () => {
    await page.getByRole("button", { name: "Review this rebuilt setup" }).click();
    await page.getByRole("button", { name: /Accept quote/ }).click();
    await page.locator("paypal-button").waitFor({ state: "visible", timeout: 45_000 });
    await page.waitForTimeout(1500);
    await shot("10-replacement-accepted");
    await approveInPayPal(() => page.locator("paypal-button").click());
    await page.getByText("Payment authorized: a Sandbox hold").waitFor({ timeout: 45_000 });
    step("attempt 2 authorized");
    await page.getByRole("link", { name: "Go to the Store view" }).click();
    if (process.env.DROP_NEXT_CAPTURE === "1") {
      // PP04 (local server with PAYPAL_FAULT_INJECTION=1 only): PayPal performs the capture, but ReCart never sees the reply.
      const armed = await page.evaluate(async () => {
        const st = await fetch("/api/state").then((r) => r.json());
        const r = await fetch("/api/dev/drop-next", { method: "POST", headers: { "content-type": "application/json", "x-recart-csrf": st.csrf }, body: JSON.stringify({ op: "captureAuthorization" }) });
        return r.status === 200;
      });
      if (!armed) throw new Error("fault injection is not available on this server");
      step("armed: next capture response will be discarded");
      recovery.faultInjected = "captureAuthorization response discarded";
    }
    await page.getByRole("button", { name: "Confirm exact goods are here" }).click();
    if (process.env.DROP_NEXT_CAPTURE === "1") { await page.waitForTimeout(700); await shot("11a-capture-response-lost"); }
    await page.getByRole("button", { name: "Mark handed over" }).waitFor({ timeout: 60_000 });
    await shot("11-store-captured");
    await page.getByRole("button", { name: "Mark handed over" }).click();
    await page.getByText("Handed over. The purchase is complete.").waitFor();
    step("handed over");
    await page.getByRole("link", { name: /^Buyer view/ }).click();
    await page.waitForTimeout(1500);
    await shot("12-buyer-final");
  };
  if (SCENARIO === "A") {
    await finishRecovery();
  } else if (SCENARIO === "C") {
    await page.getByRole("button", { name: "Close purchase" }).click();
    await page.getByText("Purchase closed with an explanation saved").waitFor({ timeout: 30_000 });
    await shot("10-closed");
  } else {
    // Scenario B: the only complete fix costs more than the $400 limit. ReCart stops; the buyer raises the limit.
    await page.getByRole("heading", { name: "Decision needed" }).waitFor({ timeout: 30_000 });
    await shot("10-decision-needed");
    step("decision needed: " + (await page.locator(".notice", { hasText: "No complete setup fits" }).innerText()));
    await page.getByRole("button", { name: "Change my requirements" }).click();
    await page.locator("#bud").fill("425");
    await shot("10b-budget-raised");
    await page.getByRole("button", { name: "Confirm requirements" }).click();
    await page.getByRole("button", { name: "Review this rebuilt setup" }).waitFor({ timeout: 30_000 });
    step("budget raised to $425; rebuilt setup offered");
    await finishRecovery();
  }
  const releaseAtEnd = await releaseOf();
  if (releaseAtEnd !== release) recovery.releaseAtEnd = releaseAtEnd;
  await page.goto(BASE + "/evidence");
  await page.waitForTimeout(1500);
  await shot("13-evidence");
  // The explanation is a background job: wait for the model's text (or the settled template) and record how long it took.
  const explainWait = Number(process.env.EXPLAIN_WAIT_MS ?? 150_000);
  const tExp = Date.now();
  let explanation = null;
  let gaps = 0;
  while (Date.now() - tExp < explainWait) {
    // A server restart while waiting (the restart check does one) makes a poll fail for a moment; keep polling.
    const rc = await page.evaluate(async () => { const r = await fetch("/api/state"); if (!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.json()).state?.recoveryCase ?? null; }).catch((e) => { gaps++; step(`state poll failed (${String(e?.message ?? e).slice(0, 60)}); retrying`); return undefined; });
    if (rc === undefined) { await page.waitForTimeout(2000); continue; }
    explanation = rc?.detail?.explanation ?? rc?.explanation ?? null;
    if (!explanation || explanation.pending === false) break;
    await page.waitForTimeout(2000);
  }
  if (gaps) recovery.statePollGaps = gaps;
  if (explanation) { recovery.explanation = { source: explanation.source, model: explanation.model, pending: explanation.pending, error: explanation.error ?? null, waitedMs: Date.now() - tExp }; step(`explanation ${explanation.pending ? "still pending" : explanation.source + " (" + (explanation.model ?? "template") + ")"} after ${Date.now() - tExp} ms of waiting at the end`); }
  const state = await page.evaluate(async () => (await fetch("/api/state").then((r) => r.json())).state);
  recovery.attempts = state.attempts.map((a) => ({ state: a.state, order: a.paypalOrderId, authorization: a.authorizationId, capture: a.captureId, refund: a.refundId }));
  recovery.caseStatus = state.recoveryCase?.status;
  writeFileSync(path.join(outDir, "result.json"), JSON.stringify({ ok: true, at: new Date().toISOString(), base: BASE, ...recovery, log }, null, 2));
  step("DONE " + JSON.stringify(recovery));
} catch (e) {
  step("FAILED: " + (e?.message ?? e));
  await shot("zz-failure");
  writeFileSync(path.join(outDir, "result.json"), JSON.stringify({ ok: false, error: String(e?.message ?? e), log }, null, 2));
  process.exitCode = 1;
} finally {
  await ctx.close();
}
