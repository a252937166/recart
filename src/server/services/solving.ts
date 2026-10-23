import { randomUUID } from "node:crypto";
import { solve, type SolveResult } from "../../domain/solver/solver.js";
import { clock } from "../clock.js";
import { AppError, audit } from "../context.js";
import { maybeOne, type Queryable } from "../db/pool.js";
import { currentGoal } from "./goals.js";
import { availabilityFor } from "./inventory.js";

export interface SolveRunRow { id: string; intent_id: string; goal_id: string; purpose: string; status: string; result: SolveResult; availability: Record<string, number>; created_at: Date }

/** Run the deterministic solver for the intent's confirmed goal and persist the run with all input versions. */
export async function runSolve(q: Queryable, args: { sessionId: string; intentId: string; purpose: "initial" | "recovery"; originalLines?: { sku: string; qty: number }[] }): Promise<SolveRunRow> {
  const goal = await currentGoal(q, args.intentId);
  if (!goal) throw new AppError(409, "no_goal", "Confirm the requirements first.");
  const availability = await availabilityFor(q, args.sessionId, args.intentId);
  const now = clock.now();
  const result = solve({ goal: goal.data, availability, now, ...(args.originalLines ? { original: args.originalLines } : {}) });
  const id = randomUUID();
  await q.query("insert into solve_runs(id,intent_id,goal_id,purpose,status,result,availability,combinations,feasible_count,duration_ms,created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [
    id, args.intentId, goal.id, args.purpose, result.status, JSON.stringify(result), JSON.stringify(availability), result.combinationsChecked, result.feasibleCount, result.durationMs, now,
  ]);
  await audit(q, { sessionId: args.sessionId, intentId: args.intentId, actor: "solver", action: "solve.completed", entity: "solve_run", entityId: id, detail: { purpose: args.purpose, status: result.status, combinations: result.combinationsChecked, feasible: result.feasibleCount } });
  return { id, intent_id: args.intentId, goal_id: goal.id, purpose: args.purpose, status: result.status, result, availability, created_at: now };
}

export async function getSolveRun(q: Queryable, id: string): Promise<SolveRunRow | null> {
  return maybeOne<SolveRunRow>(q, "select * from solve_runs where id=$1", [id]);
}
