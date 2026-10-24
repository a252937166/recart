import { addDays, zonedDate } from "../../domain/time.js";
import type { Extraction } from "./adapter.js";

/**
 * Deterministic reading of the buyer's day phrase (spec v1.2.1 §8: code owns facts; the model only drafts).
 * The evaluation showed the model's relative-date arithmetic is unreliable, and that it resolves ambiguous phrases
 * such as "next Friday" or "this weekend" instead of asking. Only phrases with a single reading resolve here.
 * postprocess-v1: span grounding only. postprocess-v2: plus this date reading. postprocess-v3: plus the budget conflict check.
 */
export const POSTPROCESS_VERSION = "postprocess-v3";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
type Ymd = { y: number; m: number; d: number };
const iso = (p: Ymd) => `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
const pretty = (p: Ymd) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(Date.UTC(p.y, p.m - 1, p.d)));

export type DayReading = { kind: "exact"; value: string } | { kind: "ambiguous"; options: { iso: string; label: string }[] } | { kind: "unread" };

/** Reads a day phrase relative to the reference instant in the buyer's timezone. */
export function readDayPhrase(phrase: string, ref: Date, tz: string): DayReading {
  const p = phrase.toLowerCase().replace(/\s+/g, " ").trim();
  const today = zonedDate(ref, tz);
  const at = (delta: number) => addDays(today.y, today.m, today.d, delta);
  const opt = (x: Ymd) => ({ iso: iso(x), label: pretty(x) });
  // Explicit calendar dates ("the 19th", "Oct 23", "10/23") are left to the model's reading and checked separately.
  if (/\b\d{1,2}(st|nd|rd|th)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/.test(p)) return { kind: "unread" };
  const wd = DAYS.findIndex((d) => new RegExp(`\\b${d}s?\\b`).test(p));
  const untilNext = (target: number) => { const delta = (target - today.weekday + 7) % 7; return delta === 0 ? 7 : delta; };
  if (/\bweekend\b/.test(p)) { const sat = untilNext(6); return { kind: "ambiguous", options: [opt(at(sat)), opt(at(sat + 1))] }; }
  if (/\btoday\b|\btonight\b|\bthis (morning|afternoon|evening)\b/.test(p)) return { kind: "exact", value: iso(at(0)) };
  if (/\btomorrow\b/.test(p)) return { kind: "exact", value: iso(at(1)) };
  if (wd >= 0) {
    if (/\bnext week\b/.test(p)) {
      const toNextMonday = untilNext(1);
      return { kind: "exact", value: iso(at(toNextMonday + ((wd + 6) % 7))) };
    }
    const delta = untilNext(wd);
    if (/\bnext\b/.test(p)) return { kind: "ambiguous", options: [opt(at(delta)), opt(at(delta + 7))] };
    return { kind: "exact", value: iso(at(delta)) };
  }
  if (/\bnext week\b|\bthis week\b/.test(p)) return { kind: "ambiguous", options: [] };
  return { kind: "unread" };
}

/** Applies the deterministic reading to a draft: exact phrases are recomputed, ambiguous ones become a question. */
export function normalizeRecordingDate(x: Extraction, ref: Date, tz: string): Extraction {
  if (!x.recordingDate) return x;
  const span = x.recordingDate.span;
  const reading = readDayPhrase(span, ref, tz);
  const ask = (question: string): Extraction => ({
    ...x,
    recordingDate: null,
    unknowns: x.unknowns.includes("recordingDate") ? x.unknowns : [...x.unknowns, "recordingDate"],
    questions: [question, ...x.questions.filter((q) => q !== question)].slice(0, 3),
  });
  if (reading.kind === "exact") return { ...x, recordingDate: { value: reading.value, span } };
  if (reading.kind === "ambiguous") {
    return ask(reading.options.length ? `Which day do you mean: ${reading.options.map((o) => o.label).join(" or ")}?` : `Which day is the recording ("${span}")?`);
  }
  // An explicit date that names a weekday must agree with it ("Monday the 19th").
  const wd = DAYS.findIndex((d) => new RegExp(`\\b${d}s?\\b`, "i").test(span));
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x.recordingDate.value);
  if (wd >= 0 && m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() !== wd) return ask(`Which date is the recording? "${span}" does not match ${x.recordingDate.value}.`);
  return x;
}

/**
 * Safety net for two incompatible budgets: when the buyer text names more than one distinct dollar amount and the draft
 * still holds a single budget without listing a conflict, the budget becomes a conflict and a question, never a guess.
 */
export function flagBudgetConflict(x: Extraction, text: string): Extraction {
  const amounts = [...new Set([...text.matchAll(/\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{2})?)/g)].map((m) => Math.round(Number(m[1]!.replace(/,/g, "")) * 100)))];
  if (amounts.length < 2 || x.conflicts.some((c) => c.field === "budgetCents")) return x;
  const shown = amounts.map((c) => `$${(c / 100).toFixed(2).replace(/\.00$/, "")}`);
  const question = `Which budget applies: ${shown.join(" or ")}?`;
  return {
    ...x,
    budgetCents: null,
    conflicts: [...x.conflicts, { field: "budgetCents", detail: `The request names several amounts: ${shown.join(", ")}.` }],
    unknowns: x.unknowns.filter((u) => u !== "budgetCents"),
    questions: [question, ...x.questions.filter((q) => q !== question)].slice(0, 3),
  };
}
