import { createHash, randomUUID } from "node:crypto";
import { revalidateLines } from "../../domain/solver/solver.js";
import { fromPayPalValue, toPayPalValue } from "../../domain/money.js";
import { clock } from "../clock.js";
import { AppError, audit, enqueueJob, type Ctx } from "../context.js";
import { many, maybeOne, one, withTx, type Queryable, type Tx } from "../db/pool.js";
import type { PayPalResponse } from "../paypal/types.js";
import { currentGoal } from "./goals.js";
import { availabilityFor, reserveBundle, retainForIntent, setCheckoutReservations } from "./inventory.js";
import { queueNotification } from "./notifications.js";
import type { QuoteRow } from "./quotes.js";
import { assertSessionActive, timingFor, type SessionRow } from "./sessions.js";

/** Internal application payment states (spec §11), not PayPal enum values. */
export type PaymentState =
  | "READY_FOR_APPROVAL" | "AUTHORIZATION_IN_FLIGHT" | "AUTHORIZED" | "CAPTURE_IN_FLIGHT" | "PAID"
  | "VOID_IN_FLIGHT" | "VOIDED" | "REFUND_IN_FLIGHT" | "REFUNDED" | "STATUS_UNKNOWN" | "CLOSED_NO_PAYMENT" | "REVIEW_REQUIRED";
export const TERMINAL: PaymentState[] = ["VOIDED", "REFUNDED", "CLOSED_NO_PAYMENT"];
export type OpKind = "CREATE_ORDER" | "AUTHORIZE" | "CAPTURE" | "VOID" | "REFUND";
export type CancelIntent = "BUYER" | "INVALID_ORIGINAL" | "TIMEOUT" | "APPROVAL_EXPIRED" | "SESSION_CLOSED";

export interface CheckoutRow {
  id: string; intent_id: string; quote_id: string; payment_state: PaymentState; paypal_order_id: string | null; authorization_id: string | null;
  capture_id: string | null; refund_id: string | null; approval_deadline: Date; release_by: Date | null; confirmation_minutes: number;
  release_blocks: { type: string; detail?: unknown; at: string }[]; cancel_intent: CancelIntent | null; terminal: boolean; created_at: Date; updated_at: Date;
}
export interface OpRow { id: string; checkout_id: string; kind: OpKind; request_id: string; payload: any; payload_hash: string; status: "PENDING" | "IN_FLIGHT" | "SUCCEEDED" | "FAILED" | "UNKNOWN"; provider_ref: string | null; provider_status: string | null; http_status: number | null; attempts: number; updated_at: Date }

const STALE_IN_FLIGHT_MS = 60_000;
const issueOf = (r: PayPalResponse) => (r.body?.details?.[0]?.issue as string | undefined) ?? (r.body?.name as string | undefined) ?? r.networkError ?? `HTTP ${r.status}`;

async function sessionOfCheckout(q: Queryable, checkoutId: string) {
  return one<{ session_id: string; intent_id: string }>(q, "select i.session_id, i.id intent_id from checkouts c join intents i on i.id=c.intent_id where c.id=$1", [checkoutId]);
}

async function lockCheckout(tx: Tx, checkoutId: string): Promise<CheckoutRow> {
  const c = await maybeOne<CheckoutRow>(tx, "select * from checkouts where id=$1 for update", [checkoutId]);
  if (!c) throw new AppError(404, "checkout_not_found", "Checkout not found");
  return c;
}

async function setState(tx: Tx, c: CheckoutRow, state: PaymentState, extra: Partial<Record<string, unknown>> = {}) {
  const terminal = TERMINAL.includes(state);
  const sets = ["payment_state=$2", "terminal=$3", "updated_at=$4"];
  const vals: unknown[] = [c.id, state, terminal || c.terminal, clock.now()];
  for (const [k, v] of Object.entries(extra)) { vals.push(k === "release_blocks" ? JSON.stringify(v) : v); sets.push(`${k}=$${vals.length}`); }
  await tx.query(`update checkouts set ${sets.join(",")} where id=$1`, vals);
  c.payment_state = state;
  if (terminal) c.terminal = true;
}

async function addOperation(tx: Tx, checkoutId: string, kind: OpKind, payload: unknown): Promise<OpRow> {
  const id = randomUUID();
  const requestId = randomUUID();
  const payloadHash = createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
  try {
    await tx.query("insert into payment_operations(id,checkout_id,kind,request_id,payload_hash,payload,status,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,'PENDING',$7,$7)", [id, checkoutId, kind, requestId, payloadHash, JSON.stringify(payload ?? null), clock.now()]);
  } catch (e: any) {
    if (e?.code === "23505") throw new AppError(409, "operation_exists", `A ${kind} operation already exists for this checkout.`);
    throw e;
  }
  await enqueueJob(tx, "run_operation", { opId: id }, clock.now(), `op:${id}`);
  return one<OpRow>(tx, "select * from payment_operations where id=$1", [id]);
}

async function liveOp(q: Queryable, checkoutId: string, kind: OpKind): Promise<OpRow | null> {
  return maybeOne<OpRow>(q, "select * from payment_operations where checkout_id=$1 and kind=$2 and status in ('PENDING','IN_FLIGHT','SUCCEEDED','UNKNOWN') order by created_at desc limit 1", [checkoutId, kind]);
}

