import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as C from "../../src/platform/contract.js";
import { signCallback, verifyCallback } from "../../src/platform/core.js";
import { clock } from "../../src/server/clock.js";
import { drain, START } from "../integration/harness.js";
import { api, platformSetup, type P } from "./helpers.js";

let p: P;
let A: ReturnType<typeof api>;
beforeAll(async () => { p = await platformSetup(); A = api(p); });
afterAll(async () => { await p.app.close(); await p.h.db.end(); });
beforeEach(() => { p.h.clock.set(START); });

describe("sandbox merchant and the reference order", () => {
  it("seeds a fictional catalog and proposes the whole-bundle recovery with exact money", async () => {
    const s = await A.sandbox();
    expect(s.api_key).toMatch(/^rk_test_/);
    expect(s.seed.products).toBe(18);
    const products = (await A.call("GET", "/v1/catalog/products?limit=100", s.api_key)).json();
    expect(C.ProductList.parse(products).data).toHaveLength(18);
    const rec = C.Recovery.parse(await A.createReference(s.api_key));
    expect(rec.status).toBe("awaiting_buyer");
    expect(rec.next_action.code).toBe("review_proposal");
    const prop = rec.proposal!;
    expect(prop.outcome).toBe("proposal_ready");
    expect(prop.approvable).toBe(true);
    expect(prop.original.totals.total_cents).toBe(37692);
    expect(prop.replacement!.totals).toEqual({ items_cents: 39100, shipping_cents: 0, tax_cents: 3128, total_cents: 42228 });
    expect(prop.replacement!.difference_cents).toBe(4536);
    expect(prop.replacement!.budget).toEqual({ max_total_cents: 45000, remaining_cents: 2772 });
    expect(prop.replacement!.items.filter((i) => i.change === "added").map((i) => i.product_id).sort()).toEqual(["ADP-AC", "CBL-BA-1", "IF-2B-LB"]);
    expect(prop.replacement!.removed_items.map((i) => [i.product_id, i.reason])).toEqual([["IF-2C-LB", "unavailable"], ["CBL-CC-1", "replaced"]]);
    expect(prop.changes.map((c) => c.role)).toEqual(["interface", "host_cable", "adapter"]);
    expect(prop.replacement!.compatibility.every((c) => c.result === "pass")).toBe(true);
    expect(prop.single_item_swaps.length).toBeGreaterThan(0);
    expect(prop.single_item_swaps.every((s) => !s.works)).toBe(true);
    expect(prop.search).toMatchObject({ combinations_checked: 480, feasible_count: 3, complete: true });
    expect(prop.summary).toContain("$422.28");
  });

  it("keeps the merchant's agreed prices for items already in the order and counts shipping against the limit", async () => {
    const s = await A.sandbox();
    const body = { ...(await import("../../src/platform/sandbox.js")).referenceRecoveryRequest(45000), shipping_cents: 3000 };
    body.original_items = body.original_items.map((i) => (i.product_id === "MIC-DX-A" ? { ...i, unit_price_cents: 4000 } : i)) as any;
    const r = (await A.call("POST", "/v1/recovery-previews", s.api_key, body)).json();
    C.RecoveryPreviewResult.parse(r);
    expect(r.persisted).toBe(false);
    const mic = r.replacement.items.find((i: any) => i.product_id === "MIC-DX-A");
    expect(mic.unit_price_cents).toBe(4000);
    expect(r.replacement.totals.shipping_cents).toBe(3000);
    expect(r.replacement.totals.total_cents).toBe(r.replacement.totals.items_cents + r.replacement.totals.tax_cents + 3000);
    expect(r.replacement.totals.total_cents).toBeLessThanOrEqual(45000);
  });
});

