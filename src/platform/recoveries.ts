import { clock } from "../server/clock.js";
import { many, maybeOne, one, withTx, type Tx } from "../server/db/pool.js";
import { loadProducts, loadStock } from "./catalog.js";
import { ApiError, canonicalJson, iso, newId, newSecret, sha256, type PlatformCtx, type Queryable } from "./core.js";
import { emitEvent, type EventType } from "./events.js";
import type { MerchantRow } from "./merchants.js";
import { money, planRecovery, revalidateApproved, type OrderLine, type Outcome, type PlanInput, type PlanResult, type ProposalBody, type UnavailableLine } from "./planning.js";
import type { RecoveryCreate, RecoveryPreview, Requirements } from "./schemas.js";

export type RecoveryStatus = "awaiting_buyer" | "action_required" | "no_solution" | "no_change_needed" | "approved" | "executing" | "reconciling" | "completed" | "declined" | "cancelled" | "expired";
const OPEN_FOR_PLANNING: RecoveryStatus[] = ["awaiting_buyer", "action_required", "no_solution", "no_change_needed", "expired"];

export interface RecoveryRow {
  id: string; merchant_id: string; external_order_id: string; status: RecoveryStatus; currency: string; requirements: Requirements;
  original_items: OrderLine[]; shipping_cents: number; unavailable_items: UnavailableLine[]; fulfillment: PlanInput["fulfillment"];
  buyer_reference: string | null; metadata: Record<string, string> | null; current_proposal_id: string | null; created_at: Date; updated_at: Date;
}
export interface ProposalRow {
  id: string; merchant_id: string; recovery_id: string; version: number; status: "active" | "superseded" | "approved" | "declined" | "expired";
  outcome: Outcome; approvable: boolean; body: ProposalBody; plan_signature: string; hash: string; catalog_version: number;
  created_at: Date; expires_at: Date; decided_at: Date | null;
}
interface ExecutionRow { id: string; recovery_id: string; proposal_id: string; proposal_hash: string; status: "pending" | "succeeded" | "failed" | "unknown"; valid_until: Date; external_reference: string | null; message: string | null; created_at: Date; acknowledged_at: Date | null }

export function assertTimezone(tz: string) {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { throw new ApiError("invalid_request", "invalid_timezone", `${tz} is not an IANA time zone, e.g. America/Los_Angeles.`); }
}