function orderBody(quote: QuoteRow, returnBase: string) {
  const d = quote.data;
  return {
    intent: "AUTHORIZE",
    purchase_units: [{
      reference_id: quote.id, custom_id: quote.hash.slice(0, 64), description: `ReCart fixture setup v${quote.version} (Sandbox demo)`,
      amount: { currency_code: "USD", value: toPayPalValue(d.totalCents), breakdown: { item_total: { currency_code: "USD", value: toPayPalValue(d.subtotalCents) }, tax_total: { currency_code: "USD", value: toPayPalValue(d.taxCents) } } },
      items: d.lines.map((l) => ({ name: `${l.name} (fixture)`.slice(0, 127), sku: l.sku, quantity: String(l.qty), unit_amount: { currency_code: "USD", value: toPayPalValue(l.unitCents) }, category: "PHYSICAL_GOODS" })),
    }],
    payment_source: { paypal: { experience_context: { brand_name: "ReCart Demo Audio (Sandbox)", shipping_preference: "NO_SHIPPING", user_action: "CONTINUE", return_url: `${returnBase}/paypal/return`, cancel_url: `${returnBase}/paypal/cancel` } } },
  };
}

/** Start checkout for an accepted quote: revalidate, reserve the full bundle, persist the attempt, then create the AUTHORIZE order. */
export async function startCheckout(ctx: Ctx, session: SessionRow, quoteId: string): Promise<{ checkoutId: string; orderId: string | null; state: PaymentState }> {
  assertSessionActive(session);
  const t = timingFor(session);
  const result = await withTx(ctx.db, async (tx) => {
    const quote = await maybeOne<QuoteRow & { session_id: string; current_quote_id: string }>(tx, "select q.*, i.session_id, i.current_quote_id from quotes q join intents i on i.id=q.intent_id where q.id=$1", [quoteId]);
    if (!quote || quote.session_id !== session.id) throw new AppError(404, "quote_not_found", "Quote not found in this demo session.");
    await tx.query("select id from intents where id=$1 for update", [quote.intent_id]);
    const open = await maybeOne<CheckoutRow>(tx, "select * from checkouts where intent_id=$1 and not terminal", [quote.intent_id]);
    if (open) {
      if (open.quote_id === quote.id && open.payment_state === "READY_FOR_APPROVAL") return { reuse: open };
      throw new AppError(409, "prior_payment_unresolved", "A previous payment for this purchase is still being resolved. New checkout stays blocked until it reaches a final state.", { state: open.payment_state });
    }
    if (quote.status !== "ACCEPTED" || quote.current_quote_id !== quote.id) throw new AppError(409, "quote_not_accepted", "Accept the current quote before checkout.");
    const consent = await maybeOne(tx, "select 1 from consents where quote_id=$1 and quote_hash=$2", [quote.id, quote.hash]);
    if (!consent) throw new AppError(409, "no_consent", "No consent recorded for this exact quote.");
    if (clock.now().getTime() > quote.accept_by.getTime()) throw new AppError(409, "quote_expired", "The acceptance window ended before checkout started. Refresh the quote.");
    // Authoritative revalidation against current facts and the quote's committed pickup slot.
    const goal = await currentGoal(tx, quote.intent_id);
    if (!goal || goal.id !== quote.goal_id) throw new AppError(409, "goal_changed", "Your requirements changed after this quote. Review a new quote.");
    const avail = await availabilityFor(tx, session.id, quote.intent_id);
    const check = revalidateLines(goal.data, quote.data.recipe.id, quote.data.lines, avail, quote.data.pickup);
    if (!check.ok || check.totalCents !== quote.total_cents) {
      // Commit the supersession, then report it (throwing here would roll the update back).
      await tx.query("update quotes set status='SUPERSEDED', reason='revalidation failed at checkout' where id=$1", [quote.id]);
      return { invalid: check.checks.filter((c) => c.outcome !== "pass").map((c) => c.id) };
    }
    const checkoutId = randomUUID();
    const now = clock.now();
    const approvalDeadline = new Date(now.getTime() + t.approvalMinutes * 60_000);
    await tx.query("insert into checkouts(id,intent_id,quote_id,payment_state,approval_deadline,confirmation_minutes,created_at,updated_at) values ($1,$2,$3,'READY_FOR_APPROVAL',$4,$5,$6,$6)", [checkoutId, quote.intent_id, quote.id, approvalDeadline, t.confirmationMinutes, now]);
    await reserveBundle(tx, { sessionId: session.id, intentId: quote.intent_id, checkoutId, lines: quote.data.lines, expiresAt: approvalDeadline });
    await tx.query("update intents set active_checkout_id=$2, updated_at=$3 where id=$1", [quote.intent_id, checkoutId, now]);
    const op = await addOperation(tx, checkoutId, "CREATE_ORDER", orderBody(quote, ctx.cfg.PUBLIC_BASE_URL));
    await enqueueJob(tx, "approval_deadline", { checkoutId }, approvalDeadline, `approval:${checkoutId}`);
    await audit(tx, { sessionId: session.id, intentId: quote.intent_id, actor: "buyer", action: "checkout.started", entity: "checkout", entityId: checkoutId, detail: { quote: quote.id, total: quote.total_cents, approvalDeadline } });
    return { checkoutId, opId: op.id };
  });
  if ("invalid" in result) { ctx.events.changed(session.id, "quote.invalidated"); throw new AppError(409, "quote_invalid", "Something in this setup changed since you accepted it. ReCart will show current terms.", { failed: result.invalid }); }
  if ("reuse" in result) return { checkoutId: result.reuse!.id, orderId: result.reuse!.paypal_order_id, state: result.reuse!.payment_state };
  await runOperation(ctx, result.opId);
  const c = await one<CheckoutRow>(ctx.db, "select * from checkouts where id=$1", [result.checkoutId]);
  ctx.events.changed(session.id, "checkout.started");
  return { checkoutId: c.id, orderId: c.paypal_order_id, state: c.payment_state };
}