describe("outcomes", () => {
  it("budget conflict: never relaxes the limit, states the required amount", async () => {
    const s = await A.sandbox();
    const rec = C.Recovery.parse(await A.createReference(s.api_key, 40000));
    expect(rec.proposal!.outcome).toBe("budget_conflict");
    expect(rec.proposal!.approvable).toBe(false);
    expect(rec.proposal!.conflict).toMatchObject({ type: "budget", required_max_total_cents: 42228, current_max_total_cents: 40000 });
    expect(rec.next_action).toMatchObject({ actor: "buyer", code: "raise_budget_or_decline" });
  });

  it("no supported bundle when no loopback interface is sellable", async () => {
    const s = await A.sandbox();
    await A.setStock(s.api_key, { "IF-2B-LB": 0, "IF-4C-LB": 0 });
    const rec = await A.createReference(s.api_key);
    expect(rec.proposal.outcome).toBe("no_supported_bundle");
    expect(rec.status).toBe("no_solution");
    expect(rec.proposal.replacement).toBeNull();
  });

  it("evidence incomplete: an undocumented fact is never treated as a yes", async () => {
    const s = await A.sandbox();
    await A.setStock(s.api_key, { "IF-2B-LB": 0, "IF-4C-LB": 0, "IF-2C-UK": 2 });
    const rec = await A.createReference(s.api_key);
    expect(rec.proposal.outcome).toBe("evidence_incomplete");
    expect(rec.proposal.unknown_facts).toContainEqual(expect.objectContaining({ product_id: "IF-2C-UK", attribute: "loopback" }));
    expect(rec.next_action.code).toBe("document_attributes");
  });

  it("no change needed when another location still has the missing item", async () => {
    const s = await A.sandbox();
    await A.setStock(s.api_key, { "IF-2C-LB": 1 }, "backroom");
    const body = { ...(await import("../../src/platform/sandbox.js")).referenceRecoveryRequest(), fulfillment: { location_ids: ["main", "backroom"] } };
    const rec = (await A.call("POST", "/v1/recoveries", s.api_key, body)).json();
    expect(rec.proposal.outcome).toBe("no_change_needed");
    expect(rec.proposal.replacement.difference_cents).toBe(0);
    expect(rec.next_action.code).toBe("fulfil_original_items");
  });

  it("needs clarification lists missing buyer requirements in the public names", async () => {
    const s = await A.sandbox();
    const body = (await import("../../src/platform/sandbox.js")).referenceRecoveryRequest();
    const r = (await A.call("POST", "/v1/recovery-previews", s.api_key, { ...body, requirements: { ...body.requirements, host_port: null, call_app: null } })).json();
    expect(r.outcome).toBe("needs_clarification");
    expect(r.missing_fields).toEqual(["host_port", "call_app"]);
  });

  it("inventory stale: old counts are not used, and the merchant is asked to refresh", async () => {
    const s = await A.sandbox();
    await p.h.db.query("update merchants set inventory_max_age_seconds=3600 where id=$1", [s.merchant.id]);
    p.h.clock.advanceMinutes(120);
    const rec = await A.createReference(s.api_key);
    expect(rec.proposal.outcome).toBe("inventory_stale");
    expect(rec.proposal.stale_products.map((x: any) => x.product_id).sort()).toEqual(["ADP-AC", "CBL-BA-1", "IF-2B-LB"]);
    expect(rec.next_action.code).toBe("refresh_inventory");
  });
});

