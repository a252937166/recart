import { CATALOG, FIXTURE_SNAPSHOT, RECIPES, RECIPES_VERSION } from "../catalog/fixtures.js";
import type { CatalogSnapshot, CheckId, ConfirmedGoal, EvidenceMode, Recipe, RoleSpec, Variant } from "../catalog/types.js";
import { HARD_FIELDS } from "../catalog/types.js";
import { taxCents } from "../money.js";
import { firstPickupWindow, PICKUP_POLICY, type PickupWindow } from "../time.js";

/**
 * ReCart's single exhaustive bundle solver (spec v1.2.1 §7).
 * Code owns feasibility and ranking; the language model never enumerates products or declares that
 * no solution exists. Every combination permitted by each covering recipe is checked directly.
 */
export const SOLVER_VERSION = "solver-v1";
export const RANKING_VERSION = "rank-v1";

export type SolveStatus = "FEASIBLE" | "NEEDS_CLARIFICATION" | "UNSUPPORTED_GOAL" | "EVIDENCE_INCOMPLETE" | "NO_FEASIBLE_SUPPORTED_BUNDLE" | "SEARCH_INCOMPLETE";

export interface BundleLine { role: RoleSpec["role"]; roleLabel: string; sku: string; name: string; qty: number; unitCents: number; lineCents: number }
export interface CheckResult { id: CheckId; label: string; outcome: "pass" | "fail" | "unknown"; detail: string; evidence: EvidenceMode[] }
export interface Bundle {
  recipeId: string; recipeVersion: string; recipeTitle: string;
  lines: BundleLine[]; subtotalCents: number; taxCents: number; totalCents: number;
  pickup: PickupWindow; checks: CheckResult[]; disruption: number; preferencePenalty: number;
  evidenceMode: EvidenceMode; rankKey: (string | number)[]; setupSteps: string[];
}
export interface NearMiss { bundle: Bundle; requires: { budgetCents?: number; pickupBy?: string }; summary: string }
export interface SolveResult {
  status: SolveStatus;
  candidates: Bundle[];
  nearMisses: NearMiss[];
  missingFields: string[];
  unknownFacts: { sku: string; fact: string; check: CheckId }[];
  exclusionCounts: Partial<Record<CheckId, number>>;
  uniqueBlockers: Partial<Record<CheckId, number>>;
  bindingExplanation: string[];
  combinationsChecked: number;
  feasibleCount: number;
  searchComplete: boolean;
  durationMs: number;
  versions: { catalog: string; recipes: string; solver: string; ranking: string; pickupPolicy: string };
}

export interface SolveInput {
  goal: ConfirmedGoal;
  /** Catalog to search; defaults to the versioned fixture catalog used by the hosted demo. */
  catalog?: CatalogSnapshot;
  /** When the goods can be handed over. Defaults to the fixture pickup policy's first window after `now`. */
  pickup?: PickupWindow;
  /** The hosted demo always needs a confirmed pickup deadline; merchant recoveries may have none. */
  requireDeadline?: boolean;
  /** Units this intent may use per SKU (ownership-aware; see inventory service). */
  availability: Record<string, number>;
  now: Date;
  /** Lines of the previously accepted bundle, for least-disruption ranking during recovery. */
  original?: { sku: string; qty: number }[];
  workCap?: number;
  timeGuardMs?: number;
  recipes?: Recipe[];
}

const CHECK_LABELS: Record<CheckId, string> = {
  TASK_COVERAGE: "Covers the confirmed recording task",
  MIC_INPUTS: "Enough mic inputs for everyone in the room",
  PHANTOM_POWER: "Phantom power where a mic needs it",
  HEADPHONE_OUTPUTS: "A headphone feed for each person in the room",
  REMOTE_ROUTING: "Remote guest routing for the chosen call app",
  HOST_CONNECTION: "Connects to the buyer's computer port",
  OS_SUPPORT: "Supported on the buyer's operating system",
  NO_SUPERFLUOUS_ACCESSORY: "No accessory the setup does not need",
  AVAILABILITY: "In stock for this purchase",
  PICKUP_DEADLINE: "Pickup completes before the deadline",
  BUDGET: "All-in total within the buyer's budget",
};

type Picked = { spec: RoleSpec; variant: Variant | null; qty: number };

