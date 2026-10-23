import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { clock } from "../clock.js";
import type { Config } from "../config.js";
import type { Db } from "../db/pool.js";
import { faultedProvider, loadFault } from "./faults.js";
import { CodexProvider, HostedProvider, PROBE_TIMEOUT_MS, ProviderError, type Completion, type CompletionRequest, type FailureKind, type LanguageProvider, type ProbeResult, type Task } from "./providers.js";
import { extractGoalMessages, explainChangeMessages, PROMPT_VERSION, SCHEMA_VERSION } from "./prompts.js";
import { flagBudgetConflict, normalizeRecordingDate, POSTPROCESS_VERSION } from "./dates.js";
import { rulesExtract } from "./rules.js";
import { fingerprint } from "../build-info.js";

fingerprint(import.meta.url, "language/adapter.js");

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

export interface ExtractResult { status: "OK" | "FALLBACK"; source: "model" | "rules"; extraction: Extraction; model: string | null; provider: "codex" | "hosted" | null; fallbackFrom: string | null; usage: Record<string, number> | null; durationMs: number; error: string | null; runId: string }
export interface ExplainResult { status: "OK" | "FALLBACK"; summary: string; options: { index: number; tradeoff: string }[]; model: string | null; error: string | null }

/** Who a language call is for: a hosted-demo session, or a platform merchant (no session; raw buyer text is not kept). */
export interface LanguageScope { sessionId: string | null; intentId: string | null; merchantId?: string | null | undefined }

export interface LanguageAdapter {
  extractGoal(a: LanguageScope & { text: string; referenceTime: Date; timezone: string }): Promise<ExtractResult>;
  explainChange(a: { sessionId: string; intentId: string; facts: ExplainFacts; fallback: ExplainResult }): Promise<ExplainResult>;
  health(): Promise<LanguageHealth>;
  /** The longest one call of this task can take (probe, primary with grace, backup, overhead); optional for test doubles. */
  worstCaseSeconds?(task: Task): number;
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

export interface Cooldown { until: number; kind: FailureKind; reason: string }
interface Hold { until: number; reason: string }
export interface ProviderHealth { configured: boolean; reachable: boolean | null; model?: string | null; detail?: string; coolingDown?: boolean; cooldown?: { kind: FailureKind; until: string; reason: string } | null }
export interface LanguageHealth { configured: boolean; reachable: boolean | null; detail?: string; active?: "codex" | "hosted" | "rules"; worstCaseSeconds?: { extract: number; explain: number }; providers?: Record<string, ProviderHealth> }

export interface FailoverOptions { cooldownMs?: number; probeTtlMs?: number; probeTimeoutMs?: number; extractBudgetSeconds?: number; explainBudgetSeconds?: number; now?: () => number }

/** Seconds allowed for recording the run and writing the response, on top of the provider calls. */
export const OVERHEAD_SECONDS = 5;
/** The longest a refusal's Retry-After may extend the cooldown. */
const MAX_RETRY_AFTER_MS = 3600_000;

/**
 * Runs the two bounded language tasks through a primary provider (the owner's Codex API gateway) with the hosted
 * Astropods endpoint as backup. The backup is used only when the primary cannot answer: it is unconfigured, its
 * call fails (unreachable, timed out, refused by the gateway, or an HTTP error), or it failed recently. After a
 * network failure, one shared status probe (at most one per TTL, however many requests wait) may end the cooldown
 * early; after a refusal (quota, queue, authentication) the configured cooldown runs its full length, because a
 * gateway that answers its status URL has not shown it can take requests. A well-formed answer that fails validation
 * is not a provider failure: that falls back to the rules or the template, as before. Prompts, schemas and
 * post-processing live in this repository.
 */
export class LanguageService implements LanguageAdapter {
  /**
   * Failure generation. Every primary failure that reaches the shared state increments it, and every probe or call
   * remembers the generation it started in: a result is evidence only about failures older than its own start, so a
   * probe, an answer or a cached health check from before a failure can never lift the hold that failure set.
   */
  private gen = 0;
  /** Kept apart so a network failure can never weaken or shorten a refusal; each hold only ever grows. */
  private refused: Hold | null = null;
  private network: Hold | null = null;
  /** The newest finished probe: when it started and ended, the generation it started in, and what it found. */
  private lastProbe: { startedAt: number; at: number; gen: number; result: ProbeResult } | null = null;
  /** The one status probe in flight, whatever generation it started in: probes never overlap. */
  private probing: { gen: number; startedAt: number; promise: Promise<ProbeResult>; waiters: number } | null = null;
  private lastProbeStartedAt: number | null = null;
  constructor(private db: Db, private providers: { primary?: LanguageProvider | null; backup?: LanguageProvider | null }, private opt: FailoverOptions = {}) {}
  private get now() { return this.opt.now?.() ?? Date.now(); }
  private get primary() { return this.providers.primary?.configured ? this.providers.primary : null; }
  private get backup() { return this.providers.backup?.configured ? this.providers.backup : null; }
  private get configured() { return !!(this.primary || this.backup); }
  private budget(task: Task) { return task === "extract_goal" ? this.opt.extractBudgetSeconds ?? 50 : this.opt.explainBudgetSeconds ?? 120; }

