// Runs the frozen ReCart evaluation (evaluation/SCORING-v1.md) once and writes per-case results plus a summary.
// Usage: set -a; . ~/.config/recart/recart-local.env; set +a
//        npx tsx tools/run-benchmark.ts --cases evaluation/cases-v1.json --out evidence/benchmark [--skip-language]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { RECIPES, variantBySku } from "../src/domain/catalog/fixtures.js";
import type { ConfirmedGoal } from "../src/domain/catalog/types.js";
import { revalidateLines, solve } from "../src/domain/solver/solver.js";
import { firstPickupWindow } from "../src/domain/time.js";
import { createPool } from "../src/server/db/pool.js";
import { HostedLanguageAdapter } from "../src/server/language/adapter.js";
import { PROMPT_VERSION, SCHEMA_VERSION } from "../src/server/language/prompts.js";
import { POSTPROCESS_VERSION } from "../src/server/language/dates.js";

const arg = (name: string, fallback?: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1]! : fallback; };
const casesPath = arg("--cases", "evaluation/cases-v1.json")!;
const outDir = arg("--out", "evidence/benchmark")!;
const skipLanguage = process.argv.includes("--skip-language");
const doc = JSON.parse(readFileSync(casesPath, "utf8"));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

type Line = { sku: string; qty: number };
const key = (lines: Line[]) => lines.map((l) => `${l.sku}x${l.qty}`).sort().join("+");
/** Independent total: catalog unit prices times quantities, then 8% tax rounded half up to the cent. */
const independentTotal = (lines: Line[]) => { const s = lines.reduce((n, l) => n + variantBySku(l.sku).priceCents * l.qty, 0); return s + Math.floor((s * 8 + 50) / 100); };

// ---------------- solver and baseline ----------------
const solverRows: any[] = [];
for (const c of doc.cases) {
  const now = new Date(c.context.referenceTime);
  const goal = c.referenceGoal as ConfirmedGoal;
  const r = solve({ goal, availability: c.availability, now, original: c.recovery?.original });
  const pickup = firstPickupWindow(now);
  const row: any = { id: c.id, expectedStatus: c.expected.status, status: r.status, statusCorrect: r.status === c.expected.status, durationMs: r.durationMs, combinationsChecked: r.combinationsChecked, searchComplete: r.searchComplete };
  if (r.status === "FEASIBLE") {
    const top = r.candidates[0]!;
    const lines = top.lines.map((l) => ({ sku: l.sku, qty: l.qty }));
    const validator = revalidateLines(goal, top.recipeId, lines, c.availability, pickup);
    row.top = { recipeId: top.recipeId, lines, totalCents: top.totalCents, disruption: top.disruption };
    row.validatorOk = validator.ok;
    row.independentTotalCents = independentTotal(lines);
    if (c.expected.status === "FEASIBLE") {
      const exp = c.expected.best;
      row.bestMatches = top.recipeId === exp.recipeId && key(lines) === key(exp.lines);
      row.totalCorrect = top.totalCents === exp.totalCents && row.independentTotalCents === exp.totalCents;
      row.solved = row.statusCorrect && row.bestMatches && row.totalCorrect && validator.ok;
    }
    row.invalidPayable = c.expected.status !== "FEASIBLE" || !validator.ok;
  } else {
    row.invalidPayable = false;
    if (r.nearMisses.length) row.nearMiss = { totalCents: r.nearMisses[0]!.bundle.totalCents, requires: r.nearMisses[0]!.requires };
    if (r.unknownFacts.length) row.unknownFacts = r.unknownFacts;
  }
  if (c.recovery) {
    const recipe = RECIPES.find((x) => x.id === c.recovery.recipeId)!;
    const role = variantBySku(c.recovery.missingSku).role;
    const spec = recipe.roles.find((x) => x.role === role)!;
    const tries = spec.allowed.map((sku) => {
      const lines = (c.recovery.original as Line[]).map((l) => (l.sku === c.recovery.missingSku ? { sku, qty: l.qty } : l));
      const v = revalidateLines(goal, recipe.id, lines, c.availability, pickup);
      return { sku, ok: v.ok, totalCents: v.totalCents, notPassed: v.checks.filter((x) => x.outcome !== "pass").map((x) => `${x.id}:${x.outcome}`) };
    });
    const ok = tries.filter((t) => t.ok).sort((a, b) => a.totalCents - b.totalCents);
    row.baseline = { success: ok.length > 0, best: ok[0] ?? null, tries, matchesExpectation: (ok.length > 0) === c.expected.baseline.success };
  }
  solverRows.push(row);
}