function fact(variant: Variant | null, key: string): { value: unknown; evidence: EvidenceMode } {
  if (!variant) return { value: null, evidence: "UNKNOWN" };
  const f = variant.facts[key];
  if (!f) return { value: null, evidence: "UNKNOWN" };
  return { value: f.value, evidence: f.evidence };
}

function judge(id: CheckId, facts: { evidence: EvidenceMode }[], passes: () => boolean, detailPass: string, detailFail: string): CheckResult {
  const evidence = facts.map((f) => f.evidence);
  if (evidence.includes("CONTRADICTED")) return { id, label: CHECK_LABELS[id], outcome: "fail", detail: "Conflicting evidence: " + detailFail, evidence };
  if (evidence.includes("UNKNOWN")) return { id, label: CHECK_LABELS[id], outcome: "unknown", detail: "A critical fact is not documented.", evidence };
  return passes() ? { id, label: CHECK_LABELS[id], outcome: "pass", detail: detailPass, evidence } : { id, label: CHECK_LABELS[id], outcome: "fail", detail: detailFail, evidence };
}

function pass(id: CheckId, detail: string): CheckResult { return { id, label: CHECK_LABELS[id], outcome: "pass", detail, evidence: [] }; }
function fail(id: CheckId, detail: string): CheckResult { return { id, label: CHECK_LABELS[id], outcome: "fail", detail, evidence: [] }; }

