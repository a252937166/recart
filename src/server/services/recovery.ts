import { randomUUID } from "node:crypto";
import { clock } from "../clock.js";
import { AppError, audit, enqueueJob, type Ctx } from "../context.js";
import type { ExplainFacts, ExplainResult } from "../language/adapter.js";
import { maybeOne, one, withTx, type Queryable } from "../db/pool.js";
import { releaseRetained } from "./inventory.js";
import { queueNotification } from "./notifications.js";
import { drive, requestCancellation, type CheckoutRow } from "./payments.js";
import { currentGoal } from "./goals.js";
import { publishQuote, type QuoteRow } from "./quotes.js";
import { runSolve, getSolveRun } from "./solving.js";
import { buildChangeExplanation } from "./explain.js";
import { assertSessionActive, type SessionRow } from "./sessions.js";
import { fingerprint } from "../build-info.js";

fingerprint(import.meta.url, "services/recovery.js");

export interface RecoveryCaseRow { id: string; session_id: string; intent_id: string; checkout_id: string | null; original_quote_id: string | null; reason: string; detail: any; status: string; solve_run_id: string | null; created_at: Date; updated_at: Date }

/**
 * Merchant readiness check finds goods missing (spec §4 / §5 merchant journey).
 * Records the discrepancy, blocks capture of the now-invalid original, opens a durable recovery case with a
 * notification-outbox entry in the same transaction, then resolves the old money and computes replacements.
 */
export async function reportMissing(ctx: Ctx, session: SessionRow, args: { checkoutId: string; sku: string }) {
  assertSessionActive(session);
  const caseId = await withTx(ctx.db, async (tx) => {
    const c = await maybeOne<CheckoutRow & { session_id: string }>(tx, "select c.*, i.session_id from checkouts c join intents i on i.id=c.intent_id where c.id=$1 for update of c", [args.checkoutId]);
    if (!c || c.session_id !== session.id) throw new AppError(404, "checkout_not_found", "Checkout not found");
    if (c.terminal) throw new AppError(409, "checkout_closed", "This checkout is already closed.");
    const held = await maybeOne<{ id: string; qty: number }>(tx, "select id, qty from reservations where checkout_id=$1 and sku=$2 and status in ('RESERVED','COMMITTED','FROZEN')", [c.id, args.sku]);
    if (!held) throw new AppError(400, "sku_not_in_order", "That item is not part of this reserved order.");
    const stock = await one<{ on_hand: number }>(tx, "select on_hand from inventory where session_id=$1 and sku=$2 for update", [session.id, args.sku]);
    const missing = Math.min(held.qty, stock.on_hand);
    const now = clock.now();
    await tx.query("update inventory set on_hand=on_hand-$3, updated_at=$4 where session_id=$1 and sku=$2", [session.id, args.sku, missing, now]);
    await tx.query("update reservations set status='RELEASED', updated_at=$2 where id=$1", [held.id, now]); // those units no longer exist
    const blocks = [...c.release_blocks, { type: "INVENTORY_DISCREPANCY", detail: { sku: args.sku, missing }, at: now.toISOString() }];
    await tx.query("update checkouts set release_blocks=$2, cancel_intent=coalesce(cancel_intent,'INVALID_ORIGINAL'), updated_at=$3 where id=$1", [c.id, JSON.stringify(blocks), now]);
    const existing = await maybeOne<{ id: string }>(tx, "select id from recovery_cases where checkout_id=$1", [c.id]);
    const id = existing?.id ?? randomUUID();
    if (!existing) {
      await tx.query("insert into recovery_cases(id,session_id,intent_id,checkout_id,original_quote_id,reason,detail,status,created_at,updated_at) values ($1,$2,$3,$4,$5,'INVENTORY_DISCREPANCY',$6,'RECONCILING',$7,$7)",
        [id, session.id, c.intent_id, c.id, c.quote_id, JSON.stringify({ sku: args.sku, missing }), now]);
      await tx.query("update intents set original_quote_id=coalesce(original_quote_id,$2), updated_at=$3 where id=$1", [c.intent_id, c.quote_id, now]);
    }
    await queueNotification(tx, { sessionId: session.id, caseId: id, kind: "buyer.recovery", title: "Your setup needs a change", body: `The store's packing check could not find ${args.sku}. Your original payment hold is being released, and ReCart has rechecked the complete setup. Review the options before anything is charged.`, link: `/case/${id}` });
    await audit(tx, { sessionId: session.id, intentId: c.intent_id, actor: "merchant(simulated)", action: "inventory.discrepancy", entity: "checkout", entityId: c.id, detail: { sku: args.sku, missing, simulated: true } });
    return id;
  });
  // Money first: void (or reconcile) the invalid original. Planning may proceed in parallel.
  await drive(ctx, args.checkoutId);
  await recomputeCase(ctx, session, caseId);
  ctx.events.changed(session.id, "recovery.opened");
  return caseId;
}