describe("stock change revises an open proposal", () => {
  it("re-plans after inventory updates and emits proposal.revised with the cause", async () => {
    const s = await A.sandbox();
    const product = (await A.call("GET", "/v1/catalog/products/HP-OB-B", s.api_key)).json();
    const { inventory: _i, updated_at: _u, ...input } = product;
    await A.call("POST", "/v1/catalog/products", s.api_key, { products: [{ ...input, description: "Open-back headphones (edited)" }] });
    await drain(p.h);
    const rec = await A.createReference(s.api_key);
    p.h.clock.advanceMinutes(1);
    const up = await A.setStock(s.api_key, { "IF-2B-LB": 0, "IF-4C-LB": 0 });
    expect(up).toMatchObject({ applied: 2, changed: 2 });
    await drain(p.h);
    const v2 = (await A.call("GET", `/v1/recoveries/${rec.id}`, s.api_key)).json();
    expect(v2.proposal.version).toBe(2);
    expect(v2.proposal.outcome).toBe("no_supported_bundle");
    p.h.clock.advanceMinutes(1);
    await A.setStock(s.api_key, { "IF-2B-LB": 2 });
    await drain(p.h);
    const v3 = (await A.call("GET", `/v1/recoveries/${rec.id}`, s.api_key)).json();
    expect(v3.proposal.version).toBe(3);
    expect(v3.proposal.outcome).toBe("proposal_ready");
    const history = C.ProposalList.parse((await A.call("GET", `/v1/recoveries/${rec.id}/proposals`, s.api_key)).json());
    expect(history.data.map((x) => [x.version, x.status])).toEqual([[3, "active"], [2, "superseded"], [1, "superseded"]]);
    const events = C.EventList.parse((await A.call("GET", "/v1/events?limit=100", s.api_key)).json());
    const revised = events.data.filter((e) => e.type === "proposal.revised");
    expect(revised).toHaveLength(2);
    expect(revised.map((e) => e.data.reason)).toEqual(["inventory_changed", "inventory_changed"]);
  });

  it("ignores stock counts older than the stored one and repeated syncs without effect", async () => {
    const s = await A.sandbox();
    const rec = await A.createReference(s.api_key);
    const old = new Date(START.getTime() - 60_000).toISOString();
    const r = (await A.call("POST", "/v1/inventory/levels", s.api_key, { levels: [{ product_id: "IF-2B-LB", location_id: "main", available: 0, as_of: old }] })).json();
    expect(r).toMatchObject({ applied: 0, ignored_older_updates: 1, changed: 0 });
    await A.setStock(s.api_key, { "IF-2B-LB": 2 });
    await drain(p.h);
    expect((await A.call("GET", `/v1/recoveries/${rec.id}`, s.api_key)).json().proposal.version).toBe(1);
  });

  it("product updates: older source timestamps are ignored; changes bump the catalog version", async () => {
    const s = await A.sandbox();
    const product = (await A.call("GET", "/v1/catalog/products/ADP-AC", s.api_key)).json();
    const { inventory: _i, updated_at: _u, ...input } = product;
    const newer = { ...input, price_cents: 1500, source_updated_at: new Date(START.getTime() + 60_000).toISOString() };
    const r1 = C.CatalogUpsertResult.parse((await A.call("POST", "/v1/catalog/products", s.api_key, { products: [newer] })).json());
    expect(r1).toMatchObject({ catalog_version: 2, updated: 1 });
    const older = { ...input, price_cents: 900, source_updated_at: START.toISOString() };
    const r2 = (await A.call("POST", "/v1/catalog/products", s.api_key, { products: [older] })).json();
    expect(r2).toMatchObject({ catalog_version: 2, ignored_older_updates: 1 });
    expect((await A.call("GET", "/v1/catalog/products/ADP-AC", s.api_key)).json().price_cents).toBe(1500);
  });

  it("rejects products in another currency and malformed attributes with precise errors", async () => {
    const s = await A.sandbox();
    const bad = await A.call("POST", "/v1/catalog/products", s.api_key, { products: [{ product_id: "X", name: "X", role: "mic", price_cents: 100, currency: "EUR", status: "active", attributes: {} }] });
    expect(bad.statusCode).toBe(422);
    expect(C.ErrorResponse.parse(bad.json()).error.code).toBe("currency_mismatch");
    const shape = await A.call("POST", "/v1/catalog/products", s.api_key, { products: [{ product_id: "X", name: "X", role: "mic", price_cents: 100, currency: "USD", status: "active", attributes: { output: { value: "hdmi", evidence: "documented" } } }] });
    expect(shape.statusCode).toBe(422);
    expect(shape.json().error.details.issues[0].path).toContain("attributes.output.value");
  });
});