/** Evaluate every hard constraint for one concrete combination. */
export function evaluateCombination(goal: ConfirmedGoal, recipe: Recipe, picked: Picked[], availability: Record<string, number>, pickup: PickupWindow, taxRateBps = 800): { checks: CheckResult[]; lines: BundleLine[]; subtotal: number; tax: number; total: number } {
  const by = (role: RoleSpec["role"]) => picked.find((p) => p.spec.role === role);
  const lines: BundleLine[] = picked.filter((p) => p.variant && p.qty > 0).map((p) => ({
    role: p.spec.role, roleLabel: p.spec.label, sku: p.variant!.sku, name: p.variant!.name, qty: p.qty, unitCents: p.variant!.priceCents, lineCents: p.variant!.priceCents * p.qty,
  }));
  const subtotal = lines.reduce((s, l) => s + l.lineCents, 0);
  const tax = taxCents(subtotal, taxRateBps);
  const total = subtotal + tax;
  const checks: CheckResult[] = [];
  const people = goal.localPeople ?? 0;
  checks.push(recipe.covers(goal) ? pass("TASK_COVERAGE", recipe.title) : fail("TASK_COVERAGE", "Outside this recipe's declared task"));

  const mic = by("mic")?.variant ?? null;
  const iface = by("interface")?.variant ?? null;
  const cable = by("hostCable")?.variant ?? null;
  const adapter = by("adapter")?.variant ?? null;
  const splitter = by("splitter")?.variant ?? null;

  if (recipe.id === "R-SOLO-REMOTE") {
    const out = fact(mic, "output");
    checks.push(judge("HOST_CONNECTION", [out], () => out.value === goal.hostPort, `USB-C mic plugs straight into the ${goal.hostPort} port`, `Mic output ${String(out.value)} does not match the ${goal.hostPort} port`));
    const jack = fact(mic, "monitorJack");
    checks.push(judge("HEADPHONE_OUTPUTS", [jack], () => jack.value === true, "Headphones plug into the mic's monitor jack", "No headphone feed for the host"));
    checks.push(goal.os && recipe.supportedOS.includes(goal.os) ? pass("OS_SUPPORT", `Declared for ${goal.os}`) : fail("OS_SUPPORT", `Not declared for ${goal.os ?? "unknown OS"}`));
    if ((goal.remoteGuests ?? 0) > 0) {
      const ok = !!recipe.remoteRouting && !!goal.callApp && recipe.remoteRouting.callApps.includes(goal.callApp);
      checks.push(ok ? pass("REMOTE_ROUTING", recipe.remoteRouting!.method) : fail("REMOTE_ROUTING", `Routing not declared for ${goal.callApp ?? "unknown call app"}`));
    }
  } else {
    const preamps = fact(iface, "preamps");
    checks.push(judge("MIC_INPUTS", [preamps], () => Number(preamps.value) >= people, `${preamps.value} preamps for ${people} mic(s)`, `${preamps.value} preamp(s) cannot take ${people} mics`));
    const needs = fact(mic, "needsPhantom");
    if (needs.evidence !== "UNKNOWN" && needs.value === false) checks.push(pass("PHANTOM_POWER", "Mics do not need phantom power"));
    else {
      const phantom = fact(iface, "phantom");
      checks.push(judge("PHANTOM_POWER", [needs, phantom], () => phantom.value === true, "Interface supplies 48 V phantom power", "Mic needs phantom power the interface lacks"));
    }
    const outs = fact(iface, "headphoneOuts");
    const splitOuts = splitter ? Number(fact(splitter, "outputs").value) - 1 : 0;
    checks.push(judge("HEADPHONE_OUTPUTS", [outs], () => Number(outs.value) + splitOuts >= people, `${Number(outs.value) + splitOuts} headphone feed(s) for ${people} people`, `${outs.value} headphone output(s) for ${people} people`));
    if ((goal.remoteGuests ?? 0) > 0) {
      const declared = !!recipe.remoteRouting && !!goal.callApp && recipe.remoteRouting.callApps.includes(goal.callApp);
      if (!declared) checks.push(fail("REMOTE_ROUTING", `Remote routing is not declared for ${goal.callApp ?? "an unknown call app"}`));
      else {
        const lb = fact(iface, "loopback");
        checks.push(judge("REMOTE_ROUTING", [lb], () => lb.value === true, `Loopback routing into ${goal.callApp}`, "Interface has no loopback, so the remote guest cannot hear the room mics"));
      }
    }
    const port = fact(iface, "hostPort");
    const dev = fact(cable, "deviceEnd");
    const host = fact(cable, "hostEnd");
    const from = fact(adapter, "from");
    const to = fact(adapter, "to");
    const hostFacts = adapter ? [port, dev, host, from, to] : [port, dev, host];
    checks.push(judge("HOST_CONNECTION", hostFacts, () => {
      if (port.value !== dev.value) return false;
      if (!adapter) return host.value === goal.hostPort;
      return from.value === host.value && to.value === goal.hostPort;
    }, adapter ? `${String(port.value)} → ${String(host.value)} cable → adapter → ${goal.hostPort}` : `${String(port.value)} → ${String(host.value)} cable`, `Cannot reach the ${goal.hostPort} port with this cable${adapter ? " and adapter" : ""}`));
    const osf = fact(iface, "os");
    checks.push(judge("OS_SUPPORT", [osf], () => !!goal.os && recipe.supportedOS.includes(goal.os) && Array.isArray(osf.value) && (osf.value as string[]).includes(goal.os), `Declared for ${goal.os}`, `Not declared for ${goal.os ?? "unknown OS"}`));
    // Minimality: optional accessories only when a check needs them.
    const adapterNeeded = host.value !== goal.hostPort;
    const splitterNeeded = Number(outs.value) < people;
    const superfluous = (adapter && !adapterNeeded) || (splitter && !splitterNeeded);
    checks.push(superfluous ? fail("NO_SUPERFLUOUS_ACCESSORY", `${adapter && !adapterNeeded ? "Adapter" : "Splitter"} is not needed`) : pass("NO_SUPERFLUOUS_ACCESSORY", "Only required accessories"));
  }

  const short = lines.filter((l) => (availability[l.sku] ?? 0) < l.qty);
  checks.push(short.length ? fail("AVAILABILITY", short.map((l) => `${l.sku}: need ${l.qty}, ${availability[l.sku] ?? 0} available`).join("; ")) : pass("AVAILABILITY", "All lines available"));
  if (goal.pickupBy) {
    const ok = new Date(pickup.end).getTime() <= new Date(goal.pickupBy).getTime();
    checks.push(ok ? pass("PICKUP_DEADLINE", `Pickup ${pickup.label}`) : fail("PICKUP_DEADLINE", `Earliest pickup ends ${pickup.end}, after the deadline`));
  }
  if (goal.budgetCents != null) checks.push(total <= goal.budgetCents ? pass("BUDGET", `Total within budget`) : fail("BUDGET", `Total exceeds budget by ${total - goal.budgetCents} cents`));
  return { checks, lines, subtotal, tax, total };
}

