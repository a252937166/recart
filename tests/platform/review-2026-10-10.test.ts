import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clock } from "../../src/server/clock.js";
import { drain, START } from "../integration/harness.js";
import { api, platformSetup, type P } from "./helpers.js";

/** Regressions for the platform acceptance review of 2026-10-10 (four reproduced defects). */
let p: P;
let A: ReturnType<typeof api>;
beforeAll(async () => { p = await platformSetup(); A = api(p); });
afterAll(async () => { await p.app.close(); await p.h.db.end(); });
beforeEach(() => { p.h.clock.set(START); });

async function approved(key: string) {
  const rec = await A.createReference(key);
  const token = (await A.call("POST", `/v1/recoveries/${rec.id}/review-links`, key, { expires_in_minutes: 10080 })).json().url.split("/review/")[1];
  const ok = await A.call("POST", `/api/review/${token}/decision`, null, { proposal_id: rec.proposal.id, proposal_hash: rec.proposal.hash, decision: "approve" });
  expect(ok.json().status).toBe("approved");
  return { rec, token };
}

describe("1. an approved but unexecuted version that expires can be refreshed and re-approved", () => {
  it("expires into the refreshable state, invalidates the approval and supports recompute", async () => {
    const s = await A.sandbox();
    const { rec } = await approved(s.api_key);
    p.h.clock.advanceMinutes(25 * 60);
    const now = (await A.call("GET", `/v1/recoveries/${rec.id}`, s.api_key)).json();
    expect(now.status).toBe("expired");
    expect(now.proposal.status).toBe("expired");
    expect(now.next_action.code).toBe("recompute_or_cancel");
    const ex = await A.call("POST", `/v1/recoveries/${rec.id}/executions`, s.api_key, { proposal_id: rec.proposal.id, proposal_hash: rec.proposal.hash });
    expect(ex.statusCode).toBe(410);
    expect(ex.json().error.code).toBe("proposal_expired");
    const re = await A.call("POST", `/v1/recoveries/${rec.id}/recompute`, s.api_key, {});
    expect(re.statusCode, re.body).toBe(200);
    expect(re.json().recovery.proposal).toMatchObject({ version: 2, status: "active", outcome: "proposal_ready" });
    expect(re.json().recovery.status).toBe("awaiting_buyer");
    const events = (await A.call("GET", "/v1/events?limit=100", s.api_key)).json().data;
    const expired = events.find((e: any) => e.type === "proposal.expired");
    expect(expired.data).toMatchObject({ previous_status: "approved", approval_invalidated: true });
  });

  it("the buyer can refresh an expired approval and approve the new version", async () => {
    const s = await A.sandbox();
    const { rec, token } = await approved(s.api_key);
    p.h.clock.advanceMinutes(25 * 60);
    const fresh = await A.call("POST", `/api/review/${token}/refresh`, null, {});
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(fresh.json().proposal.version).toBe(2);
    const v2 = fresh.json().proposal;
    const ok = await A.call("POST", `/api/review/${token}/decision`, null, { proposal_id: v2.id, proposal_hash: v2.hash, decision: "approve" });
    expect(ok.json().status).toBe("approved");
    const ex = await A.call("POST", `/v1/recoveries/${rec.id}/executions`, s.api_key, { proposal_id: v2.id, proposal_hash: v2.hash });
    expect(ex.statusCode, ex.body).toBe(201);
  });

  it("does not expire a recovery whose execution is pending or unknown", async () => {
    const s = await A.sandbox();
    const { rec } = await approved(s.api_key);
    const ex = (await A.call("POST", `/v1/recoveries/${rec.id}/executions`, s.api_key, { proposal_id: rec.proposal.id, proposal_hash: rec.proposal.hash })).json();
    await A.call("POST", `/v1/recoveries/${rec.id}/executions/${ex.execution.id}/acknowledgement`, s.api_key, { outcome: "unknown" });
    p.h.clock.advanceMinutes(25 * 60);
    const now = (await A.call("GET", `/v1/recoveries/${rec.id}`, s.api_key)).json();
    expect(now.status).toBe("reconciling");
    expect(now.proposal.status).toBe("approved");
    const done = (await A.call("POST", `/v1/recoveries/${rec.id}/executions/${ex.execution.id}/acknowledgement`, s.api_key, { outcome: "succeeded" })).json();
    expect(done.status).toBe("completed");
  });

  it("the maintenance job expires due approvals too", async () => {
    const s = await A.sandbox();
    const { rec } = await approved(s.api_key);
    p.h.clock.advanceMinutes(25 * 60);
    const { platformMaintenance } = await import("../../src/platform/recoveries.js");
    await platformMaintenance(p.h.ctx);
    const row = (await p.h.db.query("select status from recoveries where id=$1", [rec.id])).rows[0];
    expect(row.status).toBe("expired");
  });
});