describe("authentication, scopes, isolation, idempotency", () => {
  it("requires a key and returns the documented error shape", async () => {
    const r = await A.call("GET", "/v1/recoveries");
    expect(r.statusCode).toBe(401);
    expect(C.ErrorResponse.parse(r.json()).error.code).toBe("invalid_api_key");
    expect(r.headers["recart-request-id"]).toMatch(/^req_/);
    const nf = await A.call("GET", "/v1/nope");
    expect(nf.statusCode).toBe(404);
    expect(C.ErrorResponse.parse(nf.json()).error.code).toBe("route_not_found");
  });

  it("keeps each merchant's data invisible to every other merchant", async () => {
    const a = await A.sandbox("Store A");
    const b = await A.sandbox("Store B");
    const rec = await A.createReference(a.api_key);
    expect((await A.call("GET", `/v1/recoveries/${rec.id}`, b.api_key)).statusCode).toBe(404);
    expect((await A.call("POST", `/v1/recoveries/${rec.id}/review-links`, b.api_key, {})).statusCode).toBe(404);
    expect((await A.call("GET", "/v1/recoveries", b.api_key)).json().data).toHaveLength(0);
    await A.setStock(b.api_key, { "IF-2B-LB": 0, "IF-4C-LB": 0 });
    await drain(p.h);
    expect((await A.call("GET", `/v1/recoveries/${rec.id}`, a.api_key)).json().proposal.version).toBe(1);
  });

  it("enforces key scopes and revocation", async () => {
    const s = await A.sandbox();
    const k = (await A.call("POST", "/v1/api-keys", s.api_key, { label: "catalog sync", scopes: ["catalog:write"] })).json();
    expect(k.scopes).toEqual(["catalog:write"]);
    const denied = await A.call("POST", "/v1/recoveries", k.key, (await import("../../src/platform/sandbox.js")).referenceRecoveryRequest());
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("missing_scope");
    expect((await A.call("DELETE", `/v1/api-keys/${k.id}`, s.api_key)).statusCode).toBe(200);
    expect((await A.call("GET", "/v1/merchant", k.key)).statusCode).toBe(401);
  });

  it("replays an identical retry and rejects a reused key with a different request", async () => {
    const s = await A.sandbox();
    const body = (await import("../../src/platform/sandbox.js")).referenceRecoveryRequest();
    const first = await A.call("POST", "/v1/recoveries", s.api_key, body, { "idempotency-key": "order-1001-recovery" });
    const again = await A.call("POST", "/v1/recoveries", s.api_key, body, { "idempotency-key": "order-1001-recovery" });
    expect(again.statusCode).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json().id).toBe(first.json().id);
    const other = await A.call("POST", "/v1/recoveries", s.api_key, { ...body, external_order_id: "order-2002" }, { "idempotency-key": "order-1001-recovery" });
    expect(other.statusCode).toBe(422);
    expect(other.json().error.code).toBe("idempotency_key_reused");
    expect((await A.call("GET", "/v1/recoveries", s.api_key)).json().data).toHaveLength(1);
  });

  it("validates order consistency", async () => {
    const s = await A.sandbox();
    const body = (await import("../../src/platform/sandbox.js")).referenceRecoveryRequest();
    const unknown = await A.call("POST", "/v1/recoveries", s.api_key, { ...body, original_items: [...body.original_items, { product_id: "NOPE", quantity: 1 }] });
    expect(unknown.json().error).toMatchObject({ code: "unknown_product", details: { product_ids: ["NOPE"] } });
    const notInOrder = await A.call("POST", "/v1/recoveries", s.api_key, { ...body, unavailable_items: [{ product_id: "ADP-AC", quantity: 1, reason: "damaged" }] });
    expect(notInOrder.json().error.code).toBe("unavailable_item_not_in_order");
    const deadline = await A.call("POST", "/v1/recoveries", s.api_key, { ...body, requirements: { ...body.requirements, needed_by: "2026-10-16T17:00:00Z" } });
    expect(deadline.json().error.code).toBe("ready_at_required");
  });
});