/** Catalog products a slot admits, in stable identity order (the order does not affect ranking). */
export function candidatesFor(spec: RoleSpec, catalog: CatalogSnapshot): Variant[] {
  return catalog.variants.filter(spec.select).sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
}

function* enumerate(goal: ConfirmedGoal, recipe: Recipe, catalog: CatalogSnapshot): Generator<Picked[]> {
  const specs = recipe.roles;
  const choices: Picked[][] = specs.map((spec) => {
    const options = candidatesFor(spec, catalog);
    if (spec.kind === "optional") return [{ spec, variant: null, qty: 0 }, ...options.map((variant) => ({ spec, variant, qty: spec.quantity(goal) }))];
    const q = spec.quantity(goal);
    if (q <= 0) return [{ spec, variant: null, qty: 0 }];
    return options.map((variant) => ({ spec, variant, qty: q }));
  });
  const idx = new Array(choices.length).fill(0);
  while (true) {
    yield choices.map((c, i) => c[idx[i]]!);
    let k = choices.length - 1;
    while (k >= 0) { idx[k]++; if (idx[k] < choices[k]!.length) break; idx[k] = 0; k--; }
    if (k < 0) return;
  }
}

function disruptionOf(lines: BundleLine[], original?: { sku: string; qty: number }[]): number {
  if (!original) return 0;
  const a = new Map(original.map((l) => [l.sku, l.qty]));
  const b = new Map(lines.map((l) => [l.sku, l.qty]));
  let n = 0;
  for (const [sku, q] of a) if (b.get(sku) !== q) n++;
  for (const [sku] of b) if (!a.has(sku)) n++;
  return n;
}

function preferencePenalty(goal: ConfirmedGoal, lines: BundleLine[], byId: Map<string, Variant>): number {
  let p = 0;
  const hp = lines.find((l) => l.role === "headphones");
  if (goal.preferences.headphoneType && hp && byId.get(hp.sku)?.facts.type?.value !== goal.preferences.headphoneType) p++;
  const st = lines.find((l) => l.role === "stand");
  if (goal.preferences.stand && st && byId.get(st.sku)?.facts.type?.value !== goal.preferences.stand) p++;
  return p;
}

const EVIDENCE_RANK: Record<EvidenceMode, number> = { MERCHANT_TESTED: 0, DOCUMENTED: 0, FIXTURE: 1, UNKNOWN: 9, CONTRADICTED: 9 };

