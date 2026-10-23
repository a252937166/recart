/**
 * An unconfirmed requirements draft, kept in this browser so that a reload or a visit to the Store view does not lose
 * the buyer's edits. Only one draft is kept, tagged with its demo session; storage that is blocked or unavailable
 * falls back to memory for the life of the page.
 */
export interface Draft<F> { sessionId: string; extractionId: string | null; text: string; form: F; savedAt: number }

const KEY = "recart.requirements-draft";
let memory: string | null = null;
type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
// Read through globalThis so the module also loads where there is no DOM (tests); reading it can throw when blocked.
const storage = () => (globalThis as { window?: { localStorage?: Store } }).window?.localStorage;

export function loadDraft<F>(sessionId: string): Draft<F> | null {
  let raw: string | null = null;
  try { raw = storage()?.getItem(KEY) ?? null; } catch { /* storage blocked */ }
  raw ??= memory;
  try {
    const d = raw ? (JSON.parse(raw) as Draft<F>) : null;
    return d && d.sessionId === sessionId && d.form && typeof d.text === "string" ? d : null;
  } catch { return null; }
}

export function saveDraft<F>(d: Draft<F>) {
  memory = JSON.stringify(d);
  try { storage()?.setItem(KEY, memory); } catch { /* storage blocked: memory only */ }
}

export function clearDraft() {
  memory = null;
  try { storage()?.removeItem(KEY); } catch { /* storage blocked */ }
}

/**
 * What an unconfirmed form starts from. The buyer's own edits win when they were made on the latest saved draft (or
 * before any draft existed); a newer saved draft than the edits replaces them; otherwise the saved draft itself is
 * shown, and with neither, an empty form. A page whose state shows no saved draft yet (it can lag a moment behind
 * the request that made one) keeps the buyer's draft rather than starting over.
 */
export function startingDraft<F>(a: { draft: Draft<F> | null; extractionId: string | null; extractionForm: F | null; extractionText: string | null; empty: F; sampleText: string }): { form: F; text: string; extractionId: string | null } {
  const { draft, extractionId } = a;
  if (draft && (draft.extractionId === extractionId || !extractionId)) return { form: draft.form, text: draft.text, extractionId: draft.extractionId };
  if (extractionId && a.extractionForm) return { form: a.extractionForm, text: a.extractionText ?? draft?.text ?? a.sampleText, extractionId };
  return { form: a.empty, text: draft?.text ?? a.sampleText, extractionId: null };
}