/** Buyer approved in PayPal: verify binding server-side, then authorize. Browser-supplied IDs are lookup hints only. */
export async function authorizeAfterApproval(ctx: Ctx, session: SessionRow, checkoutId: string, orderId: string): Promise<CheckoutRow> {
  const opId = await withTx(ctx.db, async (tx) => {
    const c = await lockCheckout(tx, checkoutId);
    const owner = await sessionOfCheckout(tx, checkoutId);
    if (owner.session_id !== session.id) throw new AppError(404, "checkout_not_found", "Checkout not found in this demo session.");
    if (!c.paypal_order_id || c.paypal_order_id !== orderId) throw new AppError(409, "order_mismatch", "That PayPal order is not bound to this checkout.");
    if (["AUTHORIZED", "AUTHORIZATION_IN_FLIGHT", "CAPTURE_IN_FLIGHT", "PAID"].includes(c.payment_state)) return null; // duplicate callback
    if (session.status !== "ACTIVE") throw new AppError(409, "session_closing", "This demo session was closed; the approval was not authorized.");
    if (c.terminal || c.payment_state !== "READY_FOR_APPROVAL") throw new AppError(409, "checkout_closed", "This checkout is no longer open, so the approval was not used. No payment was authorized.");
    if (c.release_blocks.length || c.cancel_intent) throw new AppError(409, "checkout_blocked", "The setup changed during approval. No payment was authorized.");
    if (clock.now().getTime() > c.approval_deadline.getTime()) {
      await setState(tx, c, "CLOSED_NO_PAYMENT", { cancel_intent: "APPROVAL_EXPIRED" });
      await finishAttempt(tx, c, owner.session_id);
      return "expired" as const;
    }
    const q = await one<{ status: string; current_quote_id: string }>(tx, "select q.status, i.current_quote_id from quotes q join intents i on i.id=q.intent_id where q.id=$1", [c.quote_id]);
    if (q.status !== "ACCEPTED" || q.current_quote_id !== c.quote_id) throw new AppError(409, "quote_superseded", "This approval belongs to a superseded quote. No payment was authorized.");
    await setState(tx, c, "AUTHORIZATION_IN_FLIGHT");
    const op = await addOperation(tx, c.id, "AUTHORIZE", { orderId: c.paypal_order_id });
    await audit(tx, { sessionId: session.id, intentId: c.intent_id, actor: "buyer", action: "paypal.approved", entity: "checkout", entityId: c.id, detail: { orderId } });
    return op.id;
  });
  if (opId === "expired") { ctx.events.changed(session.id, "approval.expired"); throw new AppError(409, "approval_expired", "The PayPal approval arrived after the checkout window closed. No payment was authorized."); }
  if (opId) await runOperation(ctx, opId);
  ctx.events.changed(session.id, "checkout.authorized");
  return one<CheckoutRow>(ctx.db, "select * from checkouts where id=$1", [checkoutId]);
}

/** Merchant confirms the exact goods are allocated for the promised pickup; then the guarded capture runs. */
export async function merchantConfirm(ctx: Ctx, session: SessionRow, checkoutId: string): Promise<CheckoutRow> {
  assertSessionActive(session);
  const opId = await withTx(ctx.db, async (tx) => {
    const c = await lockCheckout(tx, checkoutId);
    const owner = await sessionOfCheckout(tx, checkoutId);
    if (owner.session_id !== session.id) throw new AppError(404, "checkout_not_found", "Checkout not found");
    if (c.payment_state === "CAPTURE_IN_FLIGHT" || c.payment_state === "PAID") return null;
    if (c.payment_state !== "AUTHORIZED") throw new AppError(409, "not_authorized", `Capture needs an authorized payment (current state ${c.payment_state}).`);
    if (c.cancel_intent || c.release_blocks.length) throw new AppError(409, "release_blocked", "A cancellation or discrepancy blocks capture.");
    if (!c.release_by || clock.now().getTime() >= c.release_by.getTime()) throw new AppError(409, "release_deadline_passed", "The confirmation deadline passed; the authorization will be voided.");
    const quote = await one<QuoteRow>(tx, "select * from quotes where id=$1", [c.quote_id]);
    const held = await many<{ sku: string; qty: number }>(tx, "select sku, sum(qty)::int qty from reservations where checkout_id=$1 and status='RESERVED' group by sku", [c.id]);
    const ok = quote.data.lines.every((l) => held.find((h) => h.sku === l.sku)?.qty === l.qty);
    if (!ok) throw new AppError(409, "allocation_incomplete", "The reserved goods no longer match the accepted quote.");
    const stock = await many<{ sku: string; on_hand: number }>(tx, "select sku, on_hand from inventory where session_id=$1 and sku = any($2) for update", [session.id, quote.data.lines.map((l) => l.sku)]);
    for (const l of quote.data.lines) if ((stock.find((s) => s.sku === l.sku)?.on_hand ?? 0) < l.qty) throw new AppError(409, "stock_discrepancy", `${l.sku} is not physically available; report the discrepancy instead.`);
    await setCheckoutReservations(tx, c.id, "COMMITTED");
    await setState(tx, c, "CAPTURE_IN_FLIGHT");
    const op = await addOperation(tx, c.id, "CAPTURE", { authorizationId: c.authorization_id, amount: { currency_code: "USD", value: toPayPalValue(quote.total_cents) }, final_capture: true });
    await audit(tx, { sessionId: session.id, intentId: c.intent_id, actor: "merchant(simulated)", action: "readiness.confirmed", entity: "checkout", entityId: c.id });
    return op.id;
  });
  if (opId) await runOperation(ctx, opId);
  ctx.events.changed(session.id, "merchant.confirmed");
  return one<CheckoutRow>(ctx.db, "select * from checkouts where id=$1", [checkoutId]);
}

