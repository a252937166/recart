import { randomUUID } from "node:crypto";
import type { PayPalApi, PayPalResponse, WebhookVerifyInput } from "./types.js";

/**
 * In-memory PayPal simulator for automated fault tests (verification layer 2 in spec §14).
 * Behaviour mirrors what the real Sandbox showed in the PP01–PP03 spike: idempotent request IDs,
 * AUTHORIZE orders, authorization -> capture/void, capture -> refund. It is never used for judge sessions.
 */
type Order = { id: string; status: string; total: string; approved: boolean; authorizationId?: string };
type Auth = { id: string; orderId: string; status: string; amount: string; captureId?: string };
type Cap = { id: string; authorizationId: string; status: string; amount: string; refundId?: string };
type Ref = { id: string; captureId: string; status: string; amount: string };

export class FakePayPal implements PayPalApi {
  readonly mode = "fake" as const;
  orders = new Map<string, Order>();
  auths = new Map<string, Auth>();
  caps = new Map<string, Cap>();
  refunds = new Map<string, Ref>();
  private replies = new Map<string, PayPalResponse>();
  /** Status a capture lands in (tests can force PENDING). */
  captureStatus: "COMPLETED" | "PENDING" = "COMPLETED";
  refundStatus: "COMPLETED" | "PENDING" = "COMPLETED";
  calls: string[] = [];

  private id(prefix: string) { return prefix + randomUUID().replace(/-/g, "").slice(0, 15).toUpperCase(); }
  private ok(status: number, body: any): PayPalResponse { return { status, body: structuredClone(body), debugId: "fake-" + randomUUID().slice(0, 8) }; }
  private err(status: number, issue: string): PayPalResponse { return { status, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue }] }, debugId: "fake-err" }; }
  private idem(requestId: string, kind: string, fn: () => PayPalResponse): PayPalResponse {
    const key = `${kind}:${requestId}`;
    const prior = this.replies.get(key);
    if (prior) return { ...prior, status: prior.status === 201 ? 200 : prior.status };
    const r = fn();
    if (r.status < 300) this.replies.set(key, r);
    return r;
  }
  approve(orderId: string) { const o = this.orders.get(orderId); if (!o) throw new Error("no order"); o.approved = true; o.status = "APPROVED"; }

  async createOrder(body: any, requestId: string) {
    this.calls.push("createOrder");
    return this.idem(requestId, "create", () => {
      const id = this.id("ORD");
      const total = body?.purchase_units?.[0]?.amount?.value ?? "0.00";
      const o: Order = { id, status: "PAYER_ACTION_REQUIRED", total, approved: false };
      this.orders.set(id, o);
      return this.ok(201, { id, status: o.status, links: [{ rel: "payer-action", href: `https://fake.paypal/checkoutnow?token=${id}` }] });
    });
  }
  async getOrder(orderId: string) {
    const o = this.orders.get(orderId);
    if (!o) return this.err(404, "RESOURCE_NOT_FOUND");
    const authorizations = o.authorizationId ? [{ id: o.authorizationId, status: this.auths.get(o.authorizationId)!.status }] : undefined;
    return this.ok(200, { id: o.id, status: o.status, purchase_units: [{ payments: authorizations ? { authorizations } : undefined }] });
  }
  async authorizeOrder(orderId: string, requestId: string) {
    this.calls.push("authorizeOrder");
    return this.idem(requestId, "authorize", () => {
      const o = this.orders.get(orderId);
      if (!o) return this.err(404, "RESOURCE_NOT_FOUND");
      if (!o.approved) return this.err(422, "ORDER_NOT_APPROVED");
      if (o.authorizationId) return this.err(422, "ORDER_ALREADY_AUTHORIZED");
      const a: Auth = { id: this.id("AUTH"), orderId, status: "CREATED", amount: o.total };
      this.auths.set(a.id, a); o.authorizationId = a.id; o.status = "COMPLETED";
      return this.ok(201, { id: o.id, status: "COMPLETED", purchase_units: [{ payments: { authorizations: [{ id: a.id, status: a.status, amount: { currency_code: "USD", value: a.amount } }] } }] });
    });
  }
  async getAuthorization(id: string) {
    const a = this.auths.get(id);
    return a ? this.ok(200, { id: a.id, status: a.status, amount: { currency_code: "USD", value: a.amount } }) : this.err(404, "RESOURCE_NOT_FOUND");
  }
  async captureAuthorization(id: string, body: any, requestId: string) {
    this.calls.push("captureAuthorization");
    return this.idem(requestId, "capture", () => {
      const a = this.auths.get(id);
      if (!a) return this.err(404, "RESOURCE_NOT_FOUND");
      if (a.status === "VOIDED") return this.err(422, "AUTHORIZATION_VOIDED");
      if (a.status === "CAPTURED") return this.err(422, "AUTHORIZATION_ALREADY_CAPTURED");
      const c: Cap = { id: this.id("CAP"), authorizationId: id, status: this.captureStatus, amount: body?.amount?.value ?? a.amount };
      this.caps.set(c.id, c); a.status = "CAPTURED"; a.captureId = c.id;
      return this.ok(201, { id: c.id, status: c.status, amount: { currency_code: "USD", value: c.amount } });
    });
  }
  async voidAuthorization(id: string, requestId: string) {
    this.calls.push("voidAuthorization");
    return this.idem(requestId, "void", () => {
      const a = this.auths.get(id);
      if (!a) return this.err(404, "RESOURCE_NOT_FOUND");
      if (a.status === "CAPTURED") return this.err(422, "PREVIOUSLY_CAPTURED");
      if (a.status === "VOIDED") return this.err(422, "AUTHORIZATION_ALREADY_VOIDED");
      a.status = "VOIDED";
      return this.ok(200, { id: a.id, status: "VOIDED" });
    });
  }
  async getCapture(id: string) {
    const c = this.caps.get(id);
    return c ? this.ok(200, { id: c.id, status: c.status, amount: { currency_code: "USD", value: c.amount } }) : this.err(404, "RESOURCE_NOT_FOUND");
  }
  async refundCapture(id: string, _body: unknown, requestId: string) {
    this.calls.push("refundCapture");
    return this.idem(requestId, "refund", () => {
      const c = this.caps.get(id);
      if (!c) return this.err(404, "RESOURCE_NOT_FOUND");
      if (c.refundId) return this.err(422, "CAPTURE_FULLY_REFUNDED");
      const r: Ref = { id: this.id("REF"), captureId: id, status: this.refundStatus, amount: c.amount };
      this.refunds.set(r.id, r); c.refundId = r.id; c.status = "REFUNDED";
      return this.ok(201, { id: r.id, status: r.status, amount: { currency_code: "USD", value: r.amount } });
    });
  }
  async getRefund(id: string) {
    const r = this.refunds.get(id);
    return r ? this.ok(200, { id: r.id, status: r.status, amount: { currency_code: "USD", value: r.amount } }) : this.err(404, "RESOURCE_NOT_FOUND");
  }
  async verifyWebhook(i: WebhookVerifyInput) {
    return this.ok(200, { verification_status: i.transmissionSig === "valid-signature" ? "SUCCESS" : "FAILURE" }) as PayPalResponse<{ verification_status: string }>;
  }
  async createWebhook(url: string) { return this.ok(201, { id: "WH-FAKE", url }); }
  async listWebhooks() { return this.ok(200, { webhooks: [] }); }
}