function compareKeys(a: (string | number)[], b: (string | number)[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

export function missingHardFields(goal: ConfirmedGoal, requireDeadline = true): string[] {
  const missing: string[] = HARD_FIELDS.filter((f) => (f !== "pickupBy" || requireDeadline) && (goal[f] === null || goal[f] === undefined));
  if ((goal.remoteGuests ?? 0) > 0 && !goal.callApp) missing.push("callApp");
  return missing;
}

export function solve(input: SolveInput): SolveResult {
  const started = performance.now();
  const { goal, availability, now } = input;
  const recipes = input.recipes ?? RECIPES;
  const catalog = input.catalog ?? FIXTURE_SNAPSHOT;
  const byId = new Map(catalog.variants.map((v) => [v.sku, v]));
  const workCap = input.workCap ?? 200_000;
  const timeGuardMs = input.timeGuardMs ?? 2000;
  const versions = { catalog: catalog.version, recipes: RECIPES_VERSION, solver: SOLVER_VERSION, ranking: RANKING_VERSION, pickupPolicy: PICKUP_POLICY.version };
  const base: SolveResult = { status: "FEASIBLE", candidates: [], nearMisses: [], missingFields: [], unknownFacts: [], exclusionCounts: {}, uniqueBlockers: {}, bindingExplanation: [], combinationsChecked: 0, feasibleCount: 0, searchComplete: false, durationMs: 0, versions };
  const finish = (r: SolveResult): SolveResult => ({ ...r, durationMs: Math.round((performance.now() - started) * 100) / 100 });

  const missing = missingHardFields(goal, input.requireDeadline ?? true);
  if (missing.length) return finish({ ...base, status: "NEEDS_CLARIFICATION", missingFields: missing, searchComplete: true });
  const covering = recipes.filter((r) => r.covers(goal));
  if (!covering.length) return finish({ ...base, status: "UNSUPPORTED_GOAL", searchComplete: true, bindingExplanation: ["No declared recipe covers this task and environment."] });

  const pickup = input.pickup ?? firstPickupWindow(now);
  const feasible: Bundle[] = [];
  const near: NearMiss[] = [];
  const unknownFacts = new Map<string, { sku: string; fact: string; check: CheckId }>();
  const exclusion: Partial<Record<CheckId, number>> = {};
  const unique: Partial<Record<CheckId, number>> = {};
  let checked = 0;
  for (const recipe of covering) {
    for (const picked of enumerate(goal, recipe, catalog)) {
      checked++;
      if (checked > workCap || performance.now() - started > timeGuardMs) {
        return finish({ ...base, status: "SEARCH_INCOMPLETE", combinationsChecked: checked - 1, searchComplete: false, bindingExplanation: ["Search stopped at its work or time limit before covering the declared domain."] });
      }
      const ev = evaluateCombination(goal, recipe, picked, availability, pickup, catalog.taxRateBps);
      const fails = ev.checks.filter((c) => c.outcome === "fail");
      const unknowns = ev.checks.filter((c) => c.outcome === "unknown");
      for (const f of fails) exclusion[f.id] = (exclusion[f.id] ?? 0) + 1;
      if (fails.length === 1) unique[fails[0]!.id] = (unique[fails[0]!.id] ?? 0) + 1;
      const disruption = disruptionOf(ev.lines, input.original);
      const pref = preferencePenalty(goal, ev.lines, byId);
      const evidenceModes = new Set(ev.lines.flatMap((l) => Object.values(byId.get(l.sku)!.facts).map((f) => f.evidence)));
      const evidenceMode: EvidenceMode = evidenceModes.has("UNKNOWN") ? "UNKNOWN" : evidenceModes.has("FIXTURE") ? "FIXTURE" : evidenceModes.has("MERCHANT_TESTED") ? "MERCHANT_TESTED" : "DOCUMENTED";
      const skuKey = ev.lines.map((l) => `${l.sku}x${l.qty}`).join("+");
      const bundle: Bundle = {
        recipeId: recipe.id, recipeVersion: recipe.version, recipeTitle: recipe.title, lines: ev.lines, subtotalCents: ev.subtotal, taxCents: ev.tax, totalCents: ev.total,
        pickup, checks: ev.checks, disruption, preferencePenalty: pref, evidenceMode,
        rankKey: [pref, disruption, EVIDENCE_RANK[evidenceMode], ev.total, recipe.id, skuKey], setupSteps: recipe.setupSteps,
      };
      if (!fails.length && !unknowns.length) { feasible.push(bundle); continue; }
      if (!fails.length && unknowns.length) {
        for (const u of unknowns) for (const l of ev.lines) for (const [k, f] of Object.entries(byId.get(l.sku)!.facts)) if (f.evidence === "UNKNOWN") unknownFacts.set(`${l.sku}:${k}`, { sku: l.sku, fact: k, check: u.id });
        continue;
      }
      // Near miss: fails only on budget and/or pickup, with every other fact known and passing.
      if (!unknowns.length && fails.every((f) => f.id === "BUDGET" || f.id === "PICKUP_DEADLINE")) {
        const requires: NearMiss["requires"] = {};
        if (fails.some((f) => f.id === "BUDGET")) requires.budgetCents = ev.total;
        if (fails.some((f) => f.id === "PICKUP_DEADLINE")) requires.pickupBy = pickup.end;
        near.push({ bundle, requires, summary: [requires.budgetCents !== undefined ? `budget of at least ${requires.budgetCents} cents` : "", requires.pickupBy ? `pickup deadline after ${requires.pickupBy}` : ""].filter(Boolean).join(" and ") });
      }
    }
  }
  feasible.sort((a, b) => compareKeys(a.rankKey, b.rankKey));
  near.sort((a, b) => compareKeys([a.requires.pickupBy ? 1 : 0, a.requires.budgetCents ?? 0, ...a.bundle.rankKey], [b.requires.pickupBy ? 1 : 0, b.requires.budgetCents ?? 0, ...b.bundle.rankKey]));
  const result: SolveResult = { ...base, combinationsChecked: checked, feasibleCount: feasible.length, searchComplete: true, exclusionCounts: exclusion, uniqueBlockers: unique, unknownFacts: [...unknownFacts.values()] };
  if (feasible.length) return finish({ ...result, status: "FEASIBLE", candidates: feasible.slice(0, 2) });
  if (unknownFacts.size) return finish({ ...result, status: "EVIDENCE_INCOMPLETE", nearMisses: near.slice(0, 2), bindingExplanation: ["Some otherwise-valid bundles depend on facts that are not documented; they need review before any conclusion."] });
  return finish({ ...result, status: "NO_FEASIBLE_SUPPORTED_BUNDLE", nearMisses: near.slice(0, 2), bindingExplanation: explainBlockers(unique, exclusion) });
}

function explainBlockers(unique: Partial<Record<CheckId, number>>, all: Partial<Record<CheckId, number>>): string[] {
  const order = Object.entries(unique).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)).map(([k]) => k as CheckId);
  const ids = order.length ? order : (Object.keys(all) as CheckId[]);
  return ids.slice(0, 3).map((id) => `${CHECK_LABELS[id]}: this constraint alone rules out ${unique[id] ?? all[id] ?? 0} otherwise-complete combinations.`);
}