/** Record a cancellation intent; the coordinator then chooses void or refund only after reconciliation. */
export async function requestCancellation(ctx: Ctx, checkoutId: string, reason: CancelIntent, block?: { type: string; detail?: unknown }) {
  await withTx(ctx.db, async (tx) => {
    const c = await lockCheckout(tx, checkoutId);
    const blocks = block ? [...c.release_blocks, { ...block, at: clock.now().toISOString() }] : c.release_blocks;
    await tx.query("update checkouts set cancel_intent=coalesce(cancel_intent,$2), release_blocks=$3, updated_at=$4 where id=$1", [c.id, reason, JSON.stringify(blocks), clock.now()]);
    const owner = await sessionOfCheckout(tx, c.id);
    await audit(tx, { sessionId: owner.session_id, intentId: c.intent_id, actor: reason === "BUYER" ? "buyer" : "system", action: "cancellation.requested", entity: "checkout", entityId: c.id, detail: { reason, block } });
  });
  await drive(ctx, checkoutId);
}

/**
 * Decide the next safe financial step from durable state. Idempotent; safe to call from requests, jobs and webhooks.
 * - READY_FOR_APPROVAL + cancel: close without money (no hold exists yet).
 * - AUTHORIZED + cancel: void. PAID + cancel (not handed over): full refund.
 * - In-flight/unknown states: reconcile first; never start a conflicting operation.
 */
export async function drive(ctx: Ctx, checkoutId: string): Promise<void> {
  const next = await withTx(ctx.db, async (tx) => {
    const c = await lockCheckout(tx, checkoutId);
    const owner = await sessionOfCheckout(tx, c.id);
    if (c.payment_state === "READY_FOR_APPROVAL" && c.cancel_intent) {
      const inflight = await liveOp(tx, c.id, "AUTHORIZE");
      if (inflight && inflight.status !== "SUCCEEDED") return null;
      await setState(tx, c, "CLOSED_NO_PAYMENT");
      await finishAttempt(tx, c, owner.session_id);
      return null;
    }
    if (c.payment_state === "AUTHORIZED" && c.cancel_intent) {
      const v = await liveOp(tx, c.id, "VOID");
      if (v) return v.status === "SUCCEEDED" ? null : v.id;
      await setState(tx, c, "VOID_IN_FLIGHT");
      return (await addOperation(tx, c.id, "VOID", { authorizationId: c.authorization_id })).id;
    }
    if (c.payment_state === "PAID" && c.cancel_intent) {
      const ticket = await maybeOne<{ state: string }>(tx, "select state from fulfillment_tickets where checkout_id=$1", [c.id]);
      if (ticket?.state === "HANDED_OVER") return null; // physical return obligations need merchant review
      await tx.query("update fulfillment_tickets set state='BLOCKED', updated_at=$2 where checkout_id=$1 and state in ('NOT_RELEASED','READY_FOR_HANDOFF','BLOCKED')", [c.id, clock.now()]);
      const r = await liveOp(tx, c.id, "REFUND");
      if (r) return r.status === "SUCCEEDED" ? null : r.id;
      await setState(tx, c, "REFUND_IN_FLIGHT");
      return (await addOperation(tx, c.id, "REFUND", { captureId: c.capture_id })).id;
    }
    const unresolved = await maybeOne(tx, "select id from payment_operations where checkout_id=$1 and status in ('PENDING','IN_FLIGHT','UNKNOWN') limit 1", [c.id]);
    if (unresolved) await enqueueJob(tx, "reconcile_checkout", { checkoutId: c.id }, new Date(clock.now().getTime() + 3000), `reconcile:${c.id}`);
    return null;
  });
  if (next) await runOperation(ctx, next);
}

/** Claim and execute one persisted operation with its original request identity and payload. */
export async function runOperation(ctx: Ctx, opId: string): Promise<void> {
  const claimed = await maybeOne<OpRow>(ctx.db, `update payment_operations set status='IN_FLIGHT', attempts=attempts+1, updated_at=$2
     where id=$1 and (status in ('PENDING','UNKNOWN') or (status='IN_FLIGHT' and updated_at < $3)) returning *`, [opId, clock.now(), new Date(clock.now().getTime() - STALE_IN_FLIGHT_MS)]);
  if (!claimed) return;
  const c = await one<CheckoutRow>(ctx.db, "select * from checkouts where id=$1", [claimed.checkout_id]);
  let r: PayPalResponse;
  switch (claimed.kind) {
    case "CREATE_ORDER": r = await ctx.paypal.createOrder(claimed.payload, claimed.request_id); break;
    case "AUTHORIZE": r = await ctx.paypal.authorizeOrder(claimed.payload.orderId, claimed.request_id); break;
    case "CAPTURE": r = await ctx.paypal.captureAuthorization(claimed.payload.authorizationId, { amount: claimed.payload.amount, final_capture: true }, claimed.request_id); break;
    case "VOID": r = await ctx.paypal.voidAuthorization(claimed.payload.authorizationId, claimed.request_id); break;
    case "REFUND": r = await ctx.paypal.refundCapture(claimed.payload.captureId, {}, claimed.request_id); break;
  }
  await applyResponse(ctx, claimed, c, r);
}

