import { CATALOG, SCENARIOS } from "../../domain/catalog/fixtures.js";
import type { Ctx } from "../context.js";
import { many, maybeOne } from "../db/pool.js";
import { timingFor, type SessionRow } from "./sessions.js";
import { demoStage } from "./stage.js";

/** Read model for the UI. Everything shown to buyers, merchants, and judges is derived from durable server state. */
export async function sessionState(ctx: Ctx, s: SessionRow) {
  const db = ctx.db;
  const intent = await maybeOne<any>(db, "select * from intents where session_id=$1 order by created_at desc limit 1", [s.id]);
  const goal = intent?.current_goal_id ? await maybeOne<any>(db, "select id, version, data, source, confirmed_at from goal_versions where id=$1", [intent.current_goal_id]) : null;
  // request_text: the buyer's own words behind the latest draft, so an unconfirmed draft can be shown again after a reload.
  const extraction = intent ? await maybeOne<any>(db, "select id, status, model, response, request->>'text' as request_text, request->>'provider' as provider, request->>'fallback_from' as fallback_from, usage, duration_ms, error, created_at from language_runs where intent_id=$1 and task='extract_goal' order by created_at desc limit 1", [intent.id]) : null;
  const solve = goal ? await maybeOne<any>(db, "select id, purpose, status, result, created_at from solve_runs where goal_id=$1 order by created_at desc limit 1", [goal.id]) : null;
  const quote = intent?.current_quote_id ? await maybeOne<any>(db, "select id, version, kind, status, data, hash, accept_by, predecessor_id, created_at from quotes where id=$1", [intent.current_quote_id]) : null;
  const original = intent?.original_quote_id ? await maybeOne<any>(db, "select id, version, status, data, hash from quotes where id=$1", [intent.original_quote_id]) : null;
  const checkouts = intent ? await many<any>(db, "select * from checkouts where intent_id=$1 order by created_at", [intent.id]) : [];
  const active = checkouts.find((c) => c.id === intent?.active_checkout_id) ?? checkouts[checkouts.length - 1] ?? null;
  const ops = intent ? await many<any>(db, "select o.id, o.checkout_id, o.kind, o.status, o.provider_ref, o.provider_status, o.http_status, o.debug_id, o.error, o.attempts, o.created_at, o.updated_at from payment_operations o join checkouts c on c.id=o.checkout_id where c.intent_id=$1 order by o.created_at", [intent.id]) : [];
  const tickets = intent ? await many<any>(db, "select * from fulfillment_tickets where intent_id=$1 order by created_at", [intent.id]) : [];
  const rc = intent ? await maybeOne<any>(db, "select * from recovery_cases where intent_id=$1 order by created_at desc limit 1", [intent.id]) : null;
  const caseSolve = rc?.solve_run_id ? await maybeOne<any>(db, "select id, status, result, goal_id, created_at from solve_runs where id=$1", [rc.solve_run_id]) : null;
  const inbox = await many<any>(db, "select id, kind, title, body, link, status, delivered_at, read_at, created_at from notifications where session_id=$1 order by created_at desc", [s.id]);
  const inventory = await many<any>(db, "select sku, on_hand from inventory where session_id=$1 order by sku", [s.id]);
  const reservations = intent ? await many<any>(db, "select sku, qty, status, checkout_id, expires_at from reservations where intent_id=$1 and status in ('RESERVED','COMMITTED','FROZEN') order by sku", [intent.id]) : [];
  const timeline = await many<any>(db, "select actor, action, entity, entity_id, detail, at from audit_events where session_id=$1 order by at desc, id desc limit 80", [s.id]);
  const webhooks = active ? await many<any>(db, "select event_id, event_type, verification, status, received_at from webhook_events where checkout_id = any($1) order by received_at", [checkouts.map((c) => c.id)]) : [];
  const t = timingFor(s);
  const view = {
    serverTime: new Date().toISOString(),
    session: { id: s.id, scenario: s.scenario, scenarioInfo: SCENARIOS[s.scenario], preset: s.preset, timing: t, status: s.status, expiresAt: s.expires_at, buyerTimezone: s.buyer_timezone, merchantName: CATALOG.merchantName },
    intent: intent ? { id: intent.id, status: intent.status, closedReason: intent.closed_reason } : null,
    goal, extraction, solve, quote, originalQuote: original,
    checkout: active ? checkoutView(active) : null,
    attempts: checkouts.map(checkoutView),
    operations: ops, tickets, webhooks,
    recoveryCase: rc ? { id: rc.id, status: rc.status, reason: rc.reason, detail: rc.detail, createdAt: rc.created_at, solve: caseSolve } : null,
    inbox, inventory, reservations, timeline,
    catalog: CATALOG.variants.map((v) => ({ sku: v.sku, name: v.name, role: v.role, priceCents: v.priceCents, blurb: v.blurb, facts: v.facts })),
  };
  return { ...view, stage: demoStage(view) };
}

function checkoutView(c: any) {
  return {
    id: c.id, quoteId: c.quote_id, state: c.payment_state, terminal: c.terminal, paypalOrderId: c.paypal_order_id, authorizationId: c.authorization_id, captureId: c.capture_id, refundId: c.refund_id,
    approvalDeadline: c.approval_deadline, releaseBy: c.release_by, confirmationMinutes: c.confirmation_minutes, cancelIntent: c.cancel_intent, releaseBlocks: c.release_blocks, createdAt: c.created_at, updatedAt: c.updated_at,
  };
}