/** Validate a request against the merchant's catalog and fill defaults (agreed prices, held units). */
async function normalize(q: Queryable, merchant: MerchantRow, body: RecoveryPreview): Promise<PlanInput> {
  if (body.currency !== merchant.currency) throw new ApiError("invalid_request", "currency_mismatch", `currency is ${body.currency}; this merchant uses ${merchant.currency}.`);
  const req = body.requirements;
  if (req.budget && req.budget.currency !== body.currency) throw new ApiError("invalid_request", "currency_mismatch", "requirements.budget.currency must equal the order currency.");
  assertTimezone(req.timezone);
  if (req.needed_by && !body.fulfillment?.ready_at) throw new ApiError("invalid_request", "ready_at_required", "requirements.needed_by needs fulfillment.ready_at so the deadline can be checked.");
  const ids = body.original_items.map((i) => i.product_id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new ApiError("invalid_request", "duplicate_item", `original_items lists ${dup} more than once; use quantity.`);
  const products = await many<{ product_id: string; price_cents: number }>(q, "select product_id, price_cents from catalog_products where merchant_id=$1 and product_id = any($2)", [merchant.id, ids]);
  const price = new Map(products.map((p) => [p.product_id, p.price_cents]));
  const unknown = ids.filter((id) => !price.has(id));
  if (unknown.length) throw new ApiError("invalid_request", "unknown_product", "Every original item must be a product you sent to ReCart (any status).", { product_ids: unknown });
  const unavailable = new Map<string, UnavailableLine>();
  for (const u of body.unavailable_items) {
    const item = body.original_items.find((i) => i.product_id === u.product_id);
    if (!item) throw new ApiError("invalid_request", "unavailable_item_not_in_order", `${u.product_id} is not in original_items.`);
    if (unavailable.has(u.product_id)) throw new ApiError("invalid_request", "duplicate_item", `unavailable_items lists ${u.product_id} more than once.`);
    if (u.quantity > item.quantity) throw new ApiError("invalid_request", "unavailable_quantity_too_large", `Only ${item.quantity} of ${u.product_id} were ordered.`);
    unavailable.set(u.product_id, { product_id: u.product_id, quantity: u.quantity, reason: u.reason });
  }
  const original_items: OrderLine[] = body.original_items.map((i) => {
    const held = i.held_quantity ?? i.quantity - (unavailable.get(i.product_id)?.quantity ?? 0);
    if (held > i.quantity) throw new ApiError("invalid_request", "held_quantity_too_large", `held_quantity for ${i.product_id} exceeds its quantity.`);
    return { product_id: i.product_id, quantity: i.quantity, unit_price_cents: i.unit_price_cents ?? price.get(i.product_id)!, held_quantity: held };
  });
  return { currency: body.currency, requirements: req, original_items, shipping_cents: body.shipping_cents, unavailable_items: [...unavailable.values()], fulfillment: body.fulfillment ?? null };
}

async function planFor(q: Queryable, merchant: MerchantRow, input: PlanInput): Promise<PlanResult> {
  const [products, stock] = await Promise.all([loadProducts(q, merchant.id), loadStock(q, merchant, input.fulfillment?.location_ids)]);
  return planRecovery(input, { merchant, products, stock, now: clock.now() });
}
const inputOf = (r: RecoveryRow): PlanInput => ({ currency: r.currency, requirements: r.requirements, original_items: r.original_items, shipping_cents: r.shipping_cents, unavailable_items: r.unavailable_items, fulfillment: r.fulfillment });

function statusFor(outcome: Outcome): RecoveryStatus {
  switch (outcome) {
    case "proposal_ready": case "budget_conflict": case "deadline_conflict": return "awaiting_buyer";
    case "no_change_needed": return "no_change_needed";
    case "no_supported_bundle": case "unsupported_requirements": return "no_solution";
    default: return "action_required";
  }
}

/** Who acts next, and how. Derived only from stored state so every interface shows the same guidance. */
export function nextAction(r: Pick<RecoveryRow, "status" | "currency">, p: ProposalRow | null, openExecution: ExecutionRow | null) {
  const o = p?.outcome;
  const c = (p?.body.conflict ?? null) as any;
  switch (r.status) {
    case "awaiting_buyer":
      if (o === "proposal_ready") return { actor: "buyer", code: "review_proposal", message: "Send the buyer a review link. Only the buyer can approve this exact version." };
      if (o === "budget_conflict") return { actor: "buyer", code: "raise_budget_or_decline", message: `The closest complete setup needs a limit of at least ${money(c.required_max_total_cents, r.currency)}. Only the buyer can raise the limit, on the review page.` };
      return { actor: "buyer", code: "accept_later_time_or_decline", message: "The closest complete setup is ready later than the buyer needs it. Only the buyer can accept a later time, on the review page." };
    case "action_required":
      if (o === "evidence_incomplete") return { actor: "merchant", code: "document_attributes", message: "Document the listed product attributes (with evidence) and ReCart recomputes automatically." };
      if (o === "inventory_stale") return { actor: "merchant", code: "refresh_inventory", message: "Send current stock counts for the listed products; ReCart recomputes automatically." };
      if (o === "needs_clarification") return { actor: "merchant", code: "update_requirements", message: "Ask the buyer for the missing details and update the recovery's requirements." };
      return { actor: "merchant", code: "retry_or_cancel", message: "Recompute later or cancel the recovery." };
    case "no_solution": return { actor: "merchant", code: "resolve_without_replacement", message: "No supported replacement exists. Resolve the order under your own policy, for example cancel and refund." };
    case "no_change_needed": return { actor: "merchant", code: "fulfil_original_items", message: "Enough stock exists: fulfil the original items from the listed locations." };
    case "approved": return { actor: "merchant", code: "start_execution", message: "Start an execution: ReCart revalidates the approved version, then apply it in your system and acknowledge the outcome." };
    case "executing": return { actor: "merchant", code: "acknowledge_execution", message: `Apply the approved items and any payment difference in your system, then acknowledge execution ${openExecution?.id ?? ""}.`.replace(/ \./, ".") };
    case "reconciling": return { actor: "merchant", code: "reconcile_unknown_outcome", message: `Check your system for the result of execution ${openExecution?.id ?? ""} and acknowledge succeeded or failed before any retry.` };
    case "expired": return { actor: "merchant", code: "recompute_or_cancel", message: "The proposal expired before it was approved or executed, so any earlier approval no longer applies. Recompute for current stock (the buyer can also refresh the review page) and get a new approval, or cancel." };
    default: return { actor: "none", code: "none", message: "Nothing further is needed." };
  }
}

export function proposalView(p: ProposalRow) {
  const { outcome, approvable, summary, ...rest } = p.body;
  return { id: p.id, recovery_id: p.recovery_id, version: p.version, status: p.status, outcome, approvable: approvable && p.status === "active", summary, hash: p.hash, created_at: iso(p.created_at), expires_at: iso(p.expires_at), decided_at: iso(p.decided_at), ...rest };
}
function executionView(e: ExecutionRow) {
  return { id: e.id, proposal_id: e.proposal_id, proposal_hash: e.proposal_hash, status: e.status, valid_until: iso(e.valid_until), external_reference: e.external_reference, message: e.message, created_at: iso(e.created_at), acknowledged_at: iso(e.acknowledged_at) };
}

async function recoveryView(q: Queryable, r: RecoveryRow) {
  const p = r.current_proposal_id ? await maybeOne<ProposalRow>(q, "select * from proposals where id=$1", [r.current_proposal_id]) : null;
  const latest = await maybeOne<ExecutionRow>(q, "select * from executions where recovery_id=$1 order by created_at desc limit 1", [r.id]);
  const open = latest && (latest.status === "pending" || latest.status === "unknown") ? latest : null;
  return {
    id: r.id, external_order_id: r.external_order_id, status: r.status, next_action: nextAction(r, p, open), currency: r.currency,
    requirements: r.requirements, original_items: r.original_items, shipping_cents: r.shipping_cents, unavailable_items: r.unavailable_items,
    fulfillment: r.fulfillment, buyer_reference: r.buyer_reference, metadata: r.metadata ?? {},
    proposal: p ? proposalView(p) : null, latest_execution: latest ? executionView(latest) : null,
    created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  };
}
export type RecoveryView = Awaited<ReturnType<typeof recoveryView>>;

function proposalHash(id: string, recoveryId: string, version: number, expiresAt: Date, body: ProposalBody) {
  return sha256(canonicalJson({ id, recovery_id: recoveryId, version, expires_at: expiresAt.toISOString(), body }));
}

/** Store a new proposal version, supersede the previous active one and move the recovery to the matching status. */
async function storeProposal(tx: Tx, merchant: MerchantRow, r: RecoveryRow, plan: PlanResult, event: EventType, reason: string) {
  const now = clock.now();
  const prev = await maybeOne<{ version: number }>(tx, "select max(version) version from proposals where recovery_id=$1", [r.id]);
  const version = (prev?.version ?? 0) + 1;
  const id = newId("prop");
  const expiresAt = new Date(now.getTime() + merchant.proposal_ttl_seconds * 1000);
  const hash = proposalHash(id, r.id, version, expiresAt, plan.body);
  await tx.query("update proposals set status='superseded' where recovery_id=$1 and status='active'", [r.id]);
  await tx.query(`insert into proposals(id,merchant_id,recovery_id,version,status,outcome,approvable,body,plan_signature,hash,catalog_version,created_at,expires_at)
    values ($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,$10,$11,$12)`, [id, merchant.id, r.id, version, plan.outcome, plan.approvable, JSON.stringify(plan.body), plan.signature, hash, merchant.catalog_version, now, expiresAt]);
  const status = statusFor(plan.outcome);
  await tx.query("update recoveries set current_proposal_id=$2, status=$3, updated_at=$4 where id=$1", [r.id, id, status, now]);
  await emitEvent(tx, merchant, event, { recovery_id: r.id, external_order_id: r.external_order_id, status, reason, proposal: { id, version, outcome: plan.outcome, approvable: plan.approvable, hash, expires_at: expiresAt.toISOString(), total_cents: (plan.body.replacement as any)?.totals?.total_cents ?? null, difference_cents: (plan.body.replacement as any)?.difference_cents ?? null } });
  return id;
}

async function lockRecovery(tx: Tx, merchantId: string, id: string): Promise<RecoveryRow> {
  const r = await maybeOne<RecoveryRow>(tx, "select * from recoveries where id=$1 and merchant_id=$2 for update", [id, merchantId]);
  if (!r) throw new ApiError("not_found", "recovery_not_found", "No recovery with this ID for this merchant.");
  return r;
}
async function freshMerchant(q: Queryable, id: string) { return one<MerchantRow>(q, "select * from merchants where id=$1", [id]); }

export async function previewRecovery(ctx: PlatformCtx, merchant: MerchantRow, body: RecoveryPreview) {
  const input = await normalize(ctx.db, merchant, body);
  const plan = await planFor(ctx.db, merchant, input);
  const { outcome, approvable, summary, ...rest } = plan.body;
  return { object: "recovery_preview", persisted: false, outcome, approvable: false, approvable_after_create: approvable, summary, ...rest };
}

export async function createRecovery(ctx: PlatformCtx, merchant: MerchantRow, body: RecoveryCreate) {
  const input = await normalize(ctx.db, merchant, body);
  const id = await withTx(ctx.db, async (tx) => {
    const m = await one<MerchantRow>(tx, "select * from merchants where id=$1 for share", [merchant.id]);
    const plan = await planFor(tx, m, input);
    const now = clock.now();
    const r = await one<RecoveryRow>(tx, `insert into recoveries(id,merchant_id,external_order_id,status,currency,requirements,original_items,shipping_cents,unavailable_items,fulfillment,buyer_reference,metadata,created_at,updated_at)
      values ($1,$2,$3,'action_required',$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) returning *`,
      [newId("rec"), m.id, body.external_order_id, input.currency, JSON.stringify(input.requirements), JSON.stringify(input.original_items), input.shipping_cents, JSON.stringify(input.unavailable_items), input.fulfillment ? JSON.stringify(input.fulfillment) : null, body.buyer_reference ?? null, body.metadata ? JSON.stringify(body.metadata) : null, now]);
    await emitEvent(tx, m, "recovery.created", { recovery_id: r.id, external_order_id: r.external_order_id });
    await storeProposal(tx, m, r, plan, "proposal.created", "recovery_created");
    return r.id;
  });
  return getRecovery(ctx, merchant, id);
}

/** A proposal is due to expire when it is still awaiting a decision, or approved but never executed, past its expiry. */
const DUE_SQL = `p.expires_at <= $2 and (p.status = 'active' or (p.status = 'approved' and r.status = 'approved' and r.current_proposal_id = p.id))`;

/**
 * Proposals past their expiry stop being approvable or executable. An approved version that was never executed expires
 * too: its approval no longer applies, and the recovery waits for a recompute, the buyer's refresh, or cancellation.
 * A version with a pending or unknown execution is left alone so the merchant can still reconcile it.
 */
async function expireIfDue(ctx: PlatformCtx, merchantId: string, recoveryId: string) {
  const due = await maybeOne(ctx.db, `select 1 from proposals p join recoveries r on r.id = p.recovery_id where p.recovery_id = $1 and ${DUE_SQL}`, [recoveryId, clock.now()]);
  if (!due) return;
  await withTx(ctx.db, async (tx) => {
    const r = await lockRecovery(tx, merchantId, recoveryId);
    if (await maybeOne(tx, "select 1 from executions where recovery_id=$1 and status in ('pending','unknown')", [r.id])) return;
    const p = await maybeOne<ProposalRow>(tx, `update proposals p set status = 'expired' from recoveries r where r.id = p.recovery_id and p.recovery_id = $1 and ${DUE_SQL} returning p.*`, [recoveryId, clock.now()]);
    if (!p) return;
    const wasApproved = r.status === "approved";
    const status: RecoveryStatus = wasApproved || OPEN_FOR_PLANNING.includes(r.status) ? "expired" : r.status;
    await tx.query("update recoveries set status=$2, updated_at=$3 where id=$1", [r.id, status, clock.now()]);
    await emitEvent(tx, await freshMerchant(tx, merchantId), "proposal.expired", { recovery_id: r.id, external_order_id: r.external_order_id, status, previous_status: r.status, approval_invalidated: wasApproved, proposal: { id: p.id, version: p.version } });
  });
}

export async function getRecovery(ctx: PlatformCtx, merchant: Pick<MerchantRow, "id">, id: string): Promise<RecoveryView> {
  await expireIfDue(ctx, merchant.id, id);
  const r = await maybeOne<RecoveryRow>(ctx.db, "select * from recoveries where id=$1 and merchant_id=$2", [id, merchant.id]);
  if (!r) throw new ApiError("not_found", "recovery_not_found", "No recovery with this ID for this merchant.");
  return recoveryView(ctx.db, r);
}

export async function listRecoveries(ctx: PlatformCtx, merchant: MerchantRow, a: { status?: string | undefined; external_order_id?: string | undefined; limit: number; before?: string | undefined }) {
  const cursor = a.before ? await maybeOne<{ created_at: Date; id: string }>(ctx.db, "select created_at, id from recoveries where id=$1 and merchant_id=$2", [a.before, merchant.id]) : null;
  if (a.before && !cursor) throw new ApiError("invalid_request", "invalid_cursor", "`before` must be the id of a recovery from an earlier page.");
  // Composite (created_at, id) cursor: recoveries created in the same millisecond are neither skipped nor repeated.
  const rows = await many<RecoveryRow>(ctx.db, `select * from recoveries where merchant_id=$1 and ($2::text is null or status=$2) and ($3::text is null or external_order_id=$3)
    and ($4::timestamptz is null or (created_at, id) < ($4::timestamptz, $5::text)) order by created_at desc, id desc limit $6`,
    [merchant.id, a.status ?? null, a.external_order_id ?? null, cursor?.created_at ?? null, cursor?.id ?? null, a.limit + 1]);
  const page = rows.slice(0, a.limit);
  const data = [];
  for (const r of page) data.push(await recoveryView(ctx.db, r));
  return { data, has_more: rows.length > a.limit, next_before: page.length ? page[page.length - 1]!.id : null };
}

export async function listProposals(ctx: PlatformCtx, merchant: MerchantRow, recoveryId: string) {
  await getRecovery(ctx, merchant, recoveryId);
  const rows = await many<ProposalRow>(ctx.db, "select * from proposals where recovery_id=$1 and merchant_id=$2 order by version desc", [recoveryId, merchant.id]);
  return { data: rows.map(proposalView) };
}

/**
 * Re-plan an open recovery. A new version is stored only when the plan changed (or the current one expired),
 * so repeated stock syncs without effect do not churn proposals.
 */
export async function replan(ctx: PlatformCtx, merchantId: string, recoveryId: string, reason: string, opts: { requirements?: Requirements; actor?: "merchant" | "buyer"; force?: boolean } = {}) {
  return withTx(ctx.db, async (tx) => {
    const r = await lockRecovery(tx, merchantId, recoveryId);
    if (!OPEN_FOR_PLANNING.includes(r.status)) {
      if (opts.requirements || opts.force) throw new ApiError("conflict", "recovery_not_open", `This recovery is ${r.status}; it can no longer be re-planned.`, { status: r.status });
      return { changed: false, status: r.status };
    }
    const m = await freshMerchant(tx, merchantId);
    if (opts.requirements) {
      if (opts.requirements.budget && opts.requirements.budget.currency !== r.currency) throw new ApiError("invalid_request", "currency_mismatch", "requirements.budget.currency must equal the order currency.");
      assertTimezone(opts.requirements.timezone);
      if (opts.requirements.needed_by && !r.fulfillment?.ready_at) throw new ApiError("invalid_request", "ready_at_required", "needed_by needs the recovery's fulfillment.ready_at.");
      r.requirements = opts.requirements;
      await tx.query("update recoveries set requirements=$2, updated_at=$3 where id=$1", [r.id, JSON.stringify(opts.requirements), clock.now()]);
      await emitEvent(tx, m, "recovery.requirements_updated", { recovery_id: r.id, external_order_id: r.external_order_id, actor: opts.actor ?? "merchant", requirements: opts.requirements });
    }
    const plan = await planFor(tx, m, inputOf(r));
    const current = r.current_proposal_id ? await maybeOne<ProposalRow>(tx, "select * from proposals where id=$1", [r.current_proposal_id]) : null;
    const unchanged = current && current.status === "active" && current.plan_signature === plan.signature && current.expires_at > clock.now();
    if (unchanged) return { changed: false, status: r.status };
    await storeProposal(tx, m, r, plan, current ? "proposal.revised" : "proposal.created", reason);
    return { changed: true, status: statusFor(plan.outcome) };
  });
}

/** After a catalog or stock change: re-plan every open recovery of the merchant (worker job). */
export async function revalidateOpenRecoveries(ctx: PlatformCtx, merchantId: string, reason: string) {
  const open = await many<{ id: string }>(ctx.db, "select id from recoveries where merchant_id=$1 and status = any($2) order by created_at limit 200", [merchantId, OPEN_FOR_PLANNING]);
  let revised = 0;
  for (const r of open) if ((await replan(ctx, merchantId, r.id, reason)).changed) revised++;
  return { checked: open.length, revised };
}

export async function cancelRecovery(ctx: PlatformCtx, merchant: MerchantRow, id: string) {
  await withTx(ctx.db, async (tx) => {
    const r = await lockRecovery(tx, merchant.id, id);
    if (r.status === "cancelled") return;
    if (["executing", "reconciling", "completed"].includes(r.status)) throw new ApiError("conflict", "execution_exists", `This recovery is ${r.status}; acknowledge or reconcile the execution instead of cancelling.`, { status: r.status });
    await tx.query("update proposals set status='superseded' where recovery_id=$1 and status='active'", [r.id]);
    await tx.query("update recoveries set status='cancelled', updated_at=$2 where id=$1", [r.id, clock.now()]);
    await emitEvent(tx, merchant, "recovery.cancelled", { recovery_id: r.id, external_order_id: r.external_order_id, previous_status: r.status });
  });
  return getRecovery(ctx, merchant, id);
}

// ---------- buyer review links and decisions ----------

export async function createReviewLink(ctx: PlatformCtx, merchant: MerchantRow, recoveryId: string, expiresInMinutes: number) {
  const r = await getRecovery(ctx, merchant, recoveryId);
  if (["cancelled", "completed"].includes(r.status)) throw new ApiError("conflict", "recovery_closed", `This recovery is ${r.status}.`);
  const token = newSecret("rvw");
  const id = newId("rvl");
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + expiresInMinutes * 60_000);
  await ctx.db.query("insert into review_links(id,merchant_id,recovery_id,token_hash,created_at,expires_at) values ($1,$2,$3,$4,$5,$6)", [id, merchant.id, recoveryId, sha256(token), now, expiresAt]);
  return { id, url: `${ctx.cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/review/${token}`, token, recovery_id: recoveryId, expires_at: expiresAt.toISOString(), note: "Give this link only to the buyer. It shows the current proposal and is the only place the buyer can approve it." };
}