async function recordOp(tx: Tx, op: OpRow, status: OpRow["status"], r: PayPalResponse, providerRef?: string | null, providerStatus?: string | null, error?: string | null) {
  await tx.query("update payment_operations set status=$2, http_status=$3, debug_id=$4, provider_ref=coalesce($5,provider_ref), provider_status=coalesce($6,provider_status), error=$7, updated_at=$8 where id=$1", [op.id, status, r.status, r.debugId, providerRef ?? null, providerStatus ?? null, error ?? null, clock.now()]);
}

function definiteFailure(r: PayPalResponse) { return r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429; }

/** Apply a provider response to durable state. Unknown outcomes never become failures just to unblock a screen. */
async function applyResponse(ctx: Ctx, op: OpRow, _before: CheckoutRow, r: PayPalResponse) {
  const owner = await sessionOfCheckout(ctx.db, op.checkout_id);
  const after = await withTx(ctx.db, async (tx) => {
    const c = await lockCheckout(tx, op.checkout_id);
    const fresh = await one<OpRow>(tx, "select * from payment_operations where id=$1 for update", [op.id]);
    if (fresh.status === "SUCCEEDED" || fresh.status === "FAILED") return c.payment_state;
    const ambiguous = r.status === 0 || r.status >= 500 || r.status === 408 || r.status === 429;
    if (ambiguous) {
      await recordOp(tx, fresh, "UNKNOWN", r, null, null, issueOf(r));
      if (op.kind === "CAPTURE") await setCheckoutReservations(tx, c.id, "FROZEN");
      if (op.kind !== "CREATE_ORDER") await setState(tx, c, "STATUS_UNKNOWN");
      await enqueueJob(tx, "reconcile_checkout", { checkoutId: c.id }, new Date(clock.now().getTime() + 2000), `reconcile:${c.id}`);
      await audit(tx, { sessionId: owner.session_id, intentId: c.intent_id, actor: "paypal", action: `${op.kind.toLowerCase()}.unknown`, entity: "payment_operation", entityId: op.id, detail: { reason: issueOf(r) } });
      return c.payment_state;
    }
    switch (op.kind) {
      case "CREATE_ORDER": {
        if (r.status === 200 || r.status === 201) {
          await recordOp(tx, fresh, "SUCCEEDED", r, r.body.id, r.body.status);
          await tx.query("update checkouts set paypal_order_id=$2, updated_at=$3 where id=$1", [c.id, r.body.id, clock.now()]);
        } else {
          await recordOp(tx, fresh, "FAILED", r, null, null, issueOf(r));
          await setState(tx, c, "CLOSED_NO_PAYMENT");
          await finishAttempt(tx, c, owner.session_id);
        }
        break;
      }
      case "AUTHORIZE": {
        if (r.status === 200 || r.status === 201) {
          const auth = r.body?.purchase_units?.[0]?.payments?.authorizations?.[0];
          await recordOp(tx, fresh, "SUCCEEDED", r, auth?.id, auth?.status);
          await onAuthorized(ctx, tx, c, auth, owner.session_id);
        } else if (definiteFailure(r)) {
          await recordOp(tx, fresh, "FAILED", r, null, null, issueOf(r));
          await setState(tx, c, "CLOSED_NO_PAYMENT");
          await finishAttempt(tx, c, owner.session_id);
        }
        break;
      }
      case "CAPTURE": {
        if (r.status === 200 || r.status === 201) {
          await recordOp(tx, fresh, "SUCCEEDED", r, r.body.id, r.body.status);
          await onCaptured(ctx, tx, c, r.body, owner.session_id);
        } else if (definiteFailure(r)) {
          await recordOp(tx, fresh, "FAILED", r, null, null, issueOf(r));
          await setState(tx, c, "REVIEW_REQUIRED");
          await setCheckoutReservations(tx, c.id, "FROZEN");
        }
        break;
      }
      case "VOID": {
        if (r.status === 200 || r.status === 201 || r.status === 204 || issueOf(r) === "AUTHORIZATION_ALREADY_VOIDED") {
          await recordOp(tx, fresh, "SUCCEEDED", r, c.authorization_id, "VOIDED");
          await setState(tx, c, "VOIDED");
          await finishAttempt(tx, c, owner.session_id);
        } else if (issueOf(r) === "PREVIOUSLY_CAPTURED" || issueOf(r) === "AUTHORIZATION_ALREADY_CAPTURED") {
          await recordOp(tx, fresh, "FAILED", r, null, null, issueOf(r));
          // A capture reached PayPal that our ledger marked not-sent: reopen it so the same request ID returns that capture, then refund.
          await tx.query("update payment_operations set status='UNKNOWN', updated_at=$2 where id=(select id from payment_operations where checkout_id=$1 and kind='CAPTURE' order by created_at desc limit 1)", [c.id, clock.now()]);
          await setCheckoutReservations(tx, c.id, "FROZEN");
          await setState(tx, c, "STATUS_UNKNOWN");
          await enqueueJob(tx, "reconcile_checkout", { checkoutId: c.id }, clock.now(), `reconcile:${c.id}`);
        } else if (definiteFailure(r)) {
          await recordOp(tx, fresh, "FAILED", r, null, null, issueOf(r));
          await setState(tx, c, "REVIEW_REQUIRED");
        }
        break;
      }
      case "REFUND": {
        if (r.status === 200 || r.status === 201) {
          await recordOp(tx, fresh, "SUCCEEDED", r, r.body.id, r.body.status);
          await tx.query("update checkouts set refund_id=$2, updated_at=$3 where id=$1", [c.id, r.body.id, clock.now()]);
          if (r.body.status === "COMPLETED") { await setState(tx, c, "REFUNDED"); await finishAttempt(tx, c, owner.session_id); }
          else await enqueueJob(tx, "reconcile_checkout", { checkoutId: c.id }, new Date(clock.now().getTime() + 30_000), `reconcile:${c.id}`);
        } else if (definiteFailure(r)) {
          await recordOp(tx, fresh, "FAILED", r, null, null, issueOf(r));
          await setState(tx, c, "REVIEW_REQUIRED");
        }
        break;
      }
    }
    await audit(tx, { sessionId: owner.session_id, intentId: c.intent_id, actor: "paypal", action: `${op.kind.toLowerCase()}.response`, entity: "payment_operation", entityId: op.id, detail: { http: r.status, debugId: r.debugId, state: c.payment_state } });
    return c.payment_state;
  });
  ctx.events.changed(owner.session_id, `payment.${op.kind.toLowerCase()}`);
  if (after === "AUTHORIZED" || after === "PAID") await drive(ctx, op.checkout_id);
}

