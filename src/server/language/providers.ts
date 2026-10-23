import { randomUUID } from "node:crypto";
import { PROMPT_VERSION, SCHEMA_VERSION } from "./prompts.js";

export type Task = "extract_goal" | "explain_change";
export interface Completion { content: string; model: string; usage: Record<string, number> | null; durationMs: number }
export interface CompletionRequest { task: Task; messages: unknown; maxTokens: number; scope: { sessionId: string | null; merchantId?: string | null | undefined }; budgetSeconds: number }
export interface ProbeResult { reachable: boolean; model?: string | null; detail?: string }

/**
 * Why a provider could not answer. A "network" failure (unreachable, timed out, a proxy in front of the gateway
 * answering for it) may end early once a status probe reaches the gateway again. A "refused" failure is the gateway's
 * own answer (quota, queue, authentication, server error): a reachable gateway proves nothing about request capacity,
 * so the configured cooldown runs its full length.
 */
export type FailureKind = "network" | "refused";

/** One way to run a bounded language task. Errors thrown here mean the provider could not answer; the caller fails over. */
export interface LanguageProvider {
  readonly name: "codex" | "hosted";
  readonly configured: boolean;
  complete(a: CompletionRequest): Promise<Completion>;
  /** A cheap liveness check that never throws. */
  probe(): Promise<ProbeResult>;
  /** The longest one call can take for this budget, transport grace included. Proxy read timeouts are sized from it. */
  maxSeconds(budgetSeconds: number): number;
}
export class ProviderError extends Error {
  readonly kind: FailureKind;
  /** From a Retry-After header, when the gateway said how long to wait. */
  readonly retryAfterSeconds: number | null;
  constructor(message: string, readonly status: number | null, readonly code: string, o: { kind?: FailureKind; retryAfterSeconds?: number | null } = {}) {
    super(message);
    this.kind = o.kind ?? (status === null ? "network" : "refused");
    this.retryAfterSeconds = o.retryAfterSeconds ?? null;
  }
}
type FetchFn = typeof fetch;

/** Seconds a Retry-After header asks for (delay-seconds or an HTTP date), or null. */
export function retryAfterSeconds(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const n = Number(header.trim());
  if (Number.isFinite(n)) return n >= 0 ? n : null;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, Math.round((at - now) / 1000)) : null;
}

/** Transport grace: how long after the gateway's own deadline the HTTP call is allowed to run before it is abandoned. */
export const CODEX_GRACE_SECONDS = 15;
export const PROBE_TIMEOUT_MS = 5000;

/**
 * The owner's Codex API gateway: OpenAI-compatible chat completions in front of the Codex CLI, one request at a time
 * with a short queue. `deadline_s` makes the gateway refuse at once when its queue cannot answer in time, and
 * `timeout_s` bounds the run itself, so a busy gateway fails fast instead of holding the buyer's request.
 */
export class CodexProvider implements LanguageProvider {
  readonly name = "codex" as const;
  constructor(private o: { url: string; key: string; model?: string | undefined; effort?: string | undefined; fetchFn?: FetchFn | undefined; graceSeconds?: number | undefined }) {}
  get configured() { return !!this.o.url && !!this.o.key; }
  private get base() { return this.o.url.replace(/\/$/, ""); }
  private get fetchFn() { return this.o.fetchFn ?? fetch; }
  private get grace() { return this.o.graceSeconds ?? CODEX_GRACE_SECONDS; }
  maxSeconds(budgetSeconds: number) { return budgetSeconds + this.grace; }