  /**
   * The worst case for one call: a status probe, the primary up to its deadline plus transport grace, then the
   * backup, then recording and answering. Every proxy read timeout on a route that drafts must cover it.
   */
  worstCaseSeconds(task: Task): number {
    const budget = this.budget(task);
    const probe = this.primary ? this.probeTimeoutMs / 1000 : 0;
    return probe + (this.primary?.maxSeconds(budget) ?? 0) + (this.backup?.maxSeconds(budget) ?? 0) + OVERHEAD_SECONDS;
  }

  /** A hold still in force, or null (an expired one is dropped). */
  private live(kind: FailureKind): Hold | null {
    const h = kind === "refused" ? this.refused : this.network;
    if (h && this.now < h.until) return h;
    if (kind === "refused") this.refused = null; else this.network = null;
    return null;
  }

  /** What health reports: a refusal outranks a network hold, since no probe can lift it. */
  private activeCooldown(): Cooldown | null {
    const r = this.live("refused"), n = this.live("network");
    if (r) return { until: r.until, kind: "refused", reason: r.reason };
    if (n) return { until: n.until, kind: "network", reason: n.reason };
    return null;
  }

  private get probeTimeoutMs() { return this.opt.probeTimeoutMs ?? PROBE_TIMEOUT_MS; }
  private get probeIntervalMs() { return this.opt.probeTtlMs ?? 30_000; }

  /** For tests and diagnostics: the failure generation and the shared probe's state. */
  diagnostics() { return { generation: this.gen, probeInFlight: !!this.probing, probeGeneration: this.probing?.gen ?? null, probeWaiters: this.probing?.waiters ?? 0, cooldown: this.activeCooldown() }; }

  /**
   * The single status-probe slot. If a probe is in flight, whatever generation it started in, that probe is returned
   * and no second one starts. A probe is bounded by the probe timeout here, whatever the provider does, so nobody
   * waits on it longer than the worst-case budget allows, and the slot is free again when it ends. A result is
   * recorded only if no probe that started later has already recorded one.
   */
  private probeSlot(p: LanguageProvider) {
    if (this.probing) return this.probing;
    const gen = this.gen, startedAt = this.now;
    const timedOut: ProbeResult = { reachable: false, detail: `status probe timed out after ${this.probeTimeoutMs} ms` };
    const bounded = new Promise<ProbeResult>((resolve) => {
      const timer = setTimeout(() => resolve(timedOut), this.probeTimeoutMs);
      timer.unref?.();
      p.probe().then(resolve, (e: any) => resolve({ reachable: false, detail: String(e?.message ?? e) })).finally(() => clearTimeout(timer));
    });
    const promise: Promise<ProbeResult> = bounded.then((result) => {
      if (!this.lastProbe || this.lastProbe.startedAt <= startedAt) this.lastProbe = { startedAt, at: this.now, gen, result };
      if (this.probing?.promise === promise) this.probing = null;
      return result;
    });
    this.lastProbeStartedAt = startedAt;
    return (this.probing = { gen, startedAt, promise, waiters: 0 });
  }

  /** Wait for a probe and say which generation its answer speaks for: the one it started in. */
  private join(flight: NonNullable<LanguageService["probing"]>): Promise<{ result: ProbeResult; gen: number }> {
    flight.waiters++;
    return flight.promise.then((result) => { flight.waiters--; return { result, gen: flight.gen }; });
  }

