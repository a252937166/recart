import { randomBytes, randomUUID } from "node:crypto";
import { SCENARIOS, type ScenarioId } from "../../domain/catalog/fixtures.js";
import { clock } from "../clock.js";
import { TIMING, type TimingPreset } from "../config.js";
import { AppError, audit, type Ctx } from "../context.js";
import { maybeOne, withTx, type Queryable } from "../db/pool.js";

export const SESSION_HOURS = 24;

export interface SessionRow {
  id: string; scenario: ScenarioId; preset: TimingPreset; status: "ACTIVE" | "CLOSING" | "CLOSED"; csrf_token: string;
  buyer_timezone: string; created_at: Date; expires_at: Date;
}

export function timingFor(s: Pick<SessionRow, "preset">) { return TIMING[s.preset]; }

/** Create an isolated demo session: its own fixture inventory, merchant scope, inbox and one purchase intent. */
export async function createSession(ctx: Ctx, opts: { scenario: ScenarioId; buyerTimezone?: string; preset?: TimingPreset }) {
  const scenario = SCENARIOS[opts.scenario];
  if (!scenario) throw new AppError(400, "bad_scenario", "Unknown scenario");
  const tz = validTimezone(opts.buyerTimezone) ?? "America/Los_Angeles";
  const preset: TimingPreset = opts.preset ?? ctx.cfg.TIMING_PRESET;
  const id = randomUUID();
  const intentId = randomUUID();
  const csrf = randomBytes(24).toString("hex");
  const now = clock.now();
  const expires = new Date(now.getTime() + SESSION_HOURS * 3600_000);
  await withTx(ctx.db, async (tx) => {
    await tx.query("insert into demo_sessions(id,scenario,preset,csrf_token,buyer_timezone,created_at,expires_at) values ($1,$2,$3,$4,$5,$6,$7)", [id, scenario.id, preset, csrf, tz, now, expires]);
    for (const [sku, qty] of Object.entries(scenario.inventory)) {
      await tx.query("insert into inventory(session_id,sku,on_hand,updated_at) values ($1,$2,$3,$4)", [id, sku, qty, now]);
    }
    await tx.query("insert into intents(id,session_id,created_at,updated_at) values ($1,$2,$3,$3)", [intentId, id, now]);
    await audit(tx, { sessionId: id, intentId, actor: "system", action: "session.created", entity: "demo_session", entityId: id, detail: { scenario: scenario.id, preset } });
  });
  return { id, intentId, csrf, expiresAt: expires, scenario: scenario.id, preset };
}

export async function loadSession(q: Queryable, id: string | undefined | null): Promise<SessionRow | null> {
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return null;
  const s = await maybeOne<SessionRow>(q, "select * from demo_sessions where id=$1", [id]);
  if (!s) return null;
  if (s.expires_at.getTime() <= clock.now().getTime()) return null;
  return s;
}

/** Commands that create or move money are fenced once a session starts closing (spec §11 demo reset). */
export function assertSessionActive(s: SessionRow) {
  if (s.status !== "ACTIVE") throw new AppError(409, "session_closing", "This demo session has been closed. Start a separate demo to continue.");
}

export async function currentIntentId(q: Queryable, sessionId: string): Promise<string> {
  const row = await maybeOne<{ id: string }>(q, "select id from intents where session_id=$1 order by created_at desc limit 1", [sessionId]);
  if (!row) throw new AppError(404, "no_intent", "No purchase in this session");
  return row.id;
}

/** Fence an old session: no new financial commands; reconciliation of existing obligations continues. */
export async function closeSession(ctx: Ctx, sessionId: string) {
  await ctx.db.query("update demo_sessions set status='CLOSING', closing_at=$2 where id=$1 and status='ACTIVE'", [sessionId, clock.now()]);
  await audit(ctx.db, { sessionId, actor: "buyer", action: "session.closing" });
}

function validTimezone(tz: string | undefined): string | null {
  if (!tz) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return tz; } catch { return null; }
}