  async complete(a: CompletionRequest): Promise<Completion> {
    const started = Date.now();
    const body: Record<string, unknown> = { messages: a.messages, stream: false, response_format: { type: "json_object" }, deadline_s: a.budgetSeconds, timeout_s: a.budgetSeconds };
    if (this.o.model) body.model = this.o.model;
    if (this.o.effort) body.effort = this.o.effort;
    let r: Response;
    try {
      r = await this.fetchFn(`${this.base}/v1/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${this.o.key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.maxSeconds(a.budgetSeconds) * 1000) });
    } catch (e: any) {
      throw new ProviderError(`codex unreachable: ${e?.name === "TimeoutError" ? "timed out" : String(e?.message ?? e)}`, null, "unreachable", { kind: "network" });
    }
    const j: any = await r.json().catch(() => null);
    if (!r.ok) {
      // The gateway answers errors as JSON. A bare 502/503/504 came from a proxy in front of it: the gateway itself is off the network.
      const fromGateway = !!j?.error;
      const kind: FailureKind = !fromGateway && [502, 503, 504].includes(r.status) ? "network" : "refused";
      throw new ProviderError(`codex HTTP ${r.status}: ${j?.error?.message ?? r.statusText}`, r.status, String(j?.error?.type ?? "http_error"), { kind, retryAfterSeconds: retryAfterSeconds(r.headers.get("retry-after")) });
    }
    const content = j?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new ProviderError("codex returned no message content", r.status, "empty_response");
    const u = j.usage ?? null;
    return { content, model: String(j.model ?? this.o.model ?? "codex"), usage: u ? { input_tokens: Number(u.prompt_tokens ?? 0), output_tokens: Number(u.completion_tokens ?? 0) } : null, durationMs: Date.now() - started };
  }

  async probe(): Promise<ProbeResult> {
    if (!this.configured) return { reachable: false, detail: "not configured" };
    try {
      const r = await this.fetchFn(`${this.base}/v1/status`, { headers: { Authorization: `Bearer ${this.o.key}` }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const j: any = await r.json().catch(() => null);
      if (!r.ok) return { reachable: false, detail: `HTTP ${r.status}: ${j?.error?.message ?? r.statusText}` };
      const waiting = j?.waiting && typeof j.waiting === "object" ? Object.values(j.waiting as Record<string, unknown>).reduce<number>((n, v) => n + (Number(v) || 0), 0) : 0;
      const busy = [j?.running ? "a request is running" : "", waiting ? `${waiting} waiting` : ""].filter(Boolean).join(", ");
      return { reachable: true, model: j?.model ?? this.o.model ?? null, ...(busy ? { detail: busy } : {}) };
    } catch (e: any) { return { reachable: false, detail: String(e?.message ?? e) }; }
  }
}

/** The thin Astropods-hosted `/v1/language` endpoint: it authenticates, bounds and forwards to the platform model gateway. */
export class HostedProvider implements LanguageProvider {
  readonly name = "hosted" as const;
  constructor(private url: string, private token: string, private o: { timeoutMs?: number | undefined; fetchFn?: FetchFn | undefined } = {}) {}
  get configured() { return !!this.url && !!this.token; }
  private get base() { return this.url.replace(/\/$/, ""); }
  private get fetchFn() { return this.o.fetchFn ?? fetch; }
  private get timeoutMs() { return this.o.timeoutMs ?? 15_000; }
  maxSeconds() { return this.timeoutMs / 1000; }

  async complete(a: CompletionRequest): Promise<Completion> {
    const requestId = randomUUID();
    const started = Date.now();
    let r: Response;
    try {
      r = await this.fetchFn(`${this.base}/v1/language`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ protocol: 1, task: a.task, requestId, scope: { merchant: a.scope.merchantId ?? "fixture-merchant-recart-audio", session: a.scope.sessionId ?? "platform-api" }, versions: { prompt: PROMPT_VERSION, schema: SCHEMA_VERSION }, messages: a.messages, maxTokens: a.maxTokens }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e: any) { throw new ProviderError(`language service unreachable: ${e?.name === "TimeoutError" ? "timed out" : String(e?.message ?? e)}`, null, "unreachable", { kind: "network" }); }
    const body: any = await r.json().catch(() => null);
    if (!r.ok || !body?.ok) throw new ProviderError(String(body?.error ?? `language service HTTP ${r.status}`), r.status, String(body?.error ?? "http_error"), { retryAfterSeconds: retryAfterSeconds(r.headers.get("retry-after")) });
    if (body.requestId !== requestId) throw new ProviderError("echoed request id mismatch", r.status, "request_id_mismatch");
    return { content: String(body.content ?? ""), model: String(body.model ?? ""), usage: body.usage ?? null, durationMs: Date.now() - started };
  }

  async probe(): Promise<ProbeResult> {
    if (!this.configured) return { reachable: false, detail: "not configured" };
    try {
      const r = await this.fetchFn(`${this.base}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return r.ok ? { reachable: true } : { reachable: false, detail: `HTTP ${r.status}` };
    } catch (e: any) { return { reachable: false, detail: String(e?.message ?? e) }; }
  }
}
