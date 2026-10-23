import { describe, expect, it } from "vitest";
import { normalizeRecordingDate, readDayPhrase } from "../../src/server/language/dates.js";
import { rulesExtract } from "../../src/server/language/rules.js";
import type { Extraction } from "../../src/server/language/adapter.js";

// Wednesday, November 4, 2026, 10:00 in Los Angeles (after the daylight-saving change). Deliberately unlike the
// evaluation set's Monday in October.
const REF = new Date("2026-11-04T18:00:00Z");
const LA = "America/Los_Angeles";
const read = (p: string) => readDayPhrase(p, REF, LA);

describe("deterministic day phrases", () => {
  it("resolves bare weekdays to the first such day strictly after the reference date", () => {
    expect(read("Friday")).toEqual({ kind: "exact", value: "2026-11-06" });
    expect(read("on Thursday")).toEqual({ kind: "exact", value: "2026-11-05" });
    expect(read("Wednesday")).toEqual({ kind: "exact", value: "2026-11-11" });
    expect(read("Saturday mornings")).toEqual({ kind: "exact", value: "2026-11-07" });
    expect(read("this Friday")).toEqual({ kind: "exact", value: "2026-11-06" });
  });

  it("resolves today, tonight and tomorrow in the buyer's timezone", () => {
    expect(read("today")).toEqual({ kind: "exact", value: "2026-11-04" });
    expect(read("tonight")).toEqual({ kind: "exact", value: "2026-11-04" });
    expect(read("tomorrow")).toEqual({ kind: "exact", value: "2026-11-05" });
    const lateEvening = new Date("2026-11-05T06:30:00Z"); // 22:30 Wednesday in LA, 01:30 Thursday in New York
    expect(readDayPhrase("tomorrow", lateEvening, LA)).toEqual({ kind: "exact", value: "2026-11-05" });
    expect(readDayPhrase("tomorrow", lateEvening, "America/New_York")).toEqual({ kind: "exact", value: "2026-11-06" });
  });

  it("reads '<weekday> next week' as the following calendar week", () => {
    expect(read("Tuesday next week")).toEqual({ kind: "exact", value: "2026-11-10" });
    expect(read("Sunday next week")).toEqual({ kind: "exact", value: "2026-11-15" });
  });

  it("refuses to pick a reading for ambiguous phrases", () => {
    expect(read("next Monday")).toEqual({ kind: "ambiguous", options: [{ iso: "2026-11-09", label: "Mon, Nov 9" }, { iso: "2026-11-16", label: "Mon, Nov 16" }] });
    expect(read("over the weekend")).toEqual({ kind: "ambiguous", options: [{ iso: "2026-11-07", label: "Sat, Nov 7" }, { iso: "2026-11-08", label: "Sun, Nov 8" }] });
    expect(read("sometime next week")).toEqual({ kind: "ambiguous", options: [] });
  });

  it("leaves explicit calendar dates to the model reading", () => {
    expect(read("November 20")).toEqual({ kind: "unread" });
    expect(read("the 16th")).toEqual({ kind: "unread" });
  });
});

describe("normalizing a model draft", () => {
  const draft = (recordingDate: Extraction["recordingDate"]): Extraction => ({
    localPeople: null, remoteGuests: null, hostPort: null, os: null, callApp: null, budgetCents: null, recordingDate, recordingTime: null,
    owned: { headphones: 0, micCables: 0, stands: 0 }, negations: [], unknowns: [], conflicts: [], questions: ["Which operating system does the laptop run?"],
  });

  it("recomputes a mis-resolved weekday", () => {
    expect(normalizeRecordingDate(draft({ value: "2026-11-13", span: "Friday" }), REF, LA).recordingDate).toEqual({ value: "2026-11-06", span: "Friday" });
  });

  it("turns an ambiguous date into an unknown with a concrete question first", () => {
    const out = normalizeRecordingDate(draft({ value: "2026-11-09", span: "next Monday" }), REF, LA);
    expect(out.recordingDate).toBeNull();
    expect(out.unknowns).toContain("recordingDate");
    expect(out.questions[0]).toBe("Which day do you mean: Mon, Nov 9 or Mon, Nov 16?");
    expect(out.questions).toHaveLength(2);
  });

  it("rejects an explicit date that contradicts its weekday", () => {
    expect(normalizeRecordingDate(draft({ value: "2026-11-17", span: "Monday the 16th" }), REF, LA).recordingDate).toBeNull();
    expect(normalizeRecordingDate(draft({ value: "2026-11-16", span: "Monday the 16th" }), REF, LA).recordingDate).toEqual({ value: "2026-11-16", span: "Monday the 16th" });
  });

  it("applies the same reading in the rules fallback", () => {
    const ambiguous = rulesExtract("Two of us, recording next Thursday at 6 pm.", REF, LA);
    expect(ambiguous.recordingDate).toBeNull();
    expect(ambiguous.questions).toContain("Which day do you mean: Thu, Nov 5 or Thu, Nov 12?");
    expect(rulesExtract("Recording tomorrow at 9 am.", REF, LA).recordingDate?.value).toBe("2026-11-05");
  });
});

describe("budget conflict safety net", () => {
  const base: Extraction = { localPeople: null, remoteGuests: null, hostPort: null, os: null, callApp: null, budgetCents: { value: 30000, span: "$300", allIn: true }, recordingDate: null, recordingTime: null, owned: { headphones: 0, micCables: 0, stands: 0 }, negations: [], unknowns: [], conflicts: [], questions: [] };

  it("turns two different amounts into a conflict and a question", async () => {
    const { flagBudgetConflict } = await import("../../src/server/language/dates.js");
    const out = flagBudgetConflict(base, "We can do $300, though my partner says $275 max.");
    expect(out.budgetCents).toBeNull();
    expect(out.conflicts).toEqual([{ field: "budgetCents", detail: "The request names several amounts: $300, $275." }]);
    expect(out.questions[0]).toBe("Which budget applies: $300 or $275?");
  });

  it("leaves a single amount, a repeated amount, or an already-flagged conflict alone", async () => {
    const { flagBudgetConflict } = await import("../../src/server/language/dates.js");
    expect(flagBudgetConflict(base, "Budget is $300.")).toBe(base);
    expect(flagBudgetConflict(base, "$300 total, and I mean $300.")).toBe(base);
    const flagged = { ...base, budgetCents: null, conflicts: [{ field: "budgetCents", detail: "two budgets" }] };
    expect(flagBudgetConflict(flagged, "$300 or $275")).toBe(flagged);
  });
});
