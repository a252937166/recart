import { RECIPES, RECIPES_VERSION } from "../domain/catalog/fixtures.js";
import type { CatalogSnapshot, ConfirmedGoal, Variant } from "../domain/catalog/types.js";
import { taxCents } from "../domain/money.js";
import { RANKING_VERSION, SOLVER_VERSION, itemOnlySwaps, revalidateLines, solve, type Bundle, type CheckResult, type SolveResult } from "../domain/solver/solver.js";
import { formatInZone, type PickupWindow } from "../domain/time.js";
import { FAILURE_PHRASE } from "../server/services/explain.js";
import { canonicalJson, sha256 } from "./core.js";
import type { ProductRow, StockRow } from "./catalog.js";
import type { MerchantRow } from "./merchants.js";
import { API_ROLES, ATTRIBUTE_KEYS, evidenceToApi, PACK_ID, REQUIREMENT_FIELDS, requirementsToGoal, toVariant, type ApiRequirements, type ApiRole } from "./pack.js";

/**
 * Recovery planning for merchant orders. It translates the merchant's catalog, stock and the buyer's confirmed
 * requirements into the solver's terms, runs the same exhaustive search the hosted demo uses, and describes the
 * result as a typed outcome. Business outcomes (no solution, budget conflict) are results, never errors.
 */