/** Re-validate a specific accepted bundle against current facts (authoritative check before checkout). */
export function revalidateLines(goal: ConfirmedGoal, recipeId: string, lines: { sku: string; qty: number }[], availability: Record<string, number>, pickup: PickupWindow, catalog: CatalogSnapshot = FIXTURE_SNAPSHOT, recipes: Recipe[] = RECIPES): { ok: boolean; checks: CheckResult[]; totalCents: number } {
  const recipe = recipes.find((r) => r.id === recipeId);
  if (!recipe) return { ok: false, checks: [fail("TASK_COVERAGE", "Recipe no longer declared")], totalCents: 0 };
  const byId = new Map(catalog.variants.map((v) => [v.sku, v]));
  const gone = lines.filter((l) => !byId.has(l.sku));
  if (gone.length) return { ok: false, checks: [fail("AVAILABILITY", `${gone.map((l) => l.sku).join(", ")} no longer in the catalog`)], totalCents: 0 };
  const picked: Picked[] = recipe.roles.map((spec) => {
    const line = lines.find((l) => byId.get(l.sku)!.role === spec.role);
    return { spec, variant: line ? byId.get(line.sku)! : null, qty: line ? line.qty : 0 };
  });
  const ev = evaluateCombination(goal, recipe, picked, availability, pickup, catalog.taxRateBps);
  return { ok: ev.checks.every((c) => c.outcome === "pass"), checks: ev.checks, totalCents: ev.total };
}

export { CHECK_LABELS, CATALOG };

/**
 * Item-only substitution (the declared comparison baseline, spec §15): replace just the affected role with each
 * legal substitute, keep every other original line, and run the same hard checks.
 */
export function itemOnlySwaps(goal: ConfirmedGoal, recipeId: string, originalLines: { sku: string; qty: number }[], missingSku: string, availability: Record<string, number>, pickup: PickupWindow, catalog: CatalogSnapshot = FIXTURE_SNAPSHOT, recipes: Recipe[] = RECIPES) {
  const recipe = recipes.find((r) => r.id === recipeId);
  if (!recipe) return [];
  const byId = new Map(catalog.variants.map((v) => [v.sku, v]));
  const missing = byId.get(missingSku);
  if (!missing) return [];
  const spec = recipe.roles.find((r) => r.role === missing.role);
  if (!spec) return [];
  return candidatesFor(spec, catalog).map((v) => v.sku).filter((s) => s !== missingSku).map((sku) => {
    const lines = originalLines.map((l) => (l.sku === missingSku ? { sku, qty: l.qty } : l));
    const res = revalidateLines(goal, recipeId, lines, availability, pickup, catalog, recipes);
    return { sku, name: byId.get(sku)!.name, ok: res.ok, totalCents: res.totalCents, failed: res.checks.filter((c) => c.outcome !== "pass").map((c) => ({ id: c.id, label: c.label, detail: c.detail, outcome: c.outcome })) };
  });
}