describe("2. pagination never skips records that share a timestamp", () => {
  it("events: a composite cursor returns every event exactly once", async () => {
    const s = await A.sandbox();
    await A.createReference(s.api_key); // recovery.created and proposal.created share the controlled clock's timestamp
    const all = (await A.call("GET", "/v1/events?limit=100", s.api_key)).json().data.map((e: any) => e.id);
    expect(all.length).toBeGreaterThanOrEqual(2);
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: any = (await A.call("GET", `/v1/events?limit=1${after ? `&after=${after}` : ""}`, s.api_key)).json();
      seen.push(...page.data.map((e: any) => e.id));
      if (!page.has_more) break;
      after = page.next_after;
    }
    expect(seen).toEqual(all);
  });

  it("recoveries: a composite cursor returns every recovery exactly once", async () => {
    const s = await A.sandbox();
    for (let i = 0; i < 3; i++) await A.createReference(s.api_key, 45000, { external_order_id: `order-${i}` });
    const all = (await A.call("GET", "/v1/recoveries?limit=100", s.api_key)).json().data.map((r: any) => r.id);
    expect(all).toHaveLength(3);
    const seen: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: any = (await A.call("GET", `/v1/recoveries?limit=1${before ? `&before=${before}` : ""}`, s.api_key)).json();
      seen.push(...page.data.map((r: any) => r.id));
      if (!page.has_more) break;
      before = page.next_before;
    }
    expect(seen).toEqual(all);
  });

  it("has_more is false when the last page is exactly full", async () => {
    const s = await A.sandbox();
    await A.createReference(s.api_key);
    const all = (await A.call("GET", "/v1/events?limit=100", s.api_key)).json().data;
    const page = (await A.call("GET", `/v1/events?limit=${all.length}`, s.api_key)).json();
    expect(page.has_more).toBe(false);
  });
});

describe("3. fresh timestamps on unchanged counts resume a stale recovery", () => {
  it("re-plans when counts become usable again even though quantities are equal", async () => {
    const s = await A.sandbox();
    await p.h.db.query("update merchants set inventory_max_age_seconds=3600 where id=$1", [s.merchant.id]);
    p.h.clock.advanceMinutes(120);
    const rec = await A.createReference(s.api_key);
    expect(rec.proposal.outcome).toBe("inventory_stale");
    const levels = (await A.call("GET", "/v1/inventory/levels?limit=1000", s.api_key)).json().data;
    const r = (await A.call("POST", "/v1/inventory/levels", s.api_key, { levels: levels.map((l: any) => ({ product_id: l.product_id, location_id: l.location_id, available: l.available, as_of: clock.now().toISOString() })) })).json();
    expect(r).toMatchObject({ applied: 18, changed: 0 });
    await drain(p.h);
    const now = (await A.call("GET", `/v1/recoveries/${rec.id}`, s.api_key)).json();
    expect(now.proposal).toMatchObject({ version: 2, outcome: "proposal_ready" });
    const revised = (await A.call("GET", "/v1/events?limit=100", s.api_key)).json().data.filter((e: any) => e.type === "proposal.revised");
    expect(revised.at(-1).data.reason).toBe("inventory_refreshed");
  });
});