describe("buyer review, exact-version approval and execution", () => {
  it("approves only the exact current version and records the decision once", async () => {
    const s = await A.sandbox();
    const rec = await A.createReference(s.api_key);
    const link = C.ReviewLink.parse((await A.call("POST", `/v1/recoveries/${rec.id}/review-links`, s.api_key, { expires_in_minutes: 60 })).json());
    const token = link.url.split("/review/")[1]!;
    const view = (await A.call("GET", `/api/review/${token}`)).json();
    expect(view.decisions).toEqual(["approve", "decline"]);
    expect(view.boundary).toContain("ReCart reserves no stock and moves no money");
    const wrong = await A.call("POST", `/api/review/${token}/decision`, null, { proposal_id: rec.proposal.id, proposal_hash: "0".repeat(64), decision: "approve" });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error.code).toBe("proposal_hash_mismatch");
    const ok = await A.call("POST", `/api/review/${token}/decision`, null, { proposal_id: rec.proposal.id, proposal_hash: rec.proposal.hash, decision: "approve" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().status).toBe("approved");
    const twice = await A.call("POST", `/api/review/${token}/decision`, null, { proposal_id: rec.proposal.id, proposal_hash: rec.proposal.hash, decision: "approve" });
    expect(twice.statusCode).toBe(409);
    const after = C.Recovery.parse((await A.call("GET", `/v1/recoveries/${rec.id}`, s.api_key)).json());
    expect(after.status).toBe("approved");
    expect(after.next_action.code).toBe("start_execution");
  });

  it("the buyer can raise the limit on a budget conflict, then approve the new version", async () => {
    const s = await A.sandbox();
    const rec = await A.createReference(s.api_key, 40000);
    const token = (await A.call("POST", `/v1/recoveries/${rec.id}/review-links`, s.api_key, {})).json().url.split("/review/")[1];
    const view = (await A.call("GET", `/api/review/${token}`)).json();
    expect(view.decisions).toEqual(["raise_budget", "decline"]);
    const raised = (await A.call("POST", `/api/review/${token}/budget`, null, { proposal_id: rec.proposal.id, max_total_cents: 42228 })).json();
    expect(raised.proposal.version).toBe(2);
    expect(raised.proposal.outcome).toBe("proposal_ready");
    expect(raised.requirements.budget.max_total_cents).toBe(42228);
    const ok = await A.call("POST", `/api/review/${token}/decision`, null, { proposal_id: raised.proposal.id, proposal_hash: raised.proposal.hash, decision: "approve" });
    expect(ok.json().status).toBe("approved");
    const events = (await A.call("GET", "/v1/events?limit=100", s.api_key)).json().data.map((e: any) => e.type);
    expect(events).toEqual(expect.arrayContaining(["recovery.requirements_updated", "proposal.revised", "proposal.approved"]));
  });

  it("execution revalidates, refuses retries while an outcome is unknown, and completes on acknowledgement", async () => {
    const s = await A.sandbox();
    const rec = await A.createReference(s.api_key);
    const token = (await A.call("POST", `/v1/recoveries/${rec.id}/review-links`, s.api_key, {})).json().url.split("/review/")[1];
    await A.call("POST", `/api/review/${token}/decision`, null, { proposal_id: rec.proposal.id, proposal_hash: rec.proposal.hash, decision: "approve" });
    const ex = await A.call("POST", `/v1/recoveries/${rec.id}/executions`, s.api_key, { proposal_id: rec.proposal.id, proposal_hash: rec.proposal.hash }, { "idempotency-key": "exec-1" });
    expect(ex.statusCode, ex.body).toBe(201);
    const started = C.ExecutionStarted.parse(ex.json());
    expect(started.apply.totals.total_cents).toBe(42228);
    expect(started.recovery.status).toBe("executing");
    const eid = started.execution.id;
    const unknown = (await A.call("POST", `/v1/recoveries/${rec.id}/executions/${eid}/acknowledgement`, s.api_key, { outcome: "unknown", message: "order edit timed out" })).json();
    expect(unknown.status).toBe("reconciling");
    expect(unknown.next_action.code).toBe("reconcile_unknown_outcome");
    const retry = await A.call("POST", `/v1/recoveries/${rec.id}/executions`, s.api_key, { proposal_id: rec.proposal.id, proposal_hash: rec.proposal.hash });
    expect(retry.json().error.code).toBe("execution_unresolved");
    const done = (await A.call("POST", `/v1/recoveries/${rec.id}/executions/${eid}/acknowledgement`, s.api_key, { outcome: "succeeded", external_reference: "order-edit-77" })).json();
    expect(done.status).toBe("completed");
    expect(done.latest_execution).toMatchObject({ status: "succeeded", external_reference: "order-edit-77" });
    const late = await A.call("POST", `/v1/recoveries/${rec.id}/executions/${eid}/acknowledgement`, s.api_key, { outcome: "failed" });
    expect(late.json().error.code).toBe("execution_already_resolved");
  });

  it("an approved version that no longer passes is not executed; the buyer reviews a revised version", async () => {
    const s = await A.sandbox();
    const rec = await A.createReference(s.api_key);
    const token = (await A.call("POST", `/v1/recoveries/${rec.id}/review-links`, s.api_key, {})).json().url.split("/review/")[1];
    await A.call("POST", `/api/review/${token}/decision`, null, { proposal_id: rec.proposal.id, proposal_hash: rec.proposal.hash, decision: "approve" });
    p.h.clock.advanceMinutes(1);
    await A.setStock(s.api_key, { "IF-2B-LB": 0 });
    await drain(p.h);
    expect((await A.call("GET", `/v1/recoveries/${rec.id}`, s.api_key)).json().status).toBe("approved");
    const ex = await A.call("POST", `/v1/recoveries/${rec.id}/executions`, s.api_key, { proposal_id: rec.proposal.id, proposal_hash: rec.proposal.hash });
    expect(ex.statusCode).toBe(409);
    expect(ex.json().error.code).toBe("proposal_invalidated");
    const now = (await A.call("GET", `/v1/recoveries/${rec.id}`, s.api_key)).json();
    expect(now.proposal.version).toBe(2);
    expect(now.status).toBe("awaiting_buyer");
  });

  it("approval re-plans first: a changed plan becomes a new version to review", async () => {
    const s = await A.sandbox();
    const rec = await A.createReference(s.api_key);
    const token = (await A.call("POST", `/v1/recoveries/${rec.id}/review-links`, s.api_key, {})).json().url.split("/review/")[1];
    await p.h.db.query("update inventory_levels set available=0 where merchant_id=$1 and product_id='IF-2B-LB'", [s.merchant.id]);
    const r = await A.call("POST", `/api/review/${token}/decision`, null, { proposal_id: rec.proposal.id, proposal_hash: rec.proposal.hash, decision: "approve" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe("proposal_superseded");
  });

  it("expired proposals stop being approvable; the buyer can refresh", async () => {
    const s = await A.sandbox();
    const rec = await A.createReference(s.api_key);
    const token = (await A.call("POST", `/v1/recoveries/${rec.id}/review-links`, s.api_key, { expires_in_minutes: 10080 })).json().url.split("/review/")[1];
    p.h.clock.advanceMinutes(25 * 60);
    const r = (await A.call("GET", `/v1/recoveries/${rec.id}`, s.api_key)).json();
    expect(r.status).toBe("expired");
    expect(r.proposal.status).toBe("expired");
    const late = await A.call("POST", `/api/review/${token}/decision`, null, { proposal_id: rec.proposal.id, proposal_hash: rec.proposal.hash, decision: "approve" });
    expect(late.statusCode).toBe(410);
    const fresh = (await A.call("POST", `/api/review/${token}/refresh`, null, {})).json();
    expect(fresh.proposal.version).toBe(2);
    expect(fresh.status).toBe("awaiting_buyer");
  });

  it("expired and unknown review links fail clearly", async () => {
    const s = await A.sandbox();
    const rec = await A.createReference(s.api_key);
    const token = (await A.call("POST", `/v1/recoveries/${rec.id}/review-links`, s.api_key, { expires_in_minutes: 5 })).json().url.split("/review/")[1];
    p.h.clock.advanceMinutes(6);
    expect((await A.call("GET", `/api/review/${token}`)).json().error.code).toBe("review_link_expired");
    expect((await A.call("GET", `/api/review/rvw_${"x".repeat(32)}`)).statusCode).toBe(404);
  });
});

describe("signed status notifications", () => {
  it("delivers signed events to the hosted inbox, which verifies them", async () => {
    const s = await A.sandbox();
    await A.createReference(s.api_key);
    await drain(p.h);
    const inbox = (await A.call("GET", "/v1/sandbox/inbox", s.api_key)).json();
    expect(inbox.data.length).toBeGreaterThanOrEqual(2);
    expect(inbox.data.every((m: any) => m.signature_valid === true)).toBe(true);
    expect(inbox.data.map((m: any) => m.event.type)).toEqual(expect.arrayContaining(["recovery.created", "proposal.created"]));
    const forged = await A.call("POST", `/v1/sandbox/inbox/${s.merchant.id}`, null, { id: "evt_fake", type: "proposal.approved" }, { "recart-signature": signCallback("whsec_wrong", "{}", Math.floor(clock.now().getTime() / 1000)) });
    expect(forged.statusCode).toBe(400);
  });

  it("signs with HMAC over timestamp and body and rejects tampering and replays", () => {
    const body = JSON.stringify({ id: "evt_1", type: "webhook.test" });
    const t = 1_800_000_000;
    const h = signCallback("whsec_secret", body, t);
    expect(verifyCallback("whsec_secret", body, h, t + 10)).toBe(true);
    expect(verifyCallback("whsec_secret", body + " ", h, t + 10)).toBe(false);
    expect(verifyCallback("whsec_other", body, h, t + 10)).toBe(false);
    expect(verifyCallback("whsec_secret", body, h, t + 301)).toBe(false);
  });

  it("refuses private or non-HTTPS callback URLs", async () => {
    const s = await A.sandbox();
    for (const url of ["http://example.com/hook", "https://127.0.0.1/hook", "https://localhost/hook", "https://user:pw@example.com/hook"]) {
      const r = await A.call("PUT", "/v1/webhook-endpoint", s.api_key, { url });
      expect(r.statusCode, url).toBe(422);
      expect(r.json().error.code).toBe("invalid_webhook_url");
    }
  });
});

describe("callbacks to the merchant's own endpoint", () => {
  let server: Server;
  let received: { headers: any; body: string }[] = [];
  let respond = 200;
  let q: P;
  let B: ReturnType<typeof api>;
  beforeAll(async () => {
    q = await platformSetup({ WEBHOOK_ALLOW_LOOPBACK: "true" });
    B = api(q);
    server = createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { received.push({ headers: req.headers, body: b }); res.statusCode = respond; res.end("ok"); }); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  });
  afterAll(async () => { server.close(); await q.app.close(); await q.h.db.end(); });

  it("retries with backoff until the endpoint accepts, then marks the delivery delivered", async () => {
    q.h.clock.set(START);
    const s = await B.sandbox();
    const port = (server.address() as any).port;
    const set = (await B.call("PUT", "/v1/webhook-endpoint?rotate_secret=true", s.api_key, { url: `http://127.0.0.1:${port}/hook` })).json();
    expect(set.secret).toMatch(/^whsec_/);
    respond = 500; received = [];
    await B.call("POST", "/v1/webhook-endpoint/test", s.api_key, {});
    await drain(q.h);
    let d = (await B.call("GET", "/v1/webhook-deliveries", s.api_key)).json().data[0];
    expect(d).toMatchObject({ status: "pending", attempts: 1, last_status_code: 500 });
    respond = 200;
    q.h.clock.advanceMinutes(1);
    await drain(q.h);
    d = (await B.call("GET", "/v1/webhook-deliveries", s.api_key)).json().data[0];
    expect(d).toMatchObject({ status: "delivered", attempts: 2, last_status_code: 200 });
    const last = received[received.length - 1]!;
    expect(verifyCallback(set.secret, last.body, last.headers["recart-signature"], Math.floor(clock.now().getTime() / 1000))).toBe(true);
    expect(JSON.parse(last.body).type).toBe("webhook.test");
  });
});

describe("published contract", () => {
  it("serves an OpenAPI 3.1 document whose operations exist and whose references resolve", async () => {
    const doc = (await A.call("GET", "/v1/openapi.json")).json();
    expect(doc.openapi).toBe("3.1.0");
    const refs = JSON.stringify(doc).match(/#\/components\/schemas\/\w+/g) ?? [];
    for (const r of new Set(refs)) expect(doc.components.schemas[r.split("/").pop()!], r).toBeTruthy();
    for (const [path, ops] of Object.entries<any>(doc.paths)) for (const method of Object.keys(ops)) {
      expect(p.app.hasRoute({ method: method.toUpperCase() as any, url: path.replace(/\{(\w+)\}/g, ":$1") }), `${method} ${path}`).toBe(true);
    }
    expect(Object.values<any>(doc.paths).reduce((n, ops) => n + Object.keys(ops).length, 0)).toBeGreaterThanOrEqual(32);
    expect(doc.webhooks.recartEvent.post.requestBody.content["application/json"].schema.$ref).toBe("#/components/schemas/Event");
  });

  it("capabilities describe the execution boundary, scopes and outcomes", async () => {
    const c = (await A.call("GET", "/v1/capabilities")).json();
    expect(c.boundary).toContain("Your systems own inventory, orders and checkout");
    expect(c.outcomes).toContain("budget_conflict");
    expect(c.authentication.scopes).toContain("recoveries:write");
  });

  it("the homepage preview is computed by the planner over the fictional store", async () => {
    const r = (await A.call("GET", "/api/showcase/preview")).json();
    expect(r.situations.map((s: any) => s.proposal.outcome)).toEqual(["proposal_ready", "budget_conflict", "no_supported_bundle"]);
    expect(r.situations[0].proposal.replacement.totals.total_cents).toBe(42228);
  });
});
