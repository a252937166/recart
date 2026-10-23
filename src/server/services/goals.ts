import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ConfirmedGoal } from "../../domain/catalog/types.js";
import { clock } from "../clock.js";
import { AppError, audit } from "../context.js";
import { maybeOne, type Queryable, type Tx } from "../db/pool.js";

/** Goal form schema. Nulls are explicit "unknown" values; the solver asks for missing hard requirements. */
export const goalSchema = z.object({
  task: z.literal("podcast").default("podcast"),
  localPeople: z.number().int().min(1).max(8).nullable(),
  remoteGuests: z.number().int().min(0).max(8).nullable(),
  hostPort: z.enum(["usb-c", "usb-a", "usb-b"]).nullable(),
  os: z.enum(["macos", "windows", "linux"]).nullable(),
  callApp: z.enum(["zoom", "google-meet", "riverside", "other"]).nullable(),
  owned: z.object({ headphones: z.number().int().min(0).max(8), micCables: z.number().int().min(0).max(8), stands: z.number().int().min(0).max(8) }).default({ headphones: 0, micCables: 0, stands: 0 }),
  budgetCents: z.number().int().min(0).max(5_000_00).nullable(),
  pickupBy: z.string().datetime({ offset: true }).nullable(),
  timezone: z.string().min(1).max(64),
  preferences: z.object({ headphoneType: z.enum(["closed", "open"]).optional(), stand: z.enum(["desk", "boom"]).optional() }).default({}),
});

export function parseGoal(input: unknown): ConfirmedGoal {
  const r = goalSchema.safeParse(input);
  if (!r.success) throw new AppError(400, "bad_goal", "The requirements form has invalid values.", r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data as ConfirmedGoal;
}

export interface GoalRow { id: string; intent_id: string; version: number; data: ConfirmedGoal; source: string; confirmed: boolean; confirmed_at: Date | null }

/** Store a confirmed goal version. A new confirmed goal invalidates the intent's unaccepted quote. */
export async function confirmGoal(tx: Tx, args: { sessionId: string; intentId: string; goal: ConfirmedGoal; source: string }): Promise<GoalRow> {
  const now = clock.now();
  const prev = await maybeOne<{ v: number }>(tx, "select coalesce(max(version),0) v from goal_versions where intent_id=$1", [args.intentId]);
  const id = randomUUID();
  const version = (prev?.v ?? 0) + 1;
  await tx.query("insert into goal_versions(id,intent_id,version,data,source,confirmed,confirmed_at,created_at) values ($1,$2,$3,$4,$5,true,$6,$6)", [id, args.intentId, version, JSON.stringify(args.goal), args.source, now]);
  await tx.query("update intents set current_goal_id=$2, updated_at=$3 where id=$1", [args.intentId, id, now]);
  await tx.query("update quotes set status='SUPERSEDED', reason='goal changed' where intent_id=$1 and status='PUBLISHED'", [args.intentId]);
  await audit(tx, { sessionId: args.sessionId, intentId: args.intentId, actor: "buyer", action: "goal.confirmed", entity: "goal_version", entityId: id, detail: { version, source: args.source } });
  return { id, intent_id: args.intentId, version, data: args.goal, source: args.source, confirmed: true, confirmed_at: now };
}

export async function currentGoal(q: Queryable, intentId: string): Promise<GoalRow | null> {
  return maybeOne<GoalRow>(q, "select g.* from goal_versions g join intents i on i.current_goal_id=g.id where i.id=$1", [intentId]);
}