  /**
   * Evidence that the primary has recovered from the current network hold, or null for none yet. Fresh evidence is a
   * finished probe of the current generation younger than the interval. Otherwise a probe of the current generation
   * that is already running is joined. A probe still running from before the latest failure cannot speak for it, and
   * no second probe may start beside it, so the caller goes to the backup without waiting. A new probe starts only
   * when none is running and the interval since the last one started has passed.
   */
  private recoveryEvidence(p: LanguageProvider): Promise<{ result: ProbeResult; gen: number }> | null {
    const gen = this.gen;
    const c = this.lastProbe;
    if (c && c.gen === gen && this.now - c.at < this.probeIntervalMs) return Promise.resolve({ result: c.result, gen });
    if (this.probing) return this.probing.gen === gen ? this.join(this.probing) : null;
    if (this.lastProbeStartedAt !== null && this.now - this.lastProbeStartedAt < this.probeIntervalMs) return null;
    return this.join(this.probeSlot(p));
  }

  /** Providers to try in order: the primary unless it is held (a probe may lift a network hold), then the backup. */
  private async order(): Promise<LanguageProvider[]> {
    const out: LanguageProvider[] = [];
    const p = this.primary;
    if (p) {
      if (this.live("refused")) {
        // A refusal holds for its full length with no probe: a 200 from /v1/status says nothing about capacity.
      } else if (!this.live("network")) out.push(p);
      else {
        const evidence = await this.recoveryEvidence(p);
        // Recovery evidence must postdate every failure: if any failure (a refusal included) arrived after this probe
        // started, the probe is stale and the hold stays.
        if (evidence && evidence.result.reachable && evidence.gen === this.gen) { this.network = null; out.push(p); }
      }
    }
    if (this.backup) out.push(this.backup);
    return out;
  }

  /** A primary failure starts or extends its own kind of hold, and makes every older probe and call stale. */
  private recordFailure(e: unknown) {
    const kind: FailureKind = e instanceof ProviderError ? e.kind : "network";
    const retryAfterMs = e instanceof ProviderError && e.retryAfterSeconds !== null ? Math.min(e.retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS) : 0;
    const until = this.now + Math.max(this.opt.cooldownMs ?? 60_000, retryAfterMs);
    this.gen++;
    const cur = this.live(kind);
    const next: Hold = cur && cur.until >= until ? cur : { until, reason: String((e as any)?.message ?? e).slice(0, 200) };
    if (kind === "refused") this.refused = next; else this.network = next;
  }

  /** A primary answer lifts a network hold only if no failure was recorded after the call started. */
  private recordSuccess(startedGen: number) {
    if (this.gen === startedGen) this.network = null;
  }

  private async complete(a: CompletionRequest): Promise<Completion & { provider: string; fallbackFrom: string | null; errors: string[]; fault: unknown }> {
    const errors: string[] = [];
    let fallbackFrom: string | null = null;
    // An operator may have scoped a simulated delay or failure to this session or merchant. It shapes this call only:
    // the shared cooldown and probes are left alone, so other callers keep the real providers.
    const fault = await loadFault(this.db, a, clock.now());
    for (const real of await this.order()) {
      const isPrimary = real === this.primary;
      const p = fault ? faultedProvider(real, isPrimary ? fault.primary : fault.backup, a.task) : real;
      const startedGen = this.gen;
      try {
        const out = await p.complete(a);
        if (isPrimary && !fault) this.recordSuccess(startedGen);
        return { ...out, provider: p.name, fallbackFrom, errors, fault };
      } catch (e: any) {
        errors.push(`${p.name}: ${String(e?.message ?? e).slice(0, 200)}`);
        if (isPrimary) { fallbackFrom = p.name; if (!fault) this.recordFailure(e); }
      }
    }
    throw new Error(errors.length ? errors.join(" | ") : "language service not configured");
  }

  private async record(row: LanguageScope & { task: string; status: string; model: string | null; request: unknown; response: unknown; usage: unknown; durationMs: number; error: string | null }) {
    const id = randomUUID();
    await this.db.query("insert into language_runs(id,session_id,intent_id,merchant_id,task,status,model,prompt_version,schema_version,request,response,usage,duration_ms,error,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)", [
      id, row.sessionId, row.intentId, row.merchantId ?? null, row.task, row.status, row.model, PROMPT_VERSION, SCHEMA_VERSION, JSON.stringify(row.request), row.response === undefined ? null : JSON.stringify(row.response), row.usage === undefined ? null : JSON.stringify(row.usage), row.durationMs, row.error, clock.now(),
    ]);
    return id;
  }

  private note(request: Record<string, unknown>, out: { provider: string; fallbackFrom: string | null; errors: string[]; fault: unknown }) {
    Object.assign(request, { provider: out.provider, fallback_from: out.fallbackFrom, provider_errors: out.errors.length ? out.errors : undefined, ...(out.fault ? { simulated_fault: out.fault } : {}) });
  }

