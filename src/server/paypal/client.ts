import type { PayPalApi, PayPalResponse, WebhookVerifyInput } from "./types.js";

/** PayPal REST client (Orders v2, Payments v2, Notifications). Secrets stay server-side. */
export class PayPalRestClient implements PayPalApi {
  readonly mode = "sandbox" as const;
  private token: { value: string; exp: number } | null = null;
  constructor(private base: string, private clientId: string, private secret: string, private timeoutMs = 20_000) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const r = await fetch(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: "Basic " + Buffer.from(`${this.clientId}:${this.secret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok) throw new Error(`paypal oauth failed: HTTP ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
    return this.token.value;
  }

  private async call(method: string, path: string, body?: unknown, requestId?: string): Promise<PayPalResponse> {
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json", Prefer: "return=representation" };
      if (requestId) headers["PayPal-Request-Id"] = requestId;
      const r = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs) });
      const text = await r.text();
      let json: any = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
      return { status: r.status, body: json, debugId: r.headers.get("paypal-debug-id") };
    } catch (e: any) {
      return { status: 0, body: null, debugId: null, networkError: e?.name === "TimeoutError" ? "timeout" : String(e?.message ?? e) };
    }
  }

  createOrder(body: unknown, requestId: string) { return this.call("POST", "/v2/checkout/orders", body, requestId); }
  getOrder(orderId: string) { return this.call("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`); }
  authorizeOrder(orderId: string, requestId: string) { return this.call("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}, requestId); }
  getAuthorization(id: string) { return this.call("GET", `/v2/payments/authorizations/${encodeURIComponent(id)}`); }
  captureAuthorization(id: string, body: unknown, requestId: string) { return this.call("POST", `/v2/payments/authorizations/${encodeURIComponent(id)}/capture`, body, requestId); }
  voidAuthorization(id: string, requestId: string) { return this.call("POST", `/v2/payments/authorizations/${encodeURIComponent(id)}/void`, undefined, requestId); }
  getCapture(id: string) { return this.call("GET", `/v2/payments/captures/${encodeURIComponent(id)}`); }
  refundCapture(id: string, body: unknown, requestId: string) { return this.call("POST", `/v2/payments/captures/${encodeURIComponent(id)}/refund`, body, requestId); }
  getRefund(id: string) { return this.call("GET", `/v2/payments/refunds/${encodeURIComponent(id)}`); }
  async verifyWebhook(i: WebhookVerifyInput) {
    // Splice the original event text in verbatim so re-serialization cannot change the signed bytes.
    const head = JSON.stringify({ auth_algo: i.authAlgo, cert_url: i.certUrl, transmission_id: i.transmissionId, transmission_sig: i.transmissionSig, transmission_time: i.transmissionTime, webhook_id: i.webhookId });
    const body = head.slice(0, -1) + ',"webhook_event":' + (i.rawEvent ?? JSON.stringify(i.event)) + "}";
    try {
      const r = await fetch(this.base + "/v1/notifications/verify-webhook-signature", { method: "POST", headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(this.timeoutMs) });
      const json: any = await r.json().catch(() => null);
      return { status: r.status, body: json, debugId: r.headers.get("paypal-debug-id") } as PayPalResponse<{ verification_status: string }>;
    } catch (e: any) {
      return { status: 0, body: null, debugId: null, networkError: String(e?.message ?? e) } as PayPalResponse<{ verification_status: string }>;
    }
  }
  /** Browser-safe client token for SDK v6 (fallback when clientId initialisation is not accepted). */
  async clientToken(domains: string[]): Promise<{ token: string; expiresIn: number }> {
    const form = new URLSearchParams({ grant_type: "client_credentials", response_type: "client_token" });
    for (const d of domains) form.append("domains[]", d);
    const r = await fetch(`${this.base}/v1/oauth2/token`, { method: "POST", headers: { Authorization: "Basic " + Buffer.from(`${this.clientId}:${this.secret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok) throw new Error(`client token failed: HTTP ${r.status}`);
    const j = (await r.json()) as { access_token: string; expires_in: number };
    return { token: j.access_token, expiresIn: j.expires_in };
  }
  createWebhook(url: string, eventTypes: string[]) { return this.call("POST", "/v1/notifications/webhooks", { url, event_types: eventTypes.map((name) => ({ name })) }); }
  listWebhooks() { return this.call("GET", "/v1/notifications/webhooks"); }
}

/**
 * Fault-injection wrapper: performs the real call, then optionally discards the response so the caller
 * sees an ambiguous outcome (status 0). Used by labeled tests such as PP04; never enabled for judges.
 */
export class LostResponseInjector implements PayPalApi {
  readonly mode;
  private drops = new Map<string, number>();
  constructor(readonly inner: PayPalApi) { this.mode = inner.mode; }
  dropNext(op: "createOrder" | "authorizeOrder" | "captureAuthorization" | "voidAuthorization" | "refundCapture", times = 1) { this.drops.set(op, times); }
  private async maybeDrop(op: string, p: Promise<PayPalResponse>): Promise<PayPalResponse> {
    const r = await p;
    const n = this.drops.get(op) ?? 0;
    if (n > 0) { this.drops.set(op, n - 1); return { status: 0, body: null, debugId: r.debugId, networkError: `injected: ${op} response discarded after provider status ${r.status}` }; }
    return r;
  }
  createOrder(b: unknown, id: string) { return this.maybeDrop("createOrder", this.inner.createOrder(b, id)); }
  getOrder(id: string) { return this.inner.getOrder(id); }
  authorizeOrder(o: string, id: string) { return this.maybeDrop("authorizeOrder", this.inner.authorizeOrder(o, id)); }
  getAuthorization(id: string) { return this.inner.getAuthorization(id); }
  captureAuthorization(a: string, b: unknown, id: string) { return this.maybeDrop("captureAuthorization", this.inner.captureAuthorization(a, b, id)); }
  voidAuthorization(a: string, id: string) { return this.maybeDrop("voidAuthorization", this.inner.voidAuthorization(a, id)); }
  getCapture(id: string) { return this.inner.getCapture(id); }
  refundCapture(c: string, b: unknown, id: string) { return this.maybeDrop("refundCapture", this.inner.refundCapture(c, b, id)); }
  getRefund(id: string) { return this.inner.getRefund(id); }
  verifyWebhook(i: WebhookVerifyInput) { return this.inner.verifyWebhook(i); }
  createWebhook(u: string, e: string[]) { return this.inner.createWebhook(u, e); }
  listWebhooks() { return this.inner.listWebhooks(); }
}