async function onAuthorized(ctx: Ctx, tx: Tx, c: CheckoutRow, auth: any, sessionId: string) {
  const now = clock.now();
  const confirmBy = new Date(now.getTime() + c.confirmation_minutes * 60_000);
  const authExpiry = auth?.expiration_time ? new Date(auth.expiration_time) : null;
  const releaseBy = authExpiry && authExpiry < confirmBy ? authExpiry : confirmBy;
  await setState(tx, c, "AUTHORIZED", { authorization_id: auth?.id ?? null, release_by: releaseBy });
  await setCheckoutReservations(tx, c.id, "RESERVED", releaseBy);
  await enqueueJob(tx, "release_deadline", { checkoutId: c.id }, releaseBy, `release:${c.id}`);
  if (!c.cancel_intent) await queueNotification(tx, { sessionId, kind: "merchant.readiness_needed", title: "Store: confirm the reserved goods", body: `A Sandbox payment hold exists. Confirm the exact goods within ${c.confirmation_minutes} minutes or the hold is voided automatically.`, link: "/store" });
}

async function onCaptured(ctx: Ctx, tx: Tx, c: CheckoutRow, capture: any, sessionId: string) {
  // A capture resource now exists, so goods frozen during an unknown result go back to their committed disposition.
  await setCheckoutReservations(tx, c.id, "COMMITTED");
  if (capture?.status === "COMPLETED") {
    await settlementDeadlineGuard(tx, c);
    await setState(tx, c, "PAID", { capture_id: capture.id });
    await fulfillmentGate(tx, c, sessionId);
  } else {
    // PENDING or other non-final capture: real capture resource, but no fulfillment and no success message yet.
    await tx.query("update checkouts set capture_id=$2, updated_at=$3 where id=$1", [c.id, capture?.id ?? null, clock.now()]);
    await setState(tx, c, "CAPTURE_IN_FLIGHT");
    await enqueueJob(tx, "reconcile_checkout", { checkoutId: c.id }, new Date(clock.now().getTime() + 20_000), `reconcile:${c.id}`);
  }
}

/**
 * Settlement deadline (spec v1.2.1 §11): a capture still unresolved at release_by carries a timeout cancellation, and a
 * later confirmed capture is fully refunded with handoff blocked. Checked here, in the transaction that records the
 * completion, so the outcome never depends on whether the deadline job ran first. A capture confirmed before
 * release_by is untouched; the accepted pickup terms then govern the goods.
 */
async function settlementDeadlineGuard(tx: Tx, c: CheckoutRow) {
  if (c.cancel_intent || !c.release_by || clock.now().getTime() < c.release_by.getTime()) return;
  const blocks = [...c.release_blocks, { type: "CAPTURE_CONFIRMED_AFTER_RELEASE_BY", at: clock.now().toISOString() }];
  await tx.query("update checkouts set cancel_intent='TIMEOUT', release_blocks=$2, updated_at=$3 where id=$1", [c.id, JSON.stringify(blocks), clock.now()]);
  c.cancel_intent = "TIMEOUT";
  c.release_blocks = blocks;
}

/** Independent fulfillment release gate: PAID alone never releases goods. */
async function fulfillmentGate(tx: Tx, c: CheckoutRow, sessionId: string) {
  const now = clock.now();
  const blocked = !!c.cancel_intent || c.release_blocks.length > 0;
  await tx.query(`insert into fulfillment_tickets(id,intent_id,checkout_id,quote_id,state,blocks,created_at,updated_at) values ($1,$2,$3,$4,$5,$6,$7,$7)
    on conflict (checkout_id) do update set state=case when fulfillment_tickets.state in ('HANDED_OVER','CANCELED') then fulfillment_tickets.state else excluded.state end, blocks=excluded.blocks, updated_at=excluded.updated_at`,
    [randomUUID(), c.intent_id, c.id, c.quote_id, blocked ? "BLOCKED" : "READY_FOR_HANDOFF", JSON.stringify(blocked ? [c.cancel_intent, ...c.release_blocks.map((b) => b.type)].filter(Boolean) : []), now]);
  if (!blocked) {
    await tx.query("update recovery_cases set status='RESOLVED_RECOVERED', updated_at=$2 where intent_id=$1 and status in ('AWAITING_BUYER','RECONCILING')", [c.intent_id, now]);
    await queueNotification(tx, { sessionId, kind: "buyer.paid", title: "Payment captured; pickup ticket ready", body: "The store confirmed your exact goods and PayPal captured the accepted total. Your pickup ticket is ready.", link: "/demo" });
  }
}