  async extractGoal(a: LanguageScope & { text: string; referenceTime: Date; timezone: string }): Promise<ExtractResult> {
    const text = a.text.slice(0, 2000);
    // Platform drafts keep only a fingerprint of the buyer's words; the structured draft is what matters.
    const kept = a.merchantId ? { textSha256: createHash("sha256").update(text).digest("hex"), textLength: text.length } : { text };
    const request: Record<string, unknown> = { ...kept, referenceTime: a.referenceTime.toISOString(), timezone: a.timezone, postprocess: POSTPROCESS_VERSION };
    const started = Date.now();
    if (this.configured) {
      let raw: string | null = null;
      try {
        const out = await this.complete({ task: "extract_goal", messages: extractGoalMessages(text, a.referenceTime.toISOString(), a.timezone), maxTokens: 1024, scope: a, budgetSeconds: this.budget("extract_goal") });
        this.note(request, out);
        raw = out.content;
        const parsed = extractionSchema.parse(parseJsonEnvelope(out.content));
        const extraction = flagBudgetConflict(normalizeRecordingDate(dropUnsupportedSpans(parsed, text), a.referenceTime, a.timezone), text);
        const runId = await this.record({ ...a, task: "extract_goal", status: "OK", model: out.model, request, response: extraction, usage: out.usage, durationMs: out.durationMs, error: null });
        return { status: "OK", source: "model", extraction, model: out.model, provider: out.provider as "codex" | "hosted", fallbackFrom: out.fallbackFrom, usage: out.usage, durationMs: out.durationMs, error: null, runId };
      } catch (e: any) {
        const extraction = rulesExtract(text, a.referenceTime, a.timezone);
        // Keep the model's raw reply (bounded) next to the fallback draft so malformed output can be diagnosed later.
        const response = raw === null ? extraction : { fallbackDraft: extraction, modelOutput: raw.slice(0, 4000) };
        const runId = await this.record({ ...a, task: "extract_goal", status: "FALLBACK", model: null, request, response, usage: null, durationMs: Date.now() - started, error: String(e?.message ?? e).slice(0, 300) });
        return { status: "FALLBACK", source: "rules", extraction, model: null, provider: null, fallbackFrom: null, usage: null, durationMs: Date.now() - started, error: String(e?.message ?? e), runId };
      }
    }
    const extraction = rulesExtract(text, a.referenceTime, a.timezone);
    const runId = await this.record({ ...a, task: "extract_goal", status: "FALLBACK", model: null, request, response: extraction, usage: null, durationMs: Date.now() - started, error: "language service not configured" });
    return { status: "FALLBACK", source: "rules", extraction, model: null, provider: null, fallbackFrom: null, usage: null, durationMs: Date.now() - started, error: "language service not configured", runId };
  }

  async explainChange(a: { sessionId: string; intentId: string; facts: ExplainFacts; fallback: ExplainResult }): Promise<ExplainResult> {
    if (!this.configured) return a.fallback;
    const started = Date.now();
    const request: Record<string, unknown> = { ...a.facts };
    try {
      const out = await this.complete({ task: "explain_change", messages: explainChangeMessages(a.facts), maxTokens: 768, scope: a, budgetSeconds: this.budget("explain_change") });
      this.note(request, out);
      const parsed = z.object({ summary: z.string().min(1).max(600), options: z.array(z.object({ index: z.number().int().min(0).max(1), tradeoff: z.string().max(300) })).max(2) }).parse(parseJsonEnvelope(out.content));
      const problem = groundingProblem(parsed.summary + " " + parsed.options.map((o) => o.tradeoff).join(" "), a.facts);
      if (problem) {
        await this.record({ ...a, task: "explain_change", status: "FALLBACK", model: out.model, request, response: parsed, usage: out.usage, durationMs: out.durationMs, error: "ungrounded: " + problem });
        return { ...a.fallback, error: "ungrounded: " + problem };
      }
      await this.record({ ...a, task: "explain_change", status: "OK", model: out.model, request, response: parsed, usage: out.usage, durationMs: out.durationMs, error: null });
      return { status: "OK", summary: parsed.summary, options: parsed.options, model: out.model, error: null };
    } catch (e: any) {
      await this.record({ ...a, task: "explain_change", status: "FALLBACK", model: null, request, response: null, usage: null, durationMs: Date.now() - started, error: String(e?.message ?? e).slice(0, 300) });
      return { ...a.fallback, error: String(e?.message ?? e) };
    }
  }

