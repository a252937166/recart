import { z } from "zod";
import type { Queryable } from "../db/pool.js";
import { ProviderError, type CompletionRequest, type LanguageProvider, type Task } from "./providers.js";
import { fingerprint } from "../build-info.js";

fingerprint(import.meta.url, "language/faults.js");

/**
 * Operator-controlled fault simulation, scoped to one demo session or one merchant. It lets a production check prove
 * the proxy timeouts, the failover and the background explanation with a slow or failing upstream, while every other
 * caller keeps the real providers: a simulated failure never touches the shared cooldown or issues a probe. Rows are
 * written by the admin CLI (`language-fault`) and expire on their own.
 */
const action = z.object({
  /** Wait this long before the real call (or the simulated failure). It counts against the provider's time bound, as a slow real call would. */
  delay_ms: z.number().int().min(0).max(600_000).optional(),
  /** "ok" (default): the real provider answers after the delay; otherwise the call fails this way. */
  outcome: z.enum(["ok", "unreachable", "refused"]).optional(),
  status: z.number().int().min(400).max(599).optional(),
  message: z.string().max(200).optional(),
}).strict();
export const languageFaultSchema = z.object({
  task: z.enum(["extract_goal", "explain_change"]).optional(),
  primary: action.optional(),
  backup: action.optional(),
}).strict().refine((f) => f.primary || f.backup, { message: "a fault needs a primary or backup action" });
export type LanguageFault = z.infer<typeof languageFaultSchema>;
export type FaultAction = z.infer<typeof action>;

export const faultScopes = (scope: { sessionId: string | null; merchantId?: string | null | undefined }) =>
  [scope.sessionId ? `session:${scope.sessionId}` : null, scope.merchantId ? `merchant:${scope.merchantId}` : null].filter((s): s is string => !!s);

/** The active fault for this call's scope and task, if the operator set one. */
export async function loadFault(db: Queryable, a: Pick<CompletionRequest, "scope" | "task">, now: Date): Promise<LanguageFault | null> {
  const scopes = faultScopes(a.scope);
  if (!scopes.length) return null;
  const r = await db.query("select fault from language_faults where scope = any($1::text[]) and expires_at > $2 order by scope limit 1", [scopes, now]);
  const parsed = r.rows[0] ? languageFaultSchema.safeParse(r.rows[0].fault) : null;
  const f = parsed?.success ? parsed.data : null;
  return f && (!f.task || f.task === a.task) ? f : null;
}

export async function setFault(db: Queryable, scope: string, fault: LanguageFault, expiresAt: Date) {
  if (!/^(session|merchant):\S+$/.test(scope)) throw new Error("scope must be session:<id> or merchant:<id>");
  await db.query("insert into language_faults(scope,fault,expires_at) values ($1,$2,$3) on conflict (scope) do update set fault=excluded.fault, expires_at=excluded.expires_at, created_at=now()", [scope, JSON.stringify(languageFaultSchema.parse(fault)), expiresAt]);
}
export const clearFault = (db: Queryable, scope: string) => db.query("delete from language_faults where scope=$1", [scope]);
export const listFaults = (db: Queryable) => db.query("select scope, fault, expires_at, created_at from language_faults order by created_at").then((r) => r.rows as { scope: string; fault: LanguageFault; expires_at: Date; created_at: Date }[]);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Settle with the work, or fail when the time is up; a call abandoned this way can no longer surface as an error. */
function within<T>(work: Promise<T>, ms: number, timedOut: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timedOut()), ms); });
  work.catch(() => {});
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/**
 * The provider as the fault wants it to behave for this one call. A simulated delay is time the call has already
 * spent, exactly as with a slow real call: it counts against the provider's own bound (maxSeconds for this budget),
 * and the real call then gets only what is left of the budget and of the bound. So a faulted call can never take
 * longer than a real one could, and the worst case the proxy timeouts are sized for still holds. Probes are untouched.
 */
export function faultedProvider(p: LanguageProvider, spec: FaultAction | undefined, task: Task): LanguageProvider {
  if (!spec) return p;
  return {
    name: p.name,
    configured: p.configured,
    probe: () => p.probe(),
    maxSeconds: (b) => p.maxSeconds(b),
    async complete(a) {
      const boundMs = p.maxSeconds(a.budgetSeconds) * 1000;
      const delayMs = Math.min(spec.delay_ms ?? 0, boundMs);
      if (delayMs) await sleep(delayMs);
      const label = `simulated ${task} fault`;
      const timedOut = () => new ProviderError(`${p.name} unreachable: timed out (${label}: ${Math.round(delayMs / 1000)} s of the ${Math.round(boundMs / 1000)} s bound spent before the call)`, null, "unreachable", { kind: "network" });
      if (spec.outcome === "unreachable") throw new ProviderError(`${p.name} unreachable: ${label}`, null, "unreachable", { kind: "network" });
      if (spec.outcome === "refused") throw new ProviderError(`${p.name} HTTP ${spec.status ?? 503}: ${spec.message ?? label}`, spec.status ?? 503, "simulated", { kind: "refused" });
      const leftMs = boundMs - delayMs;
      if (leftMs <= 0) throw timedOut();
      const budgetLeft = Math.max(1, Math.floor(a.budgetSeconds - delayMs / 1000));
      return within(p.complete({ ...a, budgetSeconds: budgetLeft }), leftMs, timedOut);
    },
  };
}