/** Re-run the whole-bundle search for a case against the current confirmed goal and ownership-aware stock. */
export async function recomputeCase(ctx: Ctx, session: SessionRow, caseId: string) {
  const rc = await one<RecoveryCaseRow>(ctx.db, "select * from recovery_cases where id=$1", [caseId]);
  const original = rc.original_quote_id ? await one<QuoteRow>(ctx.db, "select * from quotes where id=$1", [rc.original_quote_id]) : null;
  const run = await runSolve(ctx.db, { sessionId: session.id, intentId: rc.intent_id, purpose: "recovery", ...(original ? { originalLines: original.data.lines.map((l) => ({ sku: l.sku, qty: l.qty })) } : {}) });
  let explanation: unknown = null;
  let explainJob: ExplainJob | null = null;
  const goal = await currentGoal(ctx.db, rc.intent_id);
  if (original && goal && rc.detail?.sku) {
    const exp = buildChangeExplanation({ goal: goal.data, original: original.data, missingSku: rc.detail.sku, result: run.result, availability: run.availability });
    // The template explanation is stored at once and shown while a job asks the model, so no request waits on it.
    explanation = { text: exp.fallback.summary, options: exp.fallback.options, source: "template", model: null, error: null, pending: true, swaps: exp.swaps, diffs: exp.diffs, solveRunId: run.id };
    explainJob = { caseId, sessionId: session.id, intentId: rc.intent_id, solveRunId: run.id, facts: exp.facts, fallback: exp.fallback };
  }
  // The pending explanation and the job that will settle it commit together: an interruption between them would
  // otherwise leave a case marked "on its way" that nothing ever answers.
  await withTx(ctx.db, async (tx) => {
    await tx.query("update recovery_cases set solve_run_id=$2, detail = detail || $3::jsonb, updated_at=$4 where id=$1", [caseId, run.id, JSON.stringify({ explanation }), clock.now()]);
    if (explainJob) await enqueueJob(tx, "explain_case", explainJob, clock.now(), `explain:${caseId}:${run.id}`);
  });
  return run;
}

export type ExplainJob = { caseId: string; sessionId: string; intentId: string; solveRunId: string; facts: ExplainFacts; fallback: ExplainResult };

/** The job behind a recovery explanation: asks the model and patches the case, unless a newer search replaced this one or it was settled already. */
export async function explainCase(ctx: Ctx, p: ExplainJob) {
  const rc = await maybeOne<RecoveryCaseRow>(ctx.db, "select * from recovery_cases where id=$1", [p.caseId]);
  if (!rc || rc.solve_run_id !== p.solveRunId || rc.detail?.explanation?.pending !== true) return;
  const generated = await ctx.language.explainChange({ sessionId: p.sessionId, intentId: p.intentId, facts: p.facts, fallback: p.fallback });
  const patch = { text: generated.summary, options: generated.options, source: generated.status === "OK" ? "model" : "template", model: generated.model, error: generated.error, pending: false };
  // Only the search this job was made for, and only while the case still waits: a runner that lost its lease and
  // finishes late cannot overwrite the answer that settled the case meanwhile.
  const r = await ctx.db.query("update recovery_cases set detail = jsonb_set(detail, '{explanation}', coalesce(detail->'explanation', '{}'::jsonb) || $2::jsonb), updated_at=$3 where id=$1 and solve_run_id=$4 and (detail->'explanation'->>'pending') = 'true'", [p.caseId, JSON.stringify(patch), clock.now(), p.solveRunId]);
  if (r.rowCount) ctx.events.changed(p.sessionId, "explanation");
}