/** A money attempt reached a final state: keep or release this intent's goods depending on recovery. */
async function finishAttempt(tx: Tx, c: CheckoutRow, sessionId: string) {
  const openCase = await maybeOne<{ id: string }>(tx, "select id from recovery_cases where intent_id=$1 and status in ('AWAITING_BUYER','RECONCILING')", [c.intent_id]);
  if (openCase) {
    const hold = new Date(clock.now().getTime() + 30 * 60_000);
    await retainForIntent(tx, c.id, hold);
    await tx.query("update recovery_cases set status='AWAITING_BUYER', updated_at=$2 where id=$1", [openCase.id, clock.now()]);
    await enqueueJob(tx, "expire_retained", { intentId: c.intent_id }, hold, `retain:${c.intent_id}`);
  } else {
    await setCheckoutReservations(tx, c.id, "RELEASED");
  }
  await tx.query("update fulfillment_tickets set state='CANCELED', updated_at=$2 where checkout_id=$1 and state <> 'HANDED_OVER'", [c.id, clock.now()]);
  if (c.cancel_intent === "TIMEOUT") {
    const refunded = c.payment_state === "REFUNDED";
    await queueNotification(tx, { sessionId, kind: "buyer.timeout", title: refunded ? "Payment settled after the deadline was refunded" : "Store did not confirm in time",
      body: refunded ? "PayPal confirmed the capture only after the store's confirmation deadline, so ReCart refunded it in full and the goods stay on the shelf." : "The store did not confirm your goods before the deadline, so the PayPal authorization was voided. You were not charged.", link: "/demo" });
  }
}

/** Reconcile unresolved operations against PayPal resources, then drive the next step. */
export async function reconcileCheckout(ctx: Ctx, checkoutId: string): Promise<void> {
  const ops = await many<OpRow>(ctx.db, "select * from payment_operations where checkout_id=$1 and status in ('UNKNOWN','IN_FLIGHT','PENDING') order by created_at", [checkoutId]);
  for (const op of ops) {
    if (op.status === "IN_FLIGHT" && clock.now().getTime() - new Date(op.updated_at).getTime() < STALE_IN_FLIGHT_MS) continue;
    const c = await one<CheckoutRow>(ctx.db, "select * from checkouts where id=$1", [checkoutId]);
    if (op.kind === "AUTHORIZE") {
      const order = await ctx.paypal.getOrder(op.payload.orderId);
      const auth = order.body?.purchase_units?.[0]?.payments?.authorizations?.[0];
      if (auth) { await applyResponse(ctx, op, c, { status: 200, body: { purchase_units: [{ payments: { authorizations: [auth] } }] }, debugId: order.debugId }); continue; }
      if (order.status === 200 && order.body?.status === "APPROVED" && clock.now() <= c.approval_deadline && !c.cancel_intent) { await runOperation(ctx, op.id); continue; }
      if (order.status === 200) { await applyResponse(ctx, op, c, { status: 422, body: { details: [{ issue: "NOT_AUTHORIZED_AT_RECONCILIATION" }] }, debugId: order.debugId }); continue; }
    } else if (op.kind === "CAPTURE") {
      const a = await ctx.paypal.getAuthorization(op.payload.authorizationId);
      if (a.status === 200 && (a.body?.status === "CAPTURED" || a.body?.status === "PARTIALLY_CAPTURED")) { await runOperation(ctx, op.id); continue; } // same request ID returns the existing capture
      if (a.status === 200 && a.body?.status === "CREATED") {
        const pastDeadline = !!c.release_by && clock.now().getTime() >= c.release_by.getTime();
        if (c.cancel_intent || pastDeadline) {
          await withTx(ctx.db, async (tx) => {
            const cc = await lockCheckout(tx, c.id);
            await tx.query("update payment_operations set status='FAILED', error='not executed: cancelled or past release deadline before the capture reached PayPal', updated_at=$2 where id=$1", [op.id, clock.now()]);
            if (!cc.cancel_intent) await tx.query("update checkouts set cancel_intent='TIMEOUT' where id=$1", [cc.id]);
            await setCheckoutReservations(tx, cc.id, "RESERVED");
            await setState(tx, cc, "AUTHORIZED");
          });
          await drive(ctx, c.id);
          continue;
        }
        await runOperation(ctx, op.id); continue;
      }
      if (a.status === 200 && a.body?.status === "VOIDED") { await applyResponse(ctx, op, c, { status: 422, body: { details: [{ issue: "AUTHORIZATION_VOIDED" }] }, debugId: a.debugId }); continue; }
    } else if (op.kind === "VOID") {
      const a = await ctx.paypal.getAuthorization(op.payload.authorizationId);
      if (a.status === 200 && a.body?.status === "VOIDED") { await applyResponse(ctx, op, c, { status: 200, body: { status: "VOIDED" }, debugId: a.debugId }); continue; }
      if (a.status === 200 && a.body?.status === "CAPTURED") { await applyResponse(ctx, op, c, { status: 422, body: { details: [{ issue: "PREVIOUSLY_CAPTURED" }] }, debugId: a.debugId }); continue; }
      await runOperation(ctx, op.id); continue;
    } else {
      await runOperation(ctx, op.id); // CREATE_ORDER and REFUND replays are idempotent by request ID
      continue;
    }
  }
  // Provider-side pending statuses (capture or refund) are polled until final.
  const c = await one<CheckoutRow>(ctx.db, "select * from checkouts where id=$1", [checkoutId]);
  if (c.payment_state === "CAPTURE_IN_FLIGHT" && c.capture_id) {
    const cap = await ctx.paypal.getCapture(c.capture_id);
    if (cap.status === 200 && cap.body?.status === "COMPLETED") {
      const owner = await sessionOfCheckout(ctx.db, c.id);
      await withTx(ctx.db, async (tx) => {
        const cc = await lockCheckout(tx, c.id);
        if (cc.payment_state !== "CAPTURE_IN_FLIGHT") return;
        await setCheckoutReservations(tx, cc.id, "COMMITTED");
        await settlementDeadlineGuard(tx, cc);
        await setState(tx, cc, "PAID");
        await fulfillmentGate(tx, cc, owner.session_id);
      });
      ctx.events.changed(owner.session_id, "capture.completed");
    } else if (cap.status === 200 && ["DECLINED", "FAILED"].includes(cap.body?.status)) {
      await withTx(ctx.db, async (tx) => { const cc = await lockCheckout(tx, c.id); await setState(tx, cc, "REVIEW_REQUIRED"); });
    } else {
      await enqueueJob(ctx.db, "reconcile_checkout", { checkoutId }, new Date(clock.now().getTime() + 60_000), `reconcile:${checkoutId}`);
    }
  }
  if (c.payment_state === "REFUND_IN_FLIGHT" && c.refund_id) {
    const ref = await ctx.paypal.getRefund(c.refund_id);
    if (ref.status === 200 && ref.body?.status === "COMPLETED") {
      const owner = await sessionOfCheckout(ctx.db, c.id);
      await withTx(ctx.db, async (tx) => { const cc = await lockCheckout(tx, c.id); if (cc.payment_state === "REFUND_IN_FLIGHT") { await setState(tx, cc, "REFUNDED"); await finishAttempt(tx, cc, owner.session_id); } });
      ctx.events.changed(owner.session_id, "refund.completed");
    } else {
      await enqueueJob(ctx.db, "reconcile_checkout", { checkoutId }, new Date(clock.now().getTime() + 5 * 60_000), `reconcile:${checkoutId}`);
    }
  }
  await drive(ctx, checkoutId);
}

