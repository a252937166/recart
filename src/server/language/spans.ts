import type { Extraction } from "./adapter.js";

/**
 * A drafted value counts only when its quote occurs in the buyer's text and says something about that value. Checking
 * presence alone let a model draft read an operating system out of "USB-C laptop" (one of four live runs on
 * 2026-10-23): the words exist, but they name a port, not a system. So the categorical fields must quote a word that
 * names the value, and a budget quote's amount must be the amount drafted. Counts, dates and times keep the presence
 * check (dates are re-read in code). A dropped value becomes unknown, and the port, the operating system, the call app
 * and the budget become the questions the buyer would otherwise not be asked.
 */
const NAMES: Record<"hostPort" | "os" | "callApp", Record<string, RegExp>> = {
  hostPort: { "usb-c": /\b(?:usb[- ]?c|type[- ]?c|thunderbolt)\b/i, "usb-a": /\busb[- ]?a\b/i, "usb-b": /\busb[- ]?b\b/i },
  os: {
    macos: /\b(?:mac|macs|macbook(?:\s+(?:air|pro))?|macos|mac\s?os(?:\s?x)?|os\s?x|imac|mac\s?mini|apple)\b/i,
    windows: /\b(?:windows|win\s?1[01])\b/i,
    linux: /\b(?:linux|ubuntu|debian|fedora)\b/i,
  },
  // "other" covers apps the store does not list, so its quote only has to exist.
  callApp: { zoom: /\bzoom\b/i, "google-meet": /\b(?:google\s+)?meet\b/i, riverside: /\briverside\b/i },
};

const QUESTIONS = {
  hostPort: { text: "Which port on the computer will the interface plug into?", asked: /\bport\b|usb/i },
  os: { text: "Which operating system does the laptop run?", asked: /operating system|\bos\b|mac|windows|linux/i },
  callApp: { text: "Which call app will the remote guest use?", asked: /\bapp\b|zoom|meet|riverside/i },
  budgetCents: { text: "What is your all-in budget?", asked: /budget/i },
} as const;

const PRESENCE = ["localPeople", "remoteGuests", "hostPort", "os", "callApp", "recordingDate", "recordingTime"] as const;

/** Whether a quote names a categorical value (fields without a name list only need their quote to exist). */
export function quoteNamesValue(field: string, value: unknown, span: string): boolean {
  const names = NAMES[field as keyof typeof NAMES];
  const re = names?.[String(value)];
  return re ? re.test(span) : true;
}

/** Amounts written with digits in a quote, in cents ("$450" and "450 dollars" are both 45000). */
function amountsInCents(span: string): number[] {
  return [...span.matchAll(/(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/g)].map((m) => Math.round(Number(m[1]!.replace(/,/g, "")) * 100));
}

export function dropUnsupportedSpans(x: Extraction, text: string): Extraction {
  const lower = text.toLowerCase();
  const out: Extraction = { ...x, unknowns: [...x.unknowns], questions: [...x.questions] };
  const dropped: string[] = [];
  const drop = (k: string) => {
    (out as Record<string, unknown>)[k] = null;
    if (!out.unknowns.includes(k)) out.unknowns.push(k);
    dropped.push(k);
  };
  for (const k of PRESENCE) {
    const f = out[k] as { value: unknown; span: string } | null;
    if (f && (!f.span || !lower.includes(f.span.toLowerCase()) || !quoteNamesValue(k, f.value, f.span))) drop(k);
  }
  const b = out.budgetCents;
  if (b) {
    const amounts = amountsInCents(b.span);
    if (!b.span || !lower.includes(b.span.toLowerCase()) || (amounts.length > 0 && !amounts.includes(b.value))) drop("budgetCents");
  }
  // Ask about what was dropped, first, unless the draft already asks about it; the call app only matters with a remote guest.
  const asks: string[] = [];
  for (const k of dropped) {
    const q = QUESTIONS[k as keyof typeof QUESTIONS];
    if (!q || out.questions.some((existing) => q.asked.test(existing))) continue;
    if (k === "callApp" && !(out.remoteGuests?.value ?? 0)) continue;
    asks.push(q.text);
  }
  out.questions = [...asks, ...out.questions].slice(0, 3);
  return out;
}
