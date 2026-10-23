import { afterEach, describe, expect, it } from "vitest";
import { clearDraft, loadDraft, saveDraft, startingDraft, type Draft } from "../../src/web/components/demo/draft.js";

// Review follow-up: an unconfirmed AI draft lost the form values after a reload or a switch to the Store view.
type F = { os: string; time: string };
const EMPTY: F = { os: "", time: "" };
const fromRun: F = { os: "", time: "" }; // what the saved draft itself contains (the AI left these missing)
const edits: F = { os: "macos", time: "10:00" }; // what the buyer filled in afterwards
const draft = (over: Partial<Draft<F>> = {}): Draft<F> => ({ sessionId: "s1", extractionId: "run-1", text: "my words", form: edits, savedAt: 1, ...over });
const base = { extractionForm: fromRun, extractionText: "my words", empty: EMPTY, sampleText: "sample" };

describe("starting an unconfirmed requirements form", () => {
  it("keeps the buyer's edits made on the latest saved draft", () => {
    expect(startingDraft({ ...base, draft: draft(), extractionId: "run-1" })).toEqual({ form: edits, text: "my words", extractionId: "run-1" });
  });
  it("shows the saved draft when there are no edits yet, with the buyer's words", () => {
    expect(startingDraft({ ...base, draft: null, extractionId: "run-1" })).toEqual({ form: fromRun, text: "my words", extractionId: "run-1" });
  });
  it("keeps the buyer's edits while the page's state does not show the saved draft yet", () => {
    // A state response that left the server before the draft was recorded can arrive after the one that has it.
    expect(startingDraft({ ...base, extractionForm: null, extractionText: null, draft: draft(), extractionId: null })).toEqual({ form: edits, text: "my words", extractionId: "run-1" });
  });
  it("lets a newer saved draft replace edits made on an older one", () => {
    expect(startingDraft({ ...base, draft: draft({ extractionId: "run-1" }), extractionId: "run-2" }).form).toEqual(fromRun);
  });
  it("keeps edits made before any draft, and starts empty with the sample otherwise", () => {
    expect(startingDraft({ ...base, extractionForm: null, extractionText: null, draft: draft({ extractionId: null, text: "typed" }), extractionId: null })).toEqual({ form: edits, text: "typed", extractionId: null });
    expect(startingDraft({ ...base, extractionForm: null, extractionText: null, draft: null, extractionId: null })).toEqual({ form: EMPTY, text: "sample", extractionId: null });
  });
});

describe("the draft store", () => {
  const g = globalThis as any;
  afterEach(() => { clearDraft(); delete g.window; });

  it("round-trips through browser storage and ignores another session's draft", () => {
    const data = new Map<string, string>();
    g.window = { localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) } };
    saveDraft(draft());
    expect(loadDraft<F>("s1")?.form).toEqual(edits);
    expect(loadDraft<F>("s2")).toBeNull();
    clearDraft();
    expect(loadDraft<F>("s1")).toBeNull();
  });

  it("falls back to memory when storage is blocked", () => {
    const blocked = () => { throw new Error("SecurityError"); };
    g.window = { localStorage: { getItem: blocked, setItem: blocked, removeItem: blocked } };
    saveDraft(draft());
    expect(loadDraft<F>("s1")?.form).toEqual(edits);
  });
});
