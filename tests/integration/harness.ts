import { referenceGoal, SCENARIOS, type ScenarioId } from "../../src/domain/catalog/fixtures.js";
import { installClock, TestClock } from "../../src/server/clock.js";
import { loadConfig } from "../../src/server/config.js";
import { SessionEvents, type Ctx } from "../../src/server/context.js";
import { migrate } from "../../src/server/db/migrations.js";
import { createPool, one, withTx, type Db } from "../../src/server/db/pool.js";
import { runOneJob } from "../../src/server/jobs/worker.js";
import { LanguageService } from "../../src/server/language/adapter.js";
import { LostResponseInjector } from "../../src/server/paypal/client.js";
import { FakePayPal } from "../../src/server/paypal/fake.js";
import { confirmGoal } from "../../src/server/services/goals.js";
import { authorizeAfterApproval, startCheckout, type CheckoutRow } from "../../src/server/services/payments.js";
import { acceptQuote } from "../../src/server/services/quotes.js";
import { selectCandidate } from "../../src/server/services/recovery.js";
import { createSession, loadSession, type SessionRow } from "../../src/server/services/sessions.js";
import { runSolve } from "../../src/server/services/solving.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://recart:recart-dev@127.0.0.1:5434/recart_test";
export const START = new Date("2026-10-12T17:00:00Z"); // Monday 10:00 PDT
export const FRIDAY_10AM_PT = "2026-10-16T17:00:00Z";

export interface Harness { db: Db; fake: FakePayPal; paypal: LostResponseInjector; ctx: Ctx; clock: TestClock }

export async function setup(): Promise<Harness> {
  const db = createPool(TEST_DB, 6);
  await db.query("drop schema if exists public cascade; create schema public;");
  await migrate(db);
  const fake = new FakePayPal();
  const paypal = new LostResponseInjector(fake);
  const cfg = loadConfig({ ...process.env, DATABASE_URL: TEST_DB, PAYPAL_MODE: "fake", TIMING_PRESET: "test", LANGUAGE_URL: "", LANGUAGE_TOKEN: "" });
  const ctx: Ctx = { db, paypal, cfg, events: new SessionEvents(), language: new LanguageService(db, {}) };
  const clock = new TestClock(START);
  installClock(clock);
  return { db, fake, paypal, ctx, clock };
}

/** Run every due job on both lanes (as the two runners would), without waiting for wall time. */
export async function drain(h: Harness, max = 300) {
  for (let i = 0; i < max; i++) if (!(await runOneJob(h.ctx, "test-worker", "core")) && !(await runOneJob(h.ctx, "test-worker", "language"))) return i;
  throw new Error("job queue did not drain");
}

export async function freshSession(h: Harness, scenario: ScenarioId = "A") {
  const s = await createSession(h.ctx, { scenario, preset: "test", buyerTimezone: "America/Los_Angeles" });
  const session = (await loadSession(h.db, s.id)) as SessionRow;
  return { session, intentId: s.intentId };
}

export async function confirmReferenceGoal(h: Harness, session: SessionRow, intentId: string, overrides: Record<string, unknown> = {}) {
  const goal = { ...referenceGoal(FRIDAY_10AM_PT), budgetCents: SCENARIOS[session.scenario].budgetCents, ...overrides } as any;
  await withTx(h.db, (tx) => confirmGoal(tx, { sessionId: session.id, intentId, goal, source: "test" }));
}

export async function acceptedQuote(h: Harness, session: SessionRow, intentId: string, index = 0) {
  const run = await runSolve(h.db, { sessionId: session.id, intentId, purpose: "initial" });
  const quote = await selectCandidate(h.ctx, session, { solveRunId: run.id, index });
  await acceptQuote(h.db, { session, quoteId: quote.id, displayedHash: quote.hash });
  return quote;
}

/**
 * Reach AUTHORIZED for scenario A's reference bundle through the same service calls the HTTP routes use. A test on the
 * real clock passes a pickup deadline in the real future; the default belongs to the controlled clock's week.
 */
export async function authorizedPurchase(h: Harness, scenario: ScenarioId = "A", pickupBy: string = FRIDAY_10AM_PT) {
  const { session, intentId } = await freshSession(h, scenario);
  await confirmReferenceGoal(h, session, intentId, { pickupBy });
  const quote = await acceptedQuote(h, session, intentId);
  const co = await startCheckout(h.ctx, session, quote.id);
  h.fake.approve(co.orderId!);
  const c = await authorizeAfterApproval(h.ctx, session, co.checkoutId, co.orderId!);
  return { session, intentId, quote, checkoutId: co.checkoutId, orderId: co.orderId!, checkout: c };
}

export const checkout = (h: Harness, id: string) => one<CheckoutRow>(h.db, "select * from checkouts where id=$1", [id]);
export const opsOf = (h: Harness, id: string) => h.db.query("select kind, status, provider_ref, provider_status, request_id from payment_operations where checkout_id=$1 order by created_at", [id]).then((r) => r.rows);