async function linkFor(ctx: PlatformCtx, token: string) {
  const link = /^rvw_[A-Za-z0-9_-]{32}$/.test(token) ? await maybeOne<{ id: string; merchant_id: string; recovery_id: string; expires_at: Date; revoked_at: Date | null; first_opened_at: Date | null }>(ctx.db, "select * from review_links where token_hash=$1", [sha256(token)]) : null;
  if (!link || link.revoked_at) throw new ApiError("not_found", "review_link_not_found", "This review link is not valid. Ask the store for a new one.");
  if (link.expires_at <= clock.now()) throw new ApiError("gone", "review_link_expired", "This review link has expired. Ask the store for a new one.");
  return link;
}

/** The buyer's view: the current proposal, what changed and why, the money difference, and the allowed decisions. */
export async function reviewView(ctx: PlatformCtx, token: string) {
  const link = await linkFor(ctx, token);
  await ctx.db.query("update review_links set first_opened_at=coalesce(first_opened_at,$2) where id=$1", [link.id, clock.now()]);
  const m = await freshMerchant(ctx.db, link.merchant_id);
  const r = await getRecovery(ctx, m, link.recovery_id);
  const p = r.proposal;
  const decisions: string[] = [];
  if (r.status === "awaiting_buyer" && p?.status === "active") {
    if (p.outcome === "proposal_ready") decisions.push("approve", "decline");
    if (p.outcome === "budget_conflict") decisions.push("raise_budget", "decline");
    if (p.outcome === "deadline_conflict") decisions.push("accept_later_time", "decline");
  }
  return {
    merchant: { name: m.name, kind: m.kind }, external_order_id: r.external_order_id, status: r.status, next_action: r.next_action,
    currency: r.currency, requirements: r.requirements, proposal: p, decisions, link_expires_at: link.expires_at.toISOString(),
    execution: r.latest_execution ? { status: r.latest_execution.status } : null,
    boundary: `Approving records your consent to this exact version. ${m.name} then updates your order and settles any price difference through its own checkout; ReCart reserves no stock and moves no money for this order.`,
  };
}