// ---------------- first-pass extraction ----------------
const FIELDS = ["localPeople", "remoteGuests", "hostPort", "os", "callApp", "budgetCents", "recordingDate", "recordingTime", "owned.headphones", "owned.micCables", "owned.stands"] as const;
function draftValue(x: any, f: string): any {
  if (!x) return null;
  if (f.startsWith("owned.")) { const n = x.owned?.[f.slice(6)] ?? 0; return n > 0 ? n : null; }
  if (f === "budgetCents") return x.budgetCents ? { value: x.budgetCents.value, allIn: x.budgetCents.allIn } : null;
  return x[f]?.value ?? null;
}
function equal(f: string, got: any, want: any): boolean {
  if (f === "budgetCents") return got.value === want.value && (want.allIn === false ? got.allIn === false : got.allIn !== false);
  return got === want;
}
const extractionRows: any[] = [];
if (!skipLanguage) {
  const url = process.env.LANGUAGE_URL ?? "", token = process.env.LANGUAGE_TOKEN ?? "";
  if (!url || !token || !process.env.DATABASE_URL) throw new Error("LANGUAGE_URL, LANGUAGE_TOKEN and DATABASE_URL are required (or pass --skip-language)");
  const db = createPool(process.env.DATABASE_URL);
  const adapter = new HostedLanguageAdapter(db, url, token);
  for (const c of doc.cases) {
    const res = await adapter.extractGoal({ sessionId: null as any, intentId: null as any, text: c.text, referenceTime: new Date(c.context.referenceTime), timezone: c.context.timezone });
    const ok = res.status === "OK";
    const x = ok ? res.extraction : null;
    const stated = c.labels.stated as Record<string, any>, unknown = c.labels.unknown as string[], conflicts = c.labels.conflicts as string[];
    let tp = 0, fp = 0, fn = 0, asserted = 0;
    const wrong: string[] = [], missing: string[] = [], unsupported: string[] = [];
    for (const f of FIELDS) {
      if (conflicts.includes(f)) continue;
      const got = draftValue(x, f);
      const want = stated[f];
      if (got !== null) asserted++;
      if (want !== undefined) {
        if (got === null) { fn++; missing.push(f); }
        else if (equal(f, got, want)) tp++;
        else { fp++; fn++; wrong.push(`${f}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
      } else if (got !== null) { fp++; unsupported.push(`${f}: ${JSON.stringify(got)}`); }
    }
    const unknownsPreserved = unknown.filter((f) => draftValue(x, f) === null);
    const unknownsListed = unknown.filter((f) => !!x && (x.unknowns.includes(f) || x.questions.some((q: string) => q.toLowerCase().includes(f === "recordingDate" ? "day" : f === "recordingTime" ? "time" : f === "budgetCents" ? "budget" : f === "callApp" ? "app" : f === "os" ? "operating" : f.toLowerCase()))));
    const conflictsFlagged = conflicts.filter((f) => !!x && x.conflicts.some((k: any) => k.field === f));
    const silentlyResolved = conflicts.filter((f) => !conflictsFlagged.includes(f) && draftValue(x, f) !== null);
    const wholeCase = ok && wrong.length === 0 && missing.length === 0 && unsupported.length === 0 && unknownsPreserved.length === unknown.length && conflictsFlagged.length === conflicts.length;
    extractionRows.push({ id: c.id, status: res.status, model: res.model, durationMs: res.durationMs, usage: res.usage, error: res.error, tp, fp, fn, asserted, stated: Object.keys(stated).length,
      wrong, missing, unsupported, unknown, unknownsPreserved, unknownsListed, conflicts, conflictsFlagged, silentlyResolved, wholeCase, draft: x });
    console.log(`${c.id} ${res.status} tp=${tp} fp=${fp} fn=${fn}${wholeCase ? " whole-case" : ""}`);
  }
  await db.end();
}

// ---------------- summary ----------------
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
const quantile = (xs: number[], q: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]; };
const byStatus = (s: string) => solverRows.filter((r) => r.expectedStatus === s);
const rec = solverRows.filter((r) => r.baseline);
const sum = (k: string) => extractionRows.reduce((n, r) => n + (r[k] ?? 0), 0);
const okRows = extractionRows.filter((r) => r.status === "OK");
const usageIn = okRows.reduce((n, r) => n + (r.usage?.prompt_tokens ?? 0), 0), usageOut = okRows.reduce((n, r) => n + (r.usage?.completion_tokens ?? 0), 0);
const summary = {
  version: doc.version, casesFile: path.basename(casesPath), casesSha256: sha(casesPath), rulesSha256: sha("evaluation/SCORING-v1.md"), runnerSha256: sha("tools/run-benchmark.ts"),
  ranAt: new Date().toISOString(), nature: doc.nature, promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION, postprocessVersion: POSTPROCESS_VERSION,
  solver: {
    classificationCorrect: `${solverRows.filter((r) => r.statusCorrect).length}/${solverRows.length}`,
    feasibleSolved: `${byStatus("FEASIBLE").filter((r) => r.solved).length}/${byStatus("FEASIBLE").length}`,
    infeasibleCorrect: `${byStatus("NO_FEASIBLE_SUPPORTED_BUNDLE").filter((r) => r.statusCorrect).length}/${byStatus("NO_FEASIBLE_SUPPORTED_BUNDLE").length}`,
    evidenceIncompleteCorrect: `${byStatus("EVIDENCE_INCOMPLETE").filter((r) => r.statusCorrect).length}/${byStatus("EVIDENCE_INCOMPLETE").length}`,
    unsupportedCorrect: `${byStatus("UNSUPPORTED_GOAL").filter((r) => r.statusCorrect).length}/${byStatus("UNSUPPORTED_GOAL").length}`,
    invalidPayableBundles: solverRows.filter((r) => r.invalidPayable).length,
    searchComplete: `${solverRows.filter((r) => r.searchComplete).length}/${solverRows.length}`,
    durationMs: { median: quantile(solverRows.map((r) => r.durationMs), 0.5), max: Math.max(...solverRows.map((r) => r.durationMs)) },
  },
  baseline: {
    recoveryCases: rec.length,
    baselineSucceeded: rec.filter((r) => r.baseline.success).length,
    recartFeasible: rec.filter((r) => r.status === "FEASIBLE").length,
    recartOnly: rec.filter((r) => r.status === "FEASIBLE" && !r.baseline.success).map((r) => r.id),
    bothSucceeded: rec.filter((r) => r.status === "FEASIBLE" && r.baseline.success).map((r) => r.id),
    baselineOnly: rec.filter((r) => r.status !== "FEASIBLE" && r.baseline.success).map((r) => r.id),
    matchesHandDerivedExpectation: `${rec.filter((r) => r.baseline.matchesExpectation).length}/${rec.length}`,
  },
  extraction: skipLanguage ? null : {
    model: okRows[0]?.model ?? null, cases: extractionRows.length, calls: { ok: okRows.length, failed: extractionRows.length - okRows.length },
    precision: { truePositives: sum("tp"), assertions: sum("asserted"), percent: sum("asserted") ? pct(sum("tp"), sum("asserted")) : "not applicable" },
    recall: { truePositives: sum("tp"), statedFacts: sum("stated") - extractionRows.reduce((n, r) => n + r.conflicts.length, 0), percent: pct(sum("tp"), sum("stated") - extractionRows.reduce((n, r) => n + r.conflicts.length, 0)) },
    wrongValues: extractionRows.reduce((n, r) => n + r.wrong.length, 0),
    unsupportedAssertions: extractionRows.reduce((n, r) => n + r.unsupported.length, 0),
    unknownsPreserved: `${extractionRows.reduce((n, r) => n + r.unknownsPreserved.length, 0)}/${extractionRows.reduce((n, r) => n + r.unknown.length, 0)}`,
    unknownsListedOrAsked: `${extractionRows.reduce((n, r) => n + r.unknownsListed.length, 0)}/${extractionRows.reduce((n, r) => n + r.unknown.length, 0)}`,
    conflictsFlagged: `${extractionRows.reduce((n, r) => n + r.conflictsFlagged.length, 0)}/${extractionRows.reduce((n, r) => n + r.conflicts.length, 0)}`,
    silentlyResolvedConflicts: extractionRows.reduce((n, r) => n + r.silentlyResolved.length, 0),
    wholeCaseCorrect: `${extractionRows.filter((r) => r.wholeCase).length}/${extractionRows.length}`,
    latencyMs: { median: quantile(okRows.map((r) => r.durationMs), 0.5), p95: quantile(okRows.map((r) => r.durationMs), 0.95) },
    tokens: { input: usageIn, output: usageOut }, estimatedCostUsd: Math.round(((usageIn * 1 + usageOut * 5) / 1e6) * 10000) / 10000,
  },
};
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ summary, solver: solverRows, extraction: extractionRows }, null, 2));
writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
