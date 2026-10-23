import { createHash, randomUUID } from "node:crypto";
import { CATALOG } from "../../domain/catalog/fixtures.js";
import type { Bundle } from "../../domain/solver/solver.js";
import { clock } from "../clock.js";
import { AppError, audit } from "../context.js";
import { maybeOne, one, withTx, type Db, type Queryable } from "../db/pool.js";
import { timingFor, type SessionRow } from "./sessions.js";
import type { GoalRow } from "./goals.js";

export interface QuoteData {
  merchant: { id: string; name: string };
  sessionId: string;
  goalVersion: number;
  goalId: string;
  recipe: { id: string; version: string; title: string };
  lines: { role: string; roleLabel: string; sku: string; name: string; qty: number; unitCents: number; lineCents: number }[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  currency: "USD";
  pickup: { start: string; end: string; timezone: string; label: string; location: string };
  evidenceMode: string;
  checks: { id: string; label: string; outcome: string; detail: string }[];
  setupSteps: string[];
  confirmationPolicy: { preset: string; merchantConfirmationMinutes: number; approvalMinutes: number; note: string };
  versions: Record<string, string>;
  acceptBy: string;
}

export interface QuoteRow { id: string; intent_id: string; version: number; predecessor_id: string | null; solve_run_id: string | null; goal_id: string; kind: "ORIGINAL" | "REPLACEMENT"; data: QuoteData; total_cents: number; hash: string; status: string; accept_by: Date; reason: string | null; created_at: Date }

export const PICKUP_LOCATION = "ReCart Demo Audio, simulated store counter (no physical location)";

/** Canonical JSON (sorted keys) so the hash binds the exact commercial and capability terms. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson((v as any)[k])).join(",") + "}";
  return JSON.stringify(v);
}
export const hashQuote = (d: QuoteData) => createHash("sha256").update(canonicalJson(d)).digest("hex");

/** Publish an immutable, payable quote for one solver-approved bundle. Older unaccepted quotes are superseded. */
export async function publishQuote(q: Queryable, args: { session: SessionRow; intentId: string; goal: GoalRow; solveRunId: string; bundle: Bundle; kind: "ORIGINAL" | "REPLACEMENT"; predecessorId: string | null; reason: string }): Promise<QuoteRow> {
  const t = timingFor(args.session);
  const now = clock.now();
  const acceptBy = new Date(now.getTime() + t.quoteAcceptMinutes * 60_000);
  const b = args.bundle;
  const data: QuoteData = {
    merchant: { id: CATALOG.merchantId, name: CATALOG.merchantName },
    sessionId: args.session.id, goalVersion: args.goal.version, goalId: args.goal.id,
    recipe: { id: b.recipeId, version: b.recipeVersion, title: b.recipeTitle },
    lines: b.lines, subtotalCents: b.subtotalCents, taxCents: b.taxCents, totalCents: b.totalCents, currency: "USD",
    pickup: { ...b.pickup, location: PICKUP_LOCATION },
    evidenceMode: b.evidenceMode,
    checks: b.checks.map((c) => ({ id: c.id, label: c.label, outcome: c.outcome, detail: c.detail })),
    setupSteps: b.setupSteps,
    confirmationPolicy: {
      preset: args.session.preset, merchantConfirmationMinutes: t.confirmationMinutes, approvalMinutes: t.approvalMinutes,
      note: `After PayPal authorizes the payment, the store has ${t.confirmationMinutes} minutes to confirm the exact goods; otherwise the authorization is voided. Approve in PayPal within ${t.approvalMinutes} minutes of starting checkout.`,
    },
    versions: { catalog: CATALOG.version, ...Object.fromEntries(Object.entries((await solveVersions(q, args.solveRunId)) ?? {})) },
    acceptBy: acceptBy.toISOString(),
  };
  const hash = hashQuote(data);
  const prev = await maybeOne<{ v: number }>(q, "select coalesce(max(version),0) v from quotes where intent_id=$1", [args.intentId]);
  const id = randomUUID();
  await q.query("update quotes set status='SUPERSEDED', reason=$2 where intent_id=$1 and status='PUBLISHED'", [args.intentId, "replaced by a newer quote"]);
  await q.query("insert into quotes(id,intent_id,version,predecessor_id,solve_run_id,goal_id,kind,data,total_cents,hash,status,accept_by,reason,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PUBLISHED',$11,$12,$13)", [
    id, args.intentId, (prev?.v ?? 0) + 1, args.predecessorId, args.solveRunId, args.goal.id, args.kind, JSON.stringify(data), data.totalCents, hash, acceptBy, args.reason, now,
  ]);
  await q.query("update intents set current_quote_id=$2, updated_at=$3 where id=$1", [args.intentId, id, now]);
  await audit(q, { sessionId: args.session.id, intentId: args.intentId, actor: "system", action: "quote.published", entity: "quote", entityId: id, detail: { total: data.totalCents, hash, kind: args.kind } });
  return one<QuoteRow>(q, "select * from quotes where id=$1", [id]);
}

async function solveVersions(q: Queryable, solveRunId: string): Promise<Record<string, string> | null> {
  const r = await maybeOne<{ v: Record<string, string> }>(q, "select result->'versions' v from solve_runs where id=$1", [solveRunId]);
  return r?.v ?? null;
}

/** Record buyer consent for the exact quote version the buyer saw (hash echoed by the client). */
export async function acceptQuote(db: Db, args: { session: SessionRow; quoteId: string; displayedHash: string }) {
  const out = await withTx(db, async (tx) => {
    const quote = await maybeOne<QuoteRow & { session_id: string; current_quote_id: string }>(tx, "select q.*, i.session_id, i.current_quote_id from quotes q join intents i on i.id=q.intent_id where q.id=$1 for update of q", [args.quoteId]);
    if (!quote || quote.session_id !== args.session.id) throw new AppError(404, "quote_not_found", "Quote not found in this demo session.");
    if (quote.status === "ACCEPTED") return quote; // idempotent double click
    if (quote.status !== "PUBLISHED" || quote.current_quote_id !== quote.id) throw new AppError(409, "quote_superseded", "This quote was replaced. Review the current terms.");
    if (clock.now().getTime() > quote.accept_by.getTime()) {
      await tx.query("update quotes set status='EXPIRED' where id=$1", [quote.id]);
      return { expired: true } as const;
    }
    if (args.displayedHash !== quote.hash) throw new AppError(409, "quote_mismatch", "The terms you saw do not match the current quote. Review again.");
    await tx.query("insert into consents(id,quote_id,quote_hash,actor,displayed_terms,accepted_at) values ($1,$2,$3,$4,$5,$6)", [randomUUID(), quote.id, quote.hash, `buyer:${args.session.id}`, JSON.stringify(quote.data), clock.now()]);
    await tx.query("update quotes set status='ACCEPTED' where id=$1", [quote.id]);
    await audit(tx, { sessionId: args.session.id, intentId: quote.intent_id, actor: "buyer", action: "quote.accepted", entity: "quote", entityId: quote.id, detail: { hash: quote.hash, total: quote.total_cents } });
    return { ...quote, status: "ACCEPTED" };
  });
  if ("expired" in out) throw new AppError(409, "quote_expired", "This quote's five-minute acceptance window ended. Refresh to get current terms.");
  return out;
}

export async function getQuote(q: Queryable, id: string): Promise<QuoteRow | null> {
  return maybeOne<QuoteRow>(q, "select * from quotes where id=$1", [id]);
}