async function currentProposalForDecision(tx: Tx, r: RecoveryRow, proposalId: string, hash?: string) {
  const p = r.current_proposal_id ? await maybeOne<ProposalRow>(tx, "select * from proposals where id=$1 for update", [r.current_proposal_id]) : null;
  if (!p || p.id !== proposalId) throw new ApiError("conflict", "proposal_superseded", "A newer version of this proposal exists. Review the current version.", { current_proposal_id: p?.id ?? null });
  if (p.status === "expired" || p.expires_at <= clock.now()) throw new ApiError("gone", "proposal_expired", "This proposal has expired. The store must recompute it.");
  if (p.status !== "active") throw new ApiError("conflict", "proposal_decided", `This proposal is already ${p.status}.`, { status: p.status });
  if (hash !== undefined && p.hash !== hash) throw new ApiError("conflict", "proposal_hash_mismatch", "The proposal you saw differs from the stored version. Reload and review it again.");
  return p;
}

export async function buyerDecision(ctx: PlatformCtx, token: string, d: { proposal_id: string; proposal_hash: string; decision: "approve" | "decline" }) {
  const link = await linkFor(ctx, token);
  await expireIfDue(ctx, link.merchant_id, link.recovery_id);
  const before = await one<RecoveryRow>(ctx.db, "select * from recoveries where id=$1", [link.recovery_id]);
  if (before.status === "expired") throw new ApiError("gone", "proposal_expired", "This proposal has expired. Refresh it to see current options.");
  if (before.status !== "awaiting_buyer") throw new ApiError("conflict", "recovery_not_awaiting_buyer", `This recovery is ${before.status}.`, { status: before.status });
  if (before.current_proposal_id !== d.proposal_id) throw new ApiError("conflict", "proposal_superseded", "A newer version of this proposal exists. Review the current version.", { current_proposal_id: before.current_proposal_id });
  if (d.decision === "approve") {
    // Approval is only recorded for a plan that is still current: re-plan first; a changed plan becomes a new version to review.
    const re = await replan(ctx, link.merchant_id, link.recovery_id, "revalidated_before_approval");
    if (re.changed) throw new ApiError("conflict", "proposal_superseded", "Stock or prices changed, so ReCart revised the proposal. Review the new version.", { revised: true });
  }
  await withTx(ctx.db, async (tx) => {
    const r = await lockRecovery(tx, link.merchant_id, link.recovery_id);
    if (r.status !== "awaiting_buyer") throw new ApiError("conflict", "recovery_not_awaiting_buyer", `This recovery is ${r.status}.`, { status: r.status });
    const p = await currentProposalForDecision(tx, r, d.proposal_id, d.proposal_hash);
    if (d.decision === "approve" && !p.approvable) throw new ApiError("conflict", "proposal_not_approvable", "This proposal needs a decision about its requirements before it can be approved.");
    const now = clock.now();
    const decision = d.decision === "approve" ? "approved" : "declined";
    await tx.query("insert into approvals(id,merchant_id,recovery_id,proposal_id,proposal_version,proposal_hash,decision,review_link_id,decided_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [newId("apr"), link.merchant_id, r.id, p.id, p.version, p.hash, decision, link.id, now]);
    await tx.query("update proposals set status=$2, decided_at=$3 where id=$1", [p.id, decision, now]);
    await tx.query("update recoveries set status=$2, updated_at=$3 where id=$1", [r.id, decision, now]);
    const m = await freshMerchant(tx, link.merchant_id);
    await emitEvent(tx, m, decision === "approved" ? "proposal.approved" : "proposal.declined", { recovery_id: r.id, external_order_id: r.external_order_id, status: decision, decided_at: now.toISOString(), proposal: proposalView({ ...p, status: decision, decided_at: now }) });
  });
  return reviewView(ctx, token);
}

/** An expired proposal can be refreshed from the review page; the new version keeps every requirement as confirmed. */
export async function buyerRefresh(ctx: PlatformCtx, token: string) {
  const link = await linkFor(ctx, token);
  await expireIfDue(ctx, link.merchant_id, link.recovery_id);
  const r = await one<RecoveryRow>(ctx.db, "select status from recoveries where id=$1", [link.recovery_id]);
  if (r.status !== "expired") throw new ApiError("conflict", "nothing_to_refresh", "This proposal is still current.", { status: r.status });
  await replan(ctx, link.merchant_id, link.recovery_id, "buyer_requested_refresh", { force: true });
  return reviewView(ctx, token);
}

/** The buyer, and only the buyer, may raise the limit or accept a later time; ReCart then re-plans. */
export async function buyerChangeRequirement(ctx: PlatformCtx, token: string, change: { proposal_id: string } & ({ kind: "budget"; max_total_cents: number } | { kind: "accept_later_time" })) {
  const link = await linkFor(ctx, token);
  const r = await one<RecoveryRow>(ctx.db, "select * from recoveries where id=$1", [link.recovery_id]);
  if (r.status !== "awaiting_buyer") throw new ApiError("conflict", "recovery_not_awaiting_buyer", `This recovery is ${r.status}.`, { status: r.status });
  const p = await withTx(ctx.db, (tx) => currentProposalForDecision(tx, r, change.proposal_id));
  const req: Requirements = { ...r.requirements };
  if (change.kind === "budget") req.budget = { max_total_cents: change.max_total_cents, currency: r.currency };
  else {
    const c = p.body.conflict as any;
    if (!c?.earliest_ready_at) throw new ApiError("conflict", "no_time_conflict", "This proposal has no timing conflict to accept.");
    req.needed_by = c.earliest_ready_at;
  }
  await replan(ctx, link.merchant_id, link.recovery_id, change.kind === "budget" ? "buyer_changed_budget" : "buyer_accepted_later_time", { requirements: req, actor: "buyer" });
  return reviewView(ctx, token);
}

// ---------- execution (merchant applies an approved version in its own system) ----------

export async function startExecution(ctx: PlatformCtx, merchant: MerchantRow, recoveryId: string, a: { proposal_id: string; proposal_hash: string }) {
  await expireIfDue(ctx, merchant.id, recoveryId);
  const outcome = await withTx(ctx.db, async (tx) => {
    const r = await lockRecovery(tx, merchant.id, recoveryId);
    const open = await maybeOne<ExecutionRow>(tx, "select * from executions where recovery_id=$1 and status in ('pending','unknown')", [r.id]);
    if (open?.status === "unknown") throw new ApiError("conflict", "execution_unresolved", `Execution ${open.id} has an unknown outcome. Reconcile it in your system and acknowledge succeeded or failed before retrying.`, { execution_id: open.id });
    if (open) throw new ApiError("conflict", "execution_in_progress", `Execution ${open.id} is in progress. Acknowledge its outcome first.`, { execution_id: open.id });
    if (r.status === "expired") throw new ApiError("gone", "proposal_expired", "The approved version expired before execution, so its approval no longer applies. Recompute (or let the buyer refresh the review page) and ask the buyer to approve the new version.");
    if (r.status !== "approved") throw new ApiError("conflict", "not_approved", `Only an approved recovery can be executed; this one is ${r.status}.`, { status: r.status });
    const p = await one<ProposalRow>(tx, "select * from proposals where id=$1", [r.current_proposal_id]);
    if (p.id !== a.proposal_id || p.status !== "approved") throw new ApiError("conflict", "proposal_not_approved", "Execute the approved proposal returned by GET /v1/recoveries/{id}.", { approved_proposal_id: p.status === "approved" ? p.id : null });
    if (p.hash !== a.proposal_hash) throw new ApiError("conflict", "proposal_hash_mismatch", "proposal_hash does not match the approved version.");
    const now = clock.now();
    if (p.expires_at <= now) throw new ApiError("gone", "proposal_expired", "The approved proposal expired before execution. Recompute and ask the buyer again.");
    const m = await freshMerchant(tx, merchant.id);
    const repl = p.body.replacement as any;
    const [products, stock] = await Promise.all([loadProducts(tx, m.id), loadStock(tx, m, r.fulfillment?.location_ids)]);
    const check = revalidateApproved(inputOf(r), { merchant: m, products, stock, now }, { recipeId: repl.recipe.id, items: repl.items, itemsAndTaxCents: repl.totals.items_cents + repl.totals.tax_cents });
    if (!check.ok) {
      // The approved version can no longer be fulfilled as approved: plan again and send the buyer back to review.
      const plan = planRecovery(inputOf(r), { merchant: m, products, stock, now });
      await tx.query("update recoveries set status='awaiting_buyer' where id=$1", [r.id]);
      const newId_ = await storeProposal(tx, m, { ...r, status: "awaiting_buyer" }, plan, "proposal.revised", "approved_version_no_longer_valid");
      return { invalidated: true as const, failed: check.failed, proposal_id: newId_ };
    }
    const e = await one<ExecutionRow>(tx, `insert into executions(id,merchant_id,recovery_id,proposal_id,proposal_hash,status,valid_until,created_at,updated_at)
      values ($1,$2,$3,$4,$5,'pending',$6,$7,$7) returning *`, [newId("exe"), m.id, r.id, p.id, p.hash, new Date(Math.min(p.expires_at.getTime(), now.getTime() + 15 * 60_000)), now]);
    await tx.query("update recoveries set status='executing', updated_at=$2 where id=$1", [r.id, now]);
    await emitEvent(tx, m, "execution.started", { recovery_id: r.id, external_order_id: r.external_order_id, execution: executionView(e), proposal: { id: p.id, version: p.version, hash: p.hash } });
    return { invalidated: false as const, execution: e, proposal: p };
  });
  if (outcome.invalidated) throw new ApiError("conflict", "proposal_invalidated", "The approved items no longer pass every check with current stock and prices. ReCart created a revised proposal for the buyer to review.", { failed_checks: outcome.failed, revised_proposal_id: outcome.proposal_id });
  return { execution: executionView(outcome.execution), apply: { proposal_id: outcome.proposal.id, items: (outcome.proposal.body.replacement as any).items, removed_items: (outcome.proposal.body.replacement as any).removed_items, totals: (outcome.proposal.body.replacement as any).totals, difference_cents: (outcome.proposal.body.replacement as any).difference_cents }, recovery: await getRecovery(ctx, merchant, recoveryId) };
}

export async function acknowledgeExecution(ctx: PlatformCtx, merchant: MerchantRow, recoveryId: string, executionId: string, a: { outcome: "succeeded" | "failed" | "unknown"; external_reference?: string | undefined; message?: string | undefined }) {
  await withTx(ctx.db, async (tx) => {
    const r = await lockRecovery(tx, merchant.id, recoveryId);
    const e = await maybeOne<ExecutionRow>(tx, "select * from executions where id=$1 and recovery_id=$2 for update", [executionId, r.id]);
    if (!e) throw new ApiError("not_found", "execution_not_found", "No such execution for this recovery.");
    if (e.status === a.outcome) return; // repeated acknowledgement: no change
    if (e.status === "succeeded" || e.status === "failed") throw new ApiError("conflict", "execution_already_resolved", `Execution ${e.id} was already acknowledged as ${e.status}.`, { status: e.status });
    if (e.status === "unknown" && a.outcome === "unknown") return;
    const now = clock.now();
    await tx.query("update executions set status=$2, external_reference=coalesce($3, external_reference), message=coalesce($4, message), acknowledged_at=$5, updated_at=$5 where id=$1", [e.id, a.outcome, a.external_reference ?? null, a.message ?? null, now]);
    const status: RecoveryStatus = a.outcome === "succeeded" ? "completed" : a.outcome === "failed" ? "approved" : "reconciling";
    await tx.query("update recoveries set status=$2, updated_at=$3 where id=$1", [r.id, status, now]);
    const m = await freshMerchant(tx, merchant.id);
    await emitEvent(tx, m, `execution.${a.outcome}` as EventType, { recovery_id: r.id, external_order_id: r.external_order_id, status, execution: executionView({ ...e, status: a.outcome, external_reference: a.external_reference ?? e.external_reference, message: a.message ?? e.message, acknowledged_at: now }) });
  });
  return getRecovery(ctx, merchant, recoveryId);
}

/** Periodic housekeeping: expire due proposals (with events), purge expired idempotency records and old sandbox merchants. */
export async function platformMaintenance(ctx: PlatformCtx) {
  const due = await many<{ merchant_id: string; recovery_id: string }>(ctx.db, `select p.merchant_id, p.recovery_id from proposals p join recoveries r on r.id = p.recovery_id where ${DUE_SQL.replaceAll("$2", "$1")} limit 500`, [clock.now()]);
  for (const d of due) await expireIfDue(ctx, d.merchant_id, d.recovery_id);
  await ctx.db.query("delete from idempotency_records where created_at < $1", [new Date(clock.now().getTime() - 24 * 3600_000)]);
  const gone = await ctx.db.query("delete from merchants where kind='sandbox' and expires_at < $1", [new Date(clock.now().getTime() - 24 * 3600_000)]);
  return { expired: due.length, sandbox_merchants_removed: gone.rowCount ?? 0 };
}
