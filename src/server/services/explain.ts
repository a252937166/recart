import { variantBySku } from "../../domain/catalog/fixtures.js";
import { formatUSD } from "../../domain/money.js";
import { itemOnlySwaps, type Bundle, type SolveResult } from "../../domain/solver/solver.js";
import type { ConfirmedGoal } from "../../domain/catalog/types.js";
import type { ExplainFacts, ExplainResult } from "../language/adapter.js";
import type { QuoteData } from "./quotes.js";

const CAPABILITY: Record<string, string> = {
  MIC_INPUTS: "a mic input for each person in the room",
  HEADPHONE_OUTPUTS: "a headphone feed for each person",
  REMOTE_ROUTING: "loopback routing so the remote guest hears the room",
  HOST_CONNECTION: "a cable path into your computer's port",
  PHANTOM_POWER: "phantom power for the mics",
  OS_SUPPORT: "support for your operating system",
};

/** How a failed check reads for a single-part swap (never the check's success label). */
export const FAILURE_PHRASE: Record<string, string> = {
  MIC_INPUTS: "not enough mic inputs",
  PHANTOM_POWER: "no phantom power for these mics",
  HEADPHONE_OUTPUTS: "not enough headphone outputs",
  REMOTE_ROUTING: "no loopback, so the remote guest cannot hear the room",
  HOST_CONNECTION: "the current cable does not fit its port",
  OS_SUPPORT: "not supported on your operating system",
  NO_SUPERFLUOUS_ACCESSORY: "would leave an unneeded accessory",
  AVAILABILITY: "out of stock",
  PICKUP_DEADLINE: "cannot be picked up in time",
  BUDGET: "over your budget",
};
const UNKNOWN_PHRASE: Record<string, string> = { REMOTE_ROUTING: "loopback support not documented" };

/** The names the buyer sees on the recovery page for the first and any further setup. */
export const OPTION_LABEL = (i: number) => (i === 0 ? "Fewest changes" : "Alternative");

function listParts(items: { name: string; qty: number }[]): string {
  const parts = items.map((l) => (l.qty > 1 ? `${l.qty}× ${l.name}` : `the ${l.name}`));
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

export interface ChangeDiff { added: { sku: string; name: string; qty: number }[]; removed: { sku: string; name: string; qty: number }[]; kept: { sku: string; name: string; qty: number }[]; deltaCents: number }

export function diffLines(original: { sku: string; name: string; qty: number }[], next: { sku: string; name: string; qty: number }[], deltaCents: number): ChangeDiff {
  const key = (l: { sku: string; qty: number }) => `${l.sku}x${l.qty}`;
  const o = new Set(original.map(key)); const n = new Set(next.map(key));
  return { added: next.filter((l) => !o.has(key(l))), removed: original.filter((l) => !n.has(key(l))), kept: next.filter((l) => o.has(key(l))), deltaCents };
}

/** Deterministic facts for the change explanation, plus the template text used whenever generation is unavailable or ungrounded. */
export function buildChangeExplanation(args: { goal: ConfirmedGoal; original: QuoteData; missingSku: string; result: SolveResult; availability: Record<string, number> }): { facts: ExplainFacts; fallback: ExplainResult; swaps: (ReturnType<typeof itemOnlySwaps>[number] & { reasons: string[] })[]; diffs: ChangeDiff[] } {
  const { goal, original, missingSku, result } = args;
  const missing = variantBySku(missingSku);
  const swaps = itemOnlySwaps(goal, original.recipe.id, original.lines, missingSku, args.availability, original.pickup).map((s) => ({
    ...s, reasons: s.failed.map((f) => (f.outcome === "unknown" ? UNKNOWN_PHRASE[f.id] ?? "a critical fact is not documented" : FAILURE_PHRASE[f.id] ?? f.label.toLowerCase())),
  }));
  const capabilities = original.checks.filter((c) => CAPABILITY[c.id]).map((c) => CAPABILITY[c.id]!);
  const diffs = result.candidates.map((b: Bundle) => diffLines(original.lines, b.lines, b.totalCents - original.totalCents));
  const money = new Set<string>([formatUSD(original.totalCents)]);
  for (const b of result.candidates) { money.add(formatUSD(b.totalCents)); money.add(formatUSD(b.totalCents - original.totalCents)); }
  for (const n of result.nearMisses) { money.add(formatUSD(n.bundle.totalCents)); if (n.requires.budgetCents) money.add(formatUSD(n.requires.budgetCents)); }
  if (goal.budgetCents != null) money.add(formatUSD(goal.budgetCents));
  const names = [missing.name, ...result.candidates.flatMap((b) => b.lines.map((l) => l.name)), ...original.lines.map((l) => l.name), ...swaps.map((s) => s.name)];
  const facts: ExplainFacts = {
    missingItem: missing.name,
    stillRequired: capabilities,
    itemOnlySwapsTried: swaps.map((s) => ({ item: s.name, works: s.ok, why: s.reasons })),
    outcome: result.status,
    options: result.candidates.map((b, i) => ({ index: i, label: OPTION_LABEL(i), total: formatUSD(b.totalCents), changeVsOriginal: formatUSD(b.totalCents - original.totalCents), added: diffs[i]!.added.map((l) => `${l.qty}x ${l.name}`), removed: diffs[i]!.removed.map((l) => `${l.qty}x ${l.name}`) })),
    nearMisses: result.nearMisses.map((n) => ({ total: formatUSD(n.bundle.totalCents), needs: n.requires.budgetCents ? `budget of at least ${formatUSD(n.requires.budgetCents)}` : "a later pickup deadline" })),
    originalTotal: formatUSD(original.totalCents),
    budget: goal.budgetCents != null ? formatUSD(goal.budgetCents) : null,
    allowedMoney: [...money],
    allowedNames: names,
  };
  const workingSwaps = swaps.filter((s) => s.ok).length;
  let summary: string;
  if (result.status === "FEASIBLE") {
    const top = result.candidates[0]!; const d = diffs[0]!;
    const swapLine = workingSwaps ? "" : ` Swapping only that part fails for every alternative, so ReCart rebuilt the connected parts too.`;
    summary = `The store could not find the ${missing.name}.${swapLine} The new setup adds ${listParts(d.added)} in place of ${listParts(d.removed)}. The total is ${formatUSD(top.totalCents)}, ${formatUSD(top.totalCents - original.totalCents)} more${goal.budgetCents != null ? `, still within your ${formatUSD(goal.budgetCents)} limit` : ""}.`;
  } else if (result.nearMisses.length) {
    const n = result.nearMisses[0]!;
    summary = `The store could not find the ${missing.name}. No complete setup fits all your requirements now. The closest one costs ${formatUSD(n.bundle.totalCents)}, which needs ${n.requires.budgetCents ? `a budget of at least ${formatUSD(n.requires.budgetCents)}` : "a later pickup"}. ReCart will not change your limit for you: raise it or cancel.`;
  } else {
    summary = `The store could not find the ${missing.name}. ReCart checked every combination in this catalog and its supported recipes, and none keeps the remote guest's loopback routing with parts that are in stock. Your payment hold is released and nothing was charged.`;
  }
  const fallback: ExplainResult = { status: "FALLBACK", summary, options: result.candidates.map((_, i) => ({ index: i, tradeoff: i === 0 ? "Fewest changes to your original setup." : "Alternative with a different trade-off." })), model: null, error: null };
  return { facts, fallback, swaps, diffs };
}