/**
 * The job failed for good (its retries are spent): the template stays, and the case stops waiting for the model.
 * Runs inside the transaction that marks the job FAILED, so both commit or neither does; returns whether the case
 * changed, and the caller announces it only after the commit.
 */
export async function settleExplanation(q: Queryable, p: Pick<ExplainJob, "caseId" | "sessionId" | "solveRunId">, error: string): Promise<boolean> {
  const patch = { source: "template", model: null, error: error.slice(0, 300), pending: false };
  const r = await q.query("update recovery_cases set detail = jsonb_set(detail, '{explanation}', coalesce(detail->'explanation', '{}'::jsonb) || $2::jsonb), updated_at=$3 where id=$1 and solve_run_id=$4 and (detail->'explanation'->>'pending') = 'true'", [p.caseId, JSON.stringify(patch), clock.now(), p.solveRunId]);
  return (r.rowCount ?? 0) > 0;
}

/** Buyer picks one solver-approved replacement; the server re-derives it from the stored run (never from the browser). */
export async function selectCandidate(ctx: Ctx, session: SessionRow, args: { solveRunId: string; index: number; caseId?: string | null }) {
  assertSessionActive(session);
  const run = await getSolveRun(ctx.db, args.solveRunId);
  const intent = await maybeOne<{ id: string; session_id: string; original_quote_id: string | null; current_goal_id: string | null; status: string }>(ctx.db, "select * from intents where id=$1", [run?.intent_id ?? null]);
  if (!run || !intent || intent.session_id !== session.id) throw new AppError(404, "run_not_found", "Search result not found in this session.");
  if (intent.status !== "OPEN") throw new AppError(409, "intent_closed", "This purchase is closed. Start a separate demo.");
  if (run.goal_id !== intent.current_goal_id) throw new AppError(409, "stale_result", "Your requirements changed; ReCart is showing current options.");
  const bundle = run.result.candidates[args.index];
  if (!bundle || run.result.status !== "FEASIBLE") throw new AppError(400, "no_such_option", "That option is not available.");
  const goal = await currentGoal(ctx.db, intent.id);
  return withTx(ctx.db, async (tx) => {
    await tx.query("select id from intents where id=$1 for update", [intent.id]);
    const kind = intent.original_quote_id ? "REPLACEMENT" : "ORIGINAL";
    return publishQuote(tx, { session, intentId: intent.id, goal: goal!, solveRunId: run.id, bundle, kind, predecessorId: intent.original_quote_id, reason: kind === "REPLACEMENT" ? "whole-bundle recovery after inventory discrepancy" : "initial setup" });
  });
}

/** Buyer closes the purchase (or accepts the no-solution exit). Obligations keep reconciling in the background. */
export async function cancelPurchase(ctx: Ctx, session: SessionRow, reason: "buyer_cancelled" | "no_supported_solution") {
  const intent = await one<{ id: string; active_checkout_id: string | null }>(ctx.db, "select id, active_checkout_id from intents where session_id=$1 order by created_at desc limit 1", [session.id]);
  if (intent.active_checkout_id) {
    const c = await one<CheckoutRow>(ctx.db, "select * from checkouts where id=$1", [intent.active_checkout_id]);
    if (!c.terminal) await requestCancellation(ctx, c.id, "BUYER");
  }
  await withTx(ctx.db, async (tx) => {
    await releaseRetained(tx, intent.id);
    await tx.query("update quotes set status='DECLINED' where intent_id=$1 and status='PUBLISHED'", [intent.id]);
    await tx.query("update recovery_cases set status=$2, updated_at=$3 where intent_id=$1 and status in ('AWAITING_BUYER','RECONCILING')", [intent.id, reason === "no_supported_solution" ? "CLOSED_NO_SOLUTION" : "CLOSED_BY_BUYER", clock.now()]);
    await tx.query("update intents set status='CLOSED', closed_reason=$2, updated_at=$3 where id=$1", [intent.id, reason, clock.now()]);
    await audit(tx, { sessionId: session.id, intentId: intent.id, actor: "buyer", action: "purchase.closed", detail: { reason } });
  });
  ctx.events.changed(session.id, "purchase.closed");
}