/** Approval window ended: if PayPal never authorized, close the attempt without money and free the goods. */
export async function onApprovalDeadline(ctx: Ctx, checkoutId: string) {
  const owner = await sessionOfCheckout(ctx.db, checkoutId);
  await withTx(ctx.db, async (tx) => {
    const c = await lockCheckout(tx, checkoutId);
    if (c.payment_state !== "READY_FOR_APPROVAL") return;
    if (clock.now().getTime() < c.approval_deadline.getTime()) return;
    await tx.query("update checkouts set cancel_intent=coalesce(cancel_intent,'APPROVAL_EXPIRED') where id=$1", [c.id]);
    await setState(tx, c, "CLOSED_NO_PAYMENT");
    await finishAttempt(tx, c, owner.session_id);
  });
  ctx.events.changed(owner.session_id, "approval.expired");
}

/** Merchant-confirmation deadline (release_by): void an unconfirmed hold; a capture in flight is reconciled and refunded if it lands. */
export async function onReleaseDeadline(ctx: Ctx, checkoutId: string) {
  const c = await one<CheckoutRow>(ctx.db, "select * from checkouts where id=$1", [checkoutId]);
  if (!c.release_by || clock.now().getTime() < c.release_by.getTime()) return;
  if (["AUTHORIZED", "CAPTURE_IN_FLIGHT", "STATUS_UNKNOWN", "AUTHORIZATION_IN_FLIGHT"].includes(c.payment_state)) {
    await requestCancellation(ctx, checkoutId, "TIMEOUT", { type: "RELEASE_DEADLINE_PASSED" });
  }
}

/** Physical handoff: re-check the release gate, then consume the committed goods. */
export async function markHandedOver(ctx: Ctx, session: SessionRow, checkoutId: string) {
  await withTx(ctx.db, async (tx) => {
    const c = await lockCheckout(tx, checkoutId);
    const owner = await sessionOfCheckout(tx, checkoutId);
    if (owner.session_id !== session.id) throw new AppError(404, "checkout_not_found", "Checkout not found");
    const t = await maybeOne<{ state: string }>(tx, "select state from fulfillment_tickets where checkout_id=$1 for update", [c.id]);
    if (c.payment_state !== "PAID" || t?.state !== "READY_FOR_HANDOFF" || c.cancel_intent || c.release_blocks.length) throw new AppError(409, "handoff_blocked", "Handoff is blocked: the ticket is not releasable.");
    const uncommitted = await maybeOne(tx, "select 1 from reservations where checkout_id=$1 and status in ('RESERVED','FROZEN') limit 1", [c.id]);
    if (uncommitted) throw new AppError(409, "allocation_not_committed", "Handoff is blocked: the goods for this purchase are not committed.");
    const lines = await many<{ sku: string; qty: number }>(tx, "select sku, qty from reservations where checkout_id=$1 and status='COMMITTED'", [c.id]);
    for (const l of lines) await tx.query("update inventory set on_hand=on_hand-$3, updated_at=$4 where session_id=$1 and sku=$2", [session.id, l.sku, l.qty, clock.now()]);
    await setCheckoutReservations(tx, c.id, "FULFILLED");
    await tx.query("update fulfillment_tickets set state='HANDED_OVER', updated_at=$2 where checkout_id=$1", [c.id, clock.now()]);
    await tx.query("update checkouts set terminal=true, updated_at=$2 where id=$1", [c.id, clock.now()]);
    await tx.query("update intents set status='CLOSED', closed_reason='completed', updated_at=$2 where id=$1", [c.intent_id, clock.now()]);
    await audit(tx, { sessionId: session.id, intentId: c.intent_id, actor: "merchant(simulated)", action: "handoff.completed", entity: "checkout", entityId: c.id });
  });
  ctx.events.changed(session.id, "handoff");
}

export { fromPayPalValue };
