import { expect } from "vitest";
import { buildApp } from "../../src/server/http/app.js";
import { clock } from "../../src/server/clock.js";
import { referenceRecoveryRequest } from "../../src/platform/sandbox.js";
import { setup, type Harness } from "../integration/harness.js";

export type App = Awaited<ReturnType<typeof buildApp>>;
export interface P { h: Harness; app: App }

export async function platformSetup(overrides: Record<string, unknown> = {}): Promise<P> {
  const h = await setup();
  h.ctx.cfg = { ...h.ctx.cfg, SANDBOX_SIGNUPS_PER_HOUR: 1000, ...overrides } as any;
  const app = await buildApp(h.ctx);
  return { h, app };
}

export function api(p: P) {
  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, key?: string | null, payload?: unknown, headers: Record<string, string> = {}) =>
    p.app.inject({ method, url, headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as any } : {}) });
  const sandbox = async (name = "Test audio store") => {
    const r = await call("POST", "/v1/sandbox/merchants", null, { name });
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  };
  const createReference = async (key: string, budget = 45000, extra: Record<string, unknown> = {}) => {
    const r = await call("POST", "/v1/recoveries", key, { ...referenceRecoveryRequest(budget), ...extra });
    expect(r.statusCode, r.body).toBe(201);
    return r.json();
  };
  const setStock = async (key: string, levels: Record<string, number>, location = "main") => {
    const r = await call("POST", "/v1/inventory/levels", key, { levels: Object.entries(levels).map(([product_id, available]) => ({ product_id, location_id: location, available, as_of: clock.now().toISOString() })) });
    expect(r.statusCode, r.body).toBe(200);
    return r.json();
  };
  return { call, sandbox, createReference, setStock };
}

/** Remove fields that legitimately differ between two computations of the same plan. */
export function stable(x: any): any {
  if (Array.isArray(x)) return x.map(stable);
  if (x && typeof x === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(x)) if (!["duration_ms", "planned_at", "id", "recovery_id", "hash", "created_at", "updated_at", "expires_at", "external_order_id"].includes(k)) out[k] = stable(v);
    return out;
  }
  return x;
}