  async health(): Promise<LanguageHealth> {
    const p = this.providers.primary, b = this.providers.backup;
    // Health shares the one probe slot: it joins a probe in flight or starts one (reachability only; it lifts no hold).
    const codex = p?.configured ? await this.probeSlot(p).promise : null;
    const hosted = b?.configured ? await b.probe() : null;
    const cd = this.activeCooldown();
    const active: LanguageHealth["active"] = p?.configured && codex?.reachable && !cd ? "codex" : b?.configured && hosted?.reachable ? "hosted" : "rules";
    const providers: NonNullable<LanguageHealth["providers"]> = {};
    if (p) providers.codex = { configured: p.configured, reachable: codex?.reachable ?? null, model: codex?.model ?? null, ...(codex?.detail ? { detail: codex.detail } : {}), coolingDown: !!cd, cooldown: cd ? { kind: cd.kind, until: new Date(cd.until).toISOString(), reason: cd.reason } : null };
    if (b) providers.hosted = { configured: b.configured, reachable: hosted?.reachable ?? null, ...(hosted?.detail ? { detail: hosted.detail } : {}) };
    const worstCaseSeconds = { extract: this.worstCaseSeconds("extract_goal"), explain: this.worstCaseSeconds("explain_change") };
    if (!this.configured) return { configured: false, reachable: null, active, worstCaseSeconds, providers };
    const reachable = active !== "rules";
    return { configured: true, reachable, active, worstCaseSeconds, providers, ...(reachable ? {} : { detail: [codex?.detail, hosted?.detail].filter(Boolean).join("; ") || "no provider reachable" }) };
  }
}

/** The hosted endpoint alone (tests and the previous single-provider deployments). */
export class HostedLanguageAdapter extends LanguageService {
  constructor(db: Db, url: string, token: string, timeoutMs = 15_000) { super(db, { backup: new HostedProvider(url, token, { timeoutMs }) }); }
}

export type LanguageConfig = Pick<Config, "CODEX_API_URL" | "CODEX_API_KEY" | "CODEX_MODEL" | "CODEX_EFFORT" | "CODEX_DEADLINE_SECONDS" | "CODEX_EXPLAIN_DEADLINE_SECONDS" | "LANGUAGE_URL" | "LANGUAGE_TOKEN" | "LANGUAGE_PROVIDER" | "LANGUAGE_COOLDOWN_SECONDS">;

/** Providers from configuration: Codex first, the hosted endpoint as backup; LANGUAGE_PROVIDER can pin either. */
export function languageFromConfig(db: Db, cfg: LanguageConfig): LanguageService {
  const primary = cfg.LANGUAGE_PROVIDER === "hosted" ? null : new CodexProvider({ url: cfg.CODEX_API_URL, key: cfg.CODEX_API_KEY, model: cfg.CODEX_MODEL || undefined, effort: cfg.CODEX_EFFORT || undefined });
  const backup = cfg.LANGUAGE_PROVIDER === "codex" ? null : new HostedProvider(cfg.LANGUAGE_URL, cfg.LANGUAGE_TOKEN);
  return new LanguageService(db, { primary, backup }, { cooldownMs: cfg.LANGUAGE_COOLDOWN_SECONDS * 1000, extractBudgetSeconds: cfg.CODEX_DEADLINE_SECONDS, explainBudgetSeconds: cfg.CODEX_EXPLAIN_DEADLINE_SECONDS });
}

/**
 * The worst-case seconds a deployment with both providers configured needs for a draft or an explanation, from the
 * same budgets the service uses. The proxy's read timeouts (deploy/nginx-recart.conf) are checked against it.
 */
export function plannedWorstCaseSeconds(cfg: Pick<LanguageConfig, "CODEX_DEADLINE_SECONDS" | "CODEX_EXPLAIN_DEADLINE_SECONDS" | "LANGUAGE_COOLDOWN_SECONDS">, task: Task): number {
  const planned = languageFromConfig(null as unknown as Db, { ...cfg, CODEX_API_URL: "http://planned", CODEX_API_KEY: "planned", CODEX_MODEL: "", CODEX_EFFORT: "", LANGUAGE_URL: "http://planned", LANGUAGE_TOKEN: "planned", LANGUAGE_PROVIDER: "auto" });
  return planned.worstCaseSeconds(task);
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