export const OUTCOMES = ["proposal_ready", "no_change_needed", "budget_conflict", "deadline_conflict", "no_supported_bundle", "evidence_incomplete", "needs_clarification", "unsupported_requirements", "search_incomplete", "inventory_stale"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const UNAVAILABLE_REASONS = ["missing_at_packing", "damaged", "out_of_stock", "discontinued", "other"] as const;

export interface OrderLine { product_id: string; quantity: number; unit_price_cents: number; held_quantity: number }
export interface UnavailableLine { product_id: string; quantity: number; reason: (typeof UNAVAILABLE_REASONS)[number] }
export interface PlanInput {
  currency: string;
  requirements: ApiRequirements;
  original_items: OrderLine[];
  shipping_cents: number;
  unavailable_items: UnavailableLine[];
  fulfillment: { location_ids?: string[] | undefined; ready_at?: string | undefined } | null;
}
export interface PlanData { merchant: MerchantRow; products: Map<string, ProductRow>; stock: Map<string, StockRow>; now: Date }
export type ProposalBody = Record<string, unknown> & { outcome: Outcome; approvable: boolean; summary: string };
export interface PlanResult { outcome: Outcome; approvable: boolean; body: ProposalBody; signature: string }

export const money = (cents: number, currency: string) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
const REASON_PHRASE: Record<UnavailableLine["reason"], string> = {
  missing_at_packing: "could not be found when the order was packed", damaged: "was found damaged", out_of_stock: "is out of stock", discontinued: "is no longer sold", other: "is unavailable",
};
/** Swap reasons read from the merchant's and buyer's shared point of view (the hosted demo's phrases address the buyer). */
const SWAP_PHRASE: Record<string, string> = { ...FAILURE_PHRASE, BUDGET: "over the buyer's limit", OS_SUPPORT: "not supported on the buyer's operating system", PICKUP_DEADLINE: "not ready by the time the buyer needs it", HOST_CONNECTION: "the current cable does not fit its port" };
const UNKNOWN_PHRASE: Record<string, string> = { REMOTE_ROUTING: "loopback support is not documented", PHANTOM_POWER: "phantom power is not documented", HOST_CONNECTION: "its connectors are not documented", OS_SUPPORT: "operating-system support is not documented" };

function listNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
const attr = (p: ProductRow | undefined, key: string) => p?.attributes?.[key]?.value;

/** Everything the solver needs for one recovery, shared by planning and pre-execution revalidation. */
export function prepare(input: PlanInput, data: PlanData) {
  const { merchant, products, stock, now } = data;
  const goal = requirementsToGoal(input.requirements);
  const solverGoal: ConfirmedGoal = { ...goal, budgetCents: goal.budgetCents == null ? null : Math.max(0, goal.budgetCents - input.shipping_cents) };
  const agreed = new Map(input.original_items.map((i) => [i.product_id, i.unit_price_cents]));
  const held = new Map(input.original_items.map((i) => [i.product_id, i.held_quantity]));
  // Sellable products plus the order's own items (which may since have been archived). Items already in the order keep the agreed price.
  const variants: Variant[] = [];
  for (const p of products.values()) {
    if (p.status !== "active" && !agreed.has(p.product_id)) continue;
    const v = toVariant(p);
    variants.push(agreed.has(p.product_id) ? { ...v, priceCents: agreed.get(p.product_id)! } : v);
  }
  const snapshot: CatalogSnapshot = { version: `${merchant.id}@${merchant.catalog_version}`, currency: merchant.currency, taxRateBps: merchant.tax_rate_bps, variants };
  const availability: Record<string, number> = {};
  const withStale: Record<string, number> = {};
  for (const v of variants) {
    const sellable = products.get(v.sku)!.status === "active";
    const s = stock.get(v.sku);
    availability[v.sku] = (held.get(v.sku) ?? 0) + (sellable ? s?.fresh ?? 0 : 0);
    withStale[v.sku] = availability[v.sku]! + (sellable ? s?.stale ?? 0 : 0);
  }
  const readyAt = input.fulfillment?.ready_at ? new Date(input.fulfillment.ready_at).toISOString() : null;
  const pickup: PickupWindow = readyAt
    ? { start: readyAt, end: readyAt, timezone: goal.timezone, label: `Ready ${formatInZone(readyAt, goal.timezone)}` }
    : { start: now.toISOString(), end: now.toISOString(), timezone: goal.timezone, label: "Merchant fulfillment" };
  const original = input.original_items.map((i) => ({ sku: i.product_id, qty: i.quantity }));
  return { goal, solverGoal, snapshot, availability, withStale, pickup, original, readyAt };
}

/** The recipe the original order follows, used to show why replacing only the missing item does or does not work. */
function originalRecipe(goal: ConfirmedGoal, original: { sku: string; qty: number }[], snapshot: CatalogSnapshot): string | null {
  const byId = new Map(snapshot.variants.map((v) => [v.sku, v]));
  for (const r of RECIPES) {
    if (!r.covers(goal)) continue;
    const fits = original.every((l) => {
      const v = byId.get(l.sku);
      const spec = v && r.roles.find((s) => s.role === v.role);
      return !!v && !!spec && spec.select(v);
    });
    if (fits) return r.id;
  }
  return null;
}

export function planRecovery(input: PlanInput, data: PlanData): PlanResult {
  const { merchant, products, stock, now } = data;
  const currency = merchant.currency;
  const fmt = (c: number) => money(c, currency);
  const prep = prepare(input, data);
  const { goal, solverGoal, snapshot, availability, withStale, pickup, original } = prep;
  const shipping = input.shipping_cents;
  const name = (id: string) => products.get(id)?.name ?? id;
  const unavailableIds = new Set(input.unavailable_items.map((u) => u.product_id));

  const itemView = (productId: string, quantity: number, unitCents: number) => {
    const p = products.get(productId);
    return { product_id: productId, sku: p?.sku ?? null, name: p?.name ?? productId, role: (p?.role ?? null) as ApiRole | null, quantity, unit_price_cents: unitCents, line_total_cents: unitCents * quantity };
  };
  const originalItems = input.original_items.map((i) => itemView(i.product_id, i.quantity, i.unit_price_cents));
  const originalItemsCents = originalItems.reduce((s, i) => s + i.line_total_cents, 0);
  const originalTax = taxCents(originalItemsCents, merchant.tax_rate_bps);
  const originalTotals = { items_cents: originalItemsCents, shipping_cents: shipping, tax_cents: originalTax, total_cents: originalItemsCents + originalTax + shipping };

  const checksView = (checks: CheckResult[]) => checks.map((c) => ({ check: c.id, label: c.label, result: c.outcome, detail: c.detail, evidence: [...new Set(c.evidence.map(evidenceToApi))] }));
  const setupView = (b: Bundle) => {
    const origQty = new Map(input.original_items.map((i) => [i.product_id, i.quantity]));
    const items = b.lines.map((l) => {
      const before = origQty.get(l.sku);
      const p = products.get(l.sku);
      const relevant = p ? Object.keys(ATTRIBUTE_KEYS[p.role]) : [];
      const evidence = Object.fromEntries(relevant.filter((k) => p!.attributes[k]).map((k) => [k, p!.attributes[k]]));
      return { ...itemView(l.sku, l.qty, l.unitCents), change: before === undefined ? "added" : before === l.qty ? "kept" : "quantity_changed", ...(before !== undefined && before !== l.qty ? { previous_quantity: before } : {}), attributes: evidence };
    });
    const kept = new Set(b.lines.map((l) => l.sku));
    const removed = input.original_items.filter((i) => !kept.has(i.product_id)).map((i) => ({ ...itemView(i.product_id, i.quantity, i.unit_price_cents), reason: unavailableIds.has(i.product_id) ? "unavailable" : "replaced" }));
    const totals = { items_cents: b.subtotalCents, shipping_cents: shipping, tax_cents: b.taxCents, total_cents: b.totalCents + shipping };
    return {
      recipe: { id: b.recipeId, title: b.recipeTitle, version: b.recipeVersion }, items, removed_items: removed, totals,
      difference_cents: totals.total_cents - originalTotals.total_cents,
      budget: goal.budgetCents != null ? { max_total_cents: goal.budgetCents, remaining_cents: goal.budgetCents - totals.total_cents } : null,
      ready_at: prep.readyAt, compatibility: checksView(b.checks), setup_steps: b.setupSteps,
    };
  };

  const solveWith = (availabilityMap: Record<string, number>) => solve({ goal: solverGoal, catalog: snapshot, pickup, requireDeadline: false, availability: availabilityMap, now, original });
  const result: SolveResult = solveWith(availability);
  let outcome: Outcome;
  let chosen: Bundle | null = null;
  let conflict: Record<string, unknown> | null = null;
  let staleProducts: { product_id: string; name: string; available_if_counted: number; as_of: string | null }[] = [];
  const sameAsOriginal = (b: Bundle) => b.lines.length === original.length && original.every((o) => b.lines.some((l) => l.sku === o.sku && l.qty === o.qty));

  if (result.status === "NEEDS_CLARIFICATION") outcome = "needs_clarification";
  else if (result.status === "UNSUPPORTED_GOAL") outcome = "unsupported_requirements";
  else if (result.status === "SEARCH_INCOMPLETE") outcome = "search_incomplete";
  else if (result.status === "FEASIBLE") { chosen = result.candidates[0]!; outcome = sameAsOriginal(chosen) ? "no_change_needed" : "proposal_ready"; }
  else {
    // Would stock counts older than the freshness window make a setup possible? Then fresh counts are needed, not a verdict.
    const retry = snapshot.variants.some((v) => withStale[v.sku]! > availability[v.sku]!) ? solveWith(withStale) : null;
    if (retry?.status === "FEASIBLE") {
      outcome = "inventory_stale";
      staleProducts = retry.candidates[0]!.lines.filter((l) => availability[l.sku]! < l.qty).map((l) => ({ product_id: l.sku, name: l.name, available_if_counted: withStale[l.sku]!, as_of: stock.get(l.sku)?.newestAsOf?.toISOString() ?? null }));
    } else if (result.status === "EVIDENCE_INCOMPLETE") outcome = "evidence_incomplete";
    else if (result.nearMisses.length) {
      const n = result.nearMisses[0]!;
      const needsBudget = n.requires.budgetCents !== undefined;
      outcome = needsBudget ? "budget_conflict" : "deadline_conflict";
      conflict = {
        type: needsBudget && n.requires.pickupBy ? "budget_and_deadline" : needsBudget ? "budget" : "deadline",
        ...(needsBudget ? { required_max_total_cents: n.requires.budgetCents! + shipping, current_max_total_cents: goal.budgetCents } : {}),
        ...(n.requires.pickupBy ? { earliest_ready_at: n.requires.pickupBy, needed_by: goal.pickupBy } : {}),
        closest: setupView(n.bundle),
      };
    } else outcome = "no_supported_bundle";
  }

  const roleOf = (id: string) => products.get(id)?.role;
  const reverseKey = (role: ApiRole | undefined, internal: string) => (role ? Object.entries(ATTRIBUTE_KEYS[role]).find(([, v]) => v === internal)?.[0] : undefined) ?? internal;
  const unknownFacts = outcome === "evidence_incomplete" ? result.unknownFacts.map((u) => ({ product_id: u.sku, name: name(u.sku), attribute: reverseKey(roleOf(u.sku), u.fact), check: u.check })) : [];
  const missingFields = result.missingFields.map((f) => REQUIREMENT_FIELDS[f] ?? f);

  // Single-item swaps: replace only the unavailable product and keep everything else, under the same checks.
  const recipeId = originalRecipe(solverGoal, original, snapshot);
  const swaps = recipeId && outcome !== "needs_clarification" && outcome !== "unsupported_requirements"
    ? input.unavailable_items.flatMap((u) => itemOnlySwaps(solverGoal, recipeId, original, u.product_id, availability, pickup, snapshot).map((s) => ({
        replaces: u.product_id, product_id: s.sku, name: s.name, works: s.ok, total_cents: s.ok ? s.totalCents + shipping : null,
        reasons: s.failed.map((f) => (f.outcome === "unknown" ? UNKNOWN_PHRASE[f.id] ?? "a required fact is not documented" : SWAP_PHRASE[f.id] ?? f.label.toLowerCase())),
      })))
    : [];

  const blockers = blockingReasons(result);
  const replacement = chosen ? setupView(chosen) : null;
  const changes = replacement ? changesByRole(input, replacement.items, products, unavailableIds) : [];
  const unavailableText = listNames(input.unavailable_items.map((u) => `the ${name(u.product_id)}`));
  const reasonText = input.unavailable_items.length === 1 ? REASON_PHRASE[input.unavailable_items[0]!.reason] : "are unavailable";
  const opening = `${capitalize(unavailableText)} ${reasonText}.`;
  let summary: string;
  switch (outcome) {
    case "proposal_ready": {
      const r = replacement!;
      const added = r.items.filter((i) => i.change !== "kept").map((i) => (i.quantity > 1 ? `${i.quantity}× ${i.name}` : `the ${i.name}`));
      const removed = r.removed_items.map((i) => (i.quantity > 1 ? `${i.quantity}× ${i.name}` : `the ${i.name}`));
      const swapLine = swaps.length && !swaps.some((s) => s.works) ? " Replacing only that item fails with every in-stock alternative, so connected parts change too." : "";
      const diff = r.difference_cents;
      summary = `${opening}${swapLine} The proposed setup uses ${listNames(added)}${removed.length ? ` in place of ${listNames(removed)}` : ""}. The new total is ${fmt(r.totals.total_cents)}, ${diff === 0 ? "the same as" : `${fmt(Math.abs(diff))} ${diff > 0 ? "more" : "less"} than`} the original order${r.budget ? `, within the buyer's ${fmt(r.budget.max_total_cents)} limit` : ""}.`;
      break;
    }
    case "no_change_needed": summary = `${opening} Enough stock is available to fulfil the original items, so no change is needed.`; break;
    case "budget_conflict": case "deadline_conflict": {
      const c = conflict as any;
      const parts: string[] = [];
      if (c.required_max_total_cents !== undefined) parts.push(`a limit of at least ${fmt(c.required_max_total_cents)} (the buyer's limit is ${fmt(c.current_max_total_cents)})`);
      if (c.earliest_ready_at) parts.push(`readiness by ${formatInZone(c.earliest_ready_at, goal.timezone)}, later than the buyer needs it`);
      summary = `${opening} No complete setup meets every requirement. The closest one costs ${fmt(c.closest.totals.total_cents)} and needs ${parts.join(" and ")}. ReCart never relaxes a requirement; only the buyer can.`;
      break;
    }
    case "no_supported_bundle": summary = `${opening} ReCart checked ${result.combinationsChecked} combinations of sellable products against every supported setup, and none meets all the requirements.${blockers[0] ? ` ${capitalize(blockers[0])}.` : ""}`; break;
    case "evidence_incomplete": summary = `${opening} Some setups would work only if undocumented facts hold (${listNames(unknownFacts.map((u) => `${u.name}: ${u.attribute}`))}). ReCart will not propose them until the facts are documented.`; break;
    case "needs_clarification": summary = `ReCart needs ${listNames(missingFields)} before it can plan a replacement.`; break;
    case "unsupported_requirements": summary = `These requirements are outside the setups the ${PACK_ID} domain pack supports.`; break;
    case "search_incomplete": summary = "The search stopped at its work limit before covering every combination, so ReCart reports no conclusion."; break;
    case "inventory_stale": summary = `${opening} A setup is possible only with stock counts older than ${Math.round(merchant.inventory_max_age_seconds / 3600)} hours (${listNames(staleProducts.map((s) => s.name))}). Send fresh counts and ReCart recomputes.`; break;
  }

  const body: ProposalBody = {
    outcome, approvable: outcome === "proposal_ready", summary, domain: PACK_ID, currency,
    original: { items: originalItems, totals: originalTotals },
    unavailable_items: input.unavailable_items.map((u) => ({ ...u, name: name(u.product_id) })),
    replacement, changes, single_item_swaps: swaps, conflict,
    missing_fields: missingFields, unknown_facts: unknownFacts, stale_products: staleProducts,
    search: { combinations_checked: result.combinationsChecked, feasible_count: result.feasibleCount, complete: result.searchComplete, duration_ms: result.durationMs, blocking_reasons: blockers },
    provenance: { catalog_version: merchant.catalog_version, recipes_version: RECIPES_VERSION, solver_version: SOLVER_VERSION, ranking_version: RANKING_VERSION, inventory_max_age_seconds: merchant.inventory_max_age_seconds, planned_at: now.toISOString() },
  };
  const signature = sha256(canonicalJson({
    outcome, requirements: input.requirements, shipping, ready_at: prep.readyAt,
    lines: chosen ? chosen.lines.map((l) => [l.sku, l.qty, l.unitCents]) : null,
    conflict: conflict ? [(conflict as any).type, (conflict as any).required_max_total_cents ?? null, (conflict as any).earliest_ready_at ?? null, (conflict as any).closest.items.map((i: any) => [i.product_id, i.quantity, i.unit_price_cents])] : null,
    missing: missingFields, unknown: unknownFacts.map((u) => [u.product_id, u.attribute]), stale: staleProducts.map((s) => s.product_id),
  }));
  return { outcome, approvable: outcome === "proposal_ready", body, signature };
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const BLOCKER: Record<string, string> = {
  AVAILABILITY: "a part is out of stock", BUDGET: "the total is over the buyer's limit", PICKUP_DEADLINE: "it is not ready in time", REMOTE_ROUTING: "the interface cannot route the room into the call",
  HOST_CONNECTION: "the parts cannot reach the buyer's computer port", MIC_INPUTS: "there are too few mic inputs", HEADPHONE_OUTPUTS: "there are too few headphone feeds",
  PHANTOM_POWER: "the mics need phantom power the interface lacks", OS_SUPPORT: "the buyer's operating system is not supported", NO_SUPERFLUOUS_ACCESSORY: "it includes an accessory the setup does not need",
};
/** Which single constraints rule out otherwise-complete setups, most decisive first (only when no setup passed). */
function blockingReasons(result: SolveResult): string[] {
  if (result.status !== "NO_FEASIBLE_SUPPORTED_BUNDLE" && result.status !== "EVIDENCE_INCOMPLETE") return [];
  return Object.entries(result.uniqueBlockers).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).slice(0, 3)
    .map(([id, n]) => `${n} otherwise-complete combination${n === 1 ? "" : "s"} fail${n === 1 ? "s" : ""} only because ${BLOCKER[id] ?? `of ${id.toLowerCase()}`}`);
}

/** What changed per role and why, stated from the new products' declared attributes. */
function changesByRole(input: PlanInput, items: { product_id: string; name: string; quantity: number; role: ApiRole | null }[], products: Map<string, ProductRow>, unavailableIds: Set<string>) {
  const out: { role: ApiRole; before: { product_id: string; name: string; quantity: number }[]; after: { product_id: string; name: string; quantity: number }[]; reason: string }[] = [];
  const brief = (id: string, quantity: number) => ({ product_id: id, name: products.get(id)?.name ?? id, quantity });
  for (const role of API_ROLES) {
    const before = input.original_items.filter((i) => products.get(i.product_id)?.role === role).map((i) => brief(i.product_id, i.quantity));
    const after = items.filter((i) => i.role === role).map((i) => brief(i.product_id, i.quantity));
    const key = (xs: { product_id: string; quantity: number }[]) => xs.map((x) => `${x.product_id}x${x.quantity}`).sort().join("|");
    if (key(before) === key(after)) continue;
    const lost = before.filter((b) => unavailableIds.has(b.product_id));
    const p = after[0] ? products.get(after[0].product_id) : undefined;
    let why: string;
    if (!after.length) why = "No longer needed in the new setup.";
    else if (role === "interface") why = `${p?.name} provides ${attr(p, "preamps")} mic inputs, ${attr(p, "headphone_outputs")} headphone outputs${attr(p, "loopback") === true ? ", loopback routing" : ""} and a ${String(attr(p, "host_port")).toUpperCase()} port.`;
    else if (role === "host_cable") why = `Connects the interface's ${String(attr(p, "device_end")).toUpperCase()} port to a ${String(attr(p, "host_end")).toUpperCase()} plug.`;
    else if (role === "adapter") why = `Turns the cable's ${String(attr(p, "from")).toUpperCase()} plug into ${String(attr(p, "to")).toUpperCase()} for the buyer's computer.`;
    else if (role === "splitter") why = "Adds headphone feeds because the interface has fewer outputs than people.";
    else if (role === "mic") why = "Matches the inputs of the new setup.";
    else why = "Completes the setup.";
    out.push({ role, before, after, reason: lost.length ? `Replaces the unavailable ${listNames(lost.map((l) => l.name))}. ${why}` : why });
  }
  return out;
}

/**
 * Before a merchant applies an approved proposal: do its exact items still pass every check, at the approved total,
 * with current sellable stock? Returns the failing checks when not.
 */
export function revalidateApproved(input: PlanInput, data: PlanData, approved: { recipeId: string; items: { product_id: string; quantity: number }[]; itemsAndTaxCents: number }) {
  const prep = prepare(input, data);
  const lines = approved.items.map((i) => ({ sku: i.product_id, qty: i.quantity }));
  const r = revalidateLines(prep.solverGoal, approved.recipeId, lines, prep.availability, prep.pickup, prep.snapshot);
  const failed = r.checks.filter((c) => c.outcome !== "pass").map((c) => ({ check: c.id, label: c.label, detail: c.detail }));
  if (r.ok && r.totalCents !== approved.itemsAndTaxCents) failed.push({ check: "BUDGET", label: "Approved total unchanged", detail: `Prices changed: the approved items now total ${r.totalCents} cents before shipping.` } as any);
  return { ok: failed.length === 0, failed };
}
