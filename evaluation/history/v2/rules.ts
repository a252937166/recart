import type { Extraction } from "./adapter.js";
import { zonedDate, addDays } from "../../domain/time.js";

/**
 * Deterministic fallback extractor used when the hosted model is unavailable. It only reads explicit
 * patterns; anything it cannot find stays unknown for the buyer to fill in on the form.
 */
const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, a: 1, an: 1, solo: 1, single: 1, both: 2 };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function num(s: string): number | null { const n = Number(s); if (Number.isInteger(n)) return n; return WORDS[s.toLowerCase()] ?? null; }

export function rulesExtract(text: string, ref: Date, tz: string): Extraction {
  const t = text.toLowerCase();
  const out: Extraction = { localPeople: null, remoteGuests: null, hostPort: null, os: null, callApp: null, budgetCents: null, recordingDate: null, recordingTime: null, owned: { headphones: 0, micCables: 0, stands: 0 }, negations: [], unknowns: [], conflicts: [], questions: [] };
  const span = (re: RegExp) => { const m = re.exec(text); return m ? m[0] : null; };

  const people = /(\b\d+|one|two|three|four|five)\s+(?:people|persons|hosts|of us)\b(?:\s+in\s+the\s+(?:room|studio))?/i.exec(text);
  if (people) out.localPeople = { value: num(people[1]!) ?? 0, span: people[0] };
  else if (/\bsolo\b|\bjust me\b|\bby myself\b/i.test(text)) out.localPeople = { value: 1, span: span(/\bsolo\b|\bjust me\b|\bby myself\b/i)! };

  const remote = /(\b\d+|one|two|three|a|an)\s+remote\s+(?:guest|guests|caller|participant)s?/i.exec(text);
  if (remote) out.remoteGuests = { value: num(remote[1]!) ?? 1, span: remote[0] };
  else if (/\bno remote (?:guests?|callers?)\b/i.test(t)) { out.remoteGuests = { value: 0, span: span(/no remote (?:guests?|callers?)/i)! }; out.negations.push("remoteGuests"); }

  const port = /usb[- ]?c\b/i.exec(text);
  if (port) out.hostPort = { value: "usb-c", span: port[0] };
  else { const a = /usb[- ]?a\b/i.exec(text); if (a) out.hostPort = { value: "usb-a", span: a[0] }; }

  const os = /\b(macbook|mac\s?os|macos|mac)\b/i.exec(text);
  if (os) out.os = { value: "macos", span: os[0] };
  else { const w = /\bwindows\b/i.exec(text); if (w) out.os = { value: "windows", span: w[0] }; else { const l = /\blinux\b/i.exec(text); if (l) out.os = { value: "linux", span: l[0] }; } }

  const app = /\b(zoom|google meet|meet|riverside)\b/i.exec(text);
  if (app) out.callApp = { value: app[1]!.toLowerCase() === "zoom" ? "zoom" : app[1]!.toLowerCase() === "riverside" ? "riverside" : "google-meet", span: app[0] };

  const money = [...text.matchAll(/\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{2})?)/g)];
  if (money.length === 1) out.budgetCents = { value: Math.round(Number(money[0]![1]!.replace(/,/g, "")) * 100), span: money[0]![0], allIn: !/before tax/i.test(text) };
  else if (money.length > 1) out.conflicts.push({ field: "budgetCents", detail: `Several amounts mentioned: ${money.map((m) => m[0]).join(", ")}` });

  const day = new RegExp(`\\b(${DAYS.join("|")})\\b`, "i").exec(text);
  if (day) {
    const target = DAYS.indexOf(day[1]!.toLowerCase());
    const today = zonedDate(ref, tz);
    let delta = (target - today.weekday + 7) % 7;
    if (delta === 0) delta = 7;
    const d = addDays(today.y, today.m, today.d, delta);
    out.recordingDate = { value: `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`, span: day[0] };
  }
  const time = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (time) {
    let h = Number(time[1]); const mm = Number(time[2] ?? "0");
    if (time[3]?.toLowerCase() === "pm" && h < 12) h += 12;
    if (time[3]?.toLowerCase() === "am" && h === 12) h = 0;
    if (h <= 23 && mm <= 59) out.recordingTime = { value: `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`, span: time[0] };
  }
  const ownsHp = /\b(?:have|own|already have)\s+(\w+)\s+(?:pairs? of\s+)?headphones\b/i.exec(text);
  if (ownsHp) out.owned.headphones = num(ownsHp[1]!) ?? 0;

  for (const k of ["localPeople", "remoteGuests", "hostPort", "os", "callApp", "budgetCents", "recordingDate", "recordingTime"] as const) if (!out[k]) out.unknowns.push(k);
  if (!out.os) out.questions.push("Which operating system does the laptop run?");
  if ((out.remoteGuests?.value ?? 0) > 0 && !out.callApp) out.questions.push("Which call app will the remote guest use?");
  if (!out.recordingTime) out.questions.push("What time does the recording start?");
  out.questions = out.questions.slice(0, 3);
  return out;
}
