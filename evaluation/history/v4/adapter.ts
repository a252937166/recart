import { randomUUID } from "node:crypto";
import { z } from "zod";
import { clock } from "../clock.js";
import type { Db } from "../db/pool.js";
import { extractGoalMessages, explainChangeMessages, PROMPT_VERSION, SCHEMA_VERSION } from "./prompts.js";
import { flagBudgetConflict, normalizeRecordingDate, POSTPROCESS_VERSION } from "./dates.js";
import { rulesExtract } from "./rules.js";

const spanned = <T extends z.ZodTypeAny>(v: T) => z.object({ value: v, span: z.string().max(200) }).nullable();
export const extractionSchema = z.object({
  localPeople: spanned(z.number().int().min(0).max(20)),
  remoteGuests: spanned(z.number().int().min(0).max(20)),
  hostPort: spanned(z.enum(["usb-c", "usb-a", "usb-b"])),
  os: spanned(z.enum(["macos", "windows", "linux"])),
  callApp: spanned(z.enum(["zoom", "google-meet", "riverside", "other"])),
  budgetCents: z.object({ value: z.number().int().min(0).max(10_000_000), span: z.string().max(200), allIn: z.boolean().optional() }).nullable(),
  recordingDate: spanned(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  recordingTime: spanned(z.string().regex(/^\d{2}:\d{2}$/)),
  owned: z.object({ headphones: z.number().int().min(0).max(20), micCables: z.number().int().min(0).max(20), stands: z.number().int().min(0).max(20) }).default({ headphones: 0, micCables: 0, stands: 0 }),
  negations: z.array(z.string()).max(10).optional().default([]),
  unknowns: z.array(z.string()).max(20).default([]),
  conflicts: z.array(z.object({ field: z.string(), detail: z.string().max(300) })).max(10).default([]),
  questions: z.array(z.string().max(200)).max(3).default([]),
});
export type Extraction = z.infer<typeof extractionSchema>;

export interface ExtractResult { status: "OK" | "FALLBACK"; source: "model" | "rules"; extraction: Extraction; model: string | null; usage: Record<string, number> | null; durationMs: number; error: string | null; runId: string }
export interface ExplainResult { status: "OK" | "FALLBACK"; summary: string; options: { index: number; tradeoff: string }[]; model: string | null; error: string | null }

export interface LanguageAdapter {
  extractGoal(a: { sessionId: string; intentId: string; text: string; referenceTime: Date; timezone: string }): Promise<ExtractResult>;
  explainChange(a: { sessionId: string; intentId: string; facts: ExplainFacts; fallback: ExplainResult }): Promise<ExplainResult>;
  health(): Promise<{ configured: boolean; reachable: boolean | null; detail?: string }>;
}
export interface ExplainFacts { allowedMoney: string[]; allowedNames: string[]; [k: string]: unknown }

/** Accept bare JSON or exactly one fenced JSON block (the probe's verified parser behaviour). */
export function parseJsonEnvelope(content: string): unknown {
  const t = content.trim();
  const m = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/.exec(t);
  const candidate = m ? m[1]! : t;
  if (m && candidate.includes("```")) throw new Error("output_not_json");
  return JSON.parse(candidate);
}

/**
 * Calls the thin Astropods-hosted `/v1/language` endpoint. Prompts and schemas come from this repository;
 * the hosted service only authenticates, bounds, and forwards to the platform model gateway.
 */
export class HostedLanguageAdapter implements LanguageAdapter {
  constructor(private db: Db, private url: string, private token: string, private timeoutMs = 15_000) {}
  private get configured() { return !!this.url && !!this.token; }

  private async call(task: "extract_goal" | "explain_change", messages: unknown, maxTokens: number, scope: { sessionId: string; intentId: string }) {
    const requestId = randomUUID();
    const started = Date.now();
    const r = await fetch(this.url.replace(/\/$/, "") + "/v1/language", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: 1, task, requestId, scope: { merchant: "fixture-merchant-recart-audio", session: scope.sessionId }, versions: { prompt: PROMPT_VERSION, schema: SCHEMA_VERSION }, messages, maxTokens }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const body: any = await r.json().catch(() => null);
    if (!r.ok || !body?.ok) throw Object.assign(new Error(body?.error ?? `language service HTTP ${r.status}`), { durationMs: Date.now() - started });
    if (body.requestId !== requestId) throw new Error("echoed request id mismatch");
    return { content: String(body.content ?? ""), model: String(body.model ?? ""), usage: body.usage ?? null, durationMs: Date.now() - started };
  }

  private async record(row: { sessionId: string; intentId: string; task: string; status: string; model: string | null; request: unknown; response: unknown; usage: unknown; durationMs: number; error: string | null }) {
    const id = randomUUID();
    await this.db.query("insert into language_runs(id,session_id,intent_id,task,status,model,prompt_version,schema_version,request,response,usage,duration_ms,error,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)", [
      id, row.sessionId, row.intentId, row.task, row.status, row.model, PROMPT_VERSION, SCHEMA_VERSION, JSON.stringify(row.request), row.response === undefined ? null : JSON.stringify(row.response), row.usage === undefined ? null : JSON.stringify(row.usage), row.durationMs, row.error, clock.now(),
    ]);
    return id;
  }

  async extractGoal(a: { sessionId: string; intentId: string; text: string; referenceTime: Date; timezone: string }): Promise<ExtractResult> {
    const text = a.text.slice(0, 2000);
    const request = { text, referenceTime: a.referenceTime.toISOString(), timezone: a.timezone, postprocess: POSTPROCESS_VERSION };
    const started = Date.now();
    if (this.configured) {
      let raw: string | null = null;
      try {
        const out = await this.call("extract_goal", extractGoalMessages(text, a.referenceTime.toISOString(), a.timezone), 1024, a);
        raw = out.content;
        const parsed = extractionSchema.parse(parseJsonEnvelope(out.content));
        const extraction = flagBudgetConflict(normalizeRecordingDate(dropUnsupportedSpans(parsed, text), a.referenceTime, a.timezone), text);
        const runId = await this.record({ ...a, task: "extract_goal", status: "OK", model: out.model, request, response: extraction, usage: out.usage, durationMs: out.durationMs, error: null });
        return { status: "OK", source: "model", extraction, model: out.model, usage: out.usage, durationMs: out.durationMs, error: null, runId };
      } catch (e: any) {
        const extraction = rulesExtract(text, a.referenceTime, a.timezone);
        // Keep the model's raw reply (bounded) next to the fallback draft so malformed output can be diagnosed later.
        const response = raw === null ? extraction : { fallbackDraft: extraction, modelOutput: raw.slice(0, 4000) };
        const runId = await this.record({ ...a, task: "extract_goal", status: "FALLBACK", model: null, request, response, usage: null, durationMs: Date.now() - started, error: String(e?.message ?? e).slice(0, 300) });
        return { status: "FALLBACK", source: "rules", extraction, model: null, usage: null, durationMs: Date.now() - started, error: String(e?.message ?? e), runId };
      }
    }
    const extraction = rulesExtract(text, a.referenceTime, a.timezone);
    const runId = await this.record({ ...a, task: "extract_goal", status: "FALLBACK", model: null, request, response: extraction, usage: null, durationMs: Date.now() - started, error: "language service not configured" });
    return { status: "FALLBACK", source: "rules", extraction, model: null, usage: null, durationMs: Date.now() - started, error: "language service not configured", runId };
  }

  async explainChange(a: { sessionId: string; intentId: string; facts: ExplainFacts; fallback: ExplainResult }): Promise<ExplainResult> {
    if (!this.configured) return a.fallback;
    const started = Date.now();
    try {
      const out = await this.call("explain_change", explainChangeMessages(a.facts), 768, a);
      const parsed = z.object({ summary: z.string().min(1).max(600), options: z.array(z.object({ index: z.number().int().min(0).max(1), tradeoff: z.string().max(300) })).max(2) }).parse(parseJsonEnvelope(out.content));
      const problem = groundingProblem(parsed.summary + " " + parsed.options.map((o) => o.tradeoff).join(" "), a.facts);
      if (problem) {
        await this.record({ ...a, task: "explain_change", status: "FALLBACK", model: out.model, request: a.facts, response: parsed, usage: out.usage, durationMs: out.durationMs, error: "ungrounded: " + problem });
        return { ...a.fallback, error: "ungrounded: " + problem };
      }
      await this.record({ ...a, task: "explain_change", status: "OK", model: out.model, request: a.facts, response: parsed, usage: out.usage, durationMs: out.durationMs, error: null });
      return { status: "OK", summary: parsed.summary, options: parsed.options, model: out.model, error: null };
    } catch (e: any) {
      await this.record({ ...a, task: "explain_change", status: "FALLBACK", model: null, request: a.facts, response: null, usage: null, durationMs: Date.now() - started, error: String(e?.message ?? e).slice(0, 300) });
      return { ...a.fallback, error: String(e?.message ?? e) };
    }
  }

  async health() {
    if (!this.configured) return { configured: false, reachable: null };
    try {
      const r = await fetch(this.url.replace(/\/$/, "") + "/health", { signal: AbortSignal.timeout(5000) });
      return { configured: true, reachable: r.ok };
    } catch (e: any) { return { configured: true, reachable: false, detail: String(e?.message ?? e) }; }
  }
}

/** A stated value must be supported by a span that actually occurs in the buyer text. */
function dropUnsupportedSpans(x: Extraction, text: string): Extraction {
  const lower = text.toLowerCase();
  const keep = <T extends { span: string } | null>(f: T): T | null => (f && f.span && lower.includes(f.span.toLowerCase()) ? f : null);
  const out: Extraction = { ...x };
  for (const k of ["localPeople", "remoteGuests", "hostPort", "os", "callApp", "recordingDate", "recordingTime"] as const) {
    const before = out[k];
    (out as any)[k] = keep(before as any);
    if (before && !(out as any)[k] && !out.unknowns.includes(k)) out.unknowns.push(k);
  }
  if (out.budgetCents && !lower.includes(out.budgetCents.span.toLowerCase())) { out.budgetCents = null; if (!out.unknowns.includes("budgetCents")) out.unknowns.push("budgetCents"); }
  return out;
}

/** Generated text may only mention dollar amounts and product names present in the deterministic facts. */
export function groundingProblem(text: string, facts: ExplainFacts): string | null {
  for (const m of text.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) ?? []) {
    const norm = m.replace(/\s/g, "");
    if (!facts.allowedMoney.includes(norm)) return `amount ${norm} not in facts`;
  }
  for (const m of text.match(/\b[A-Z]{2,4}-[A-Z0-9]{1,4}(?:-[A-Z0-9]{1,4})?\b/g) ?? []) {
    if (!facts.allowedNames.some((n) => n.includes(m))) return `reference ${m} not in facts`;
  }
  return null;
}
