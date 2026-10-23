// Minimal client for ReCart's published REST API (no SDK needed).
export class ReCartError extends Error {
  constructor(status, body) { super(`ReCart HTTP ${status} ${body?.error?.code ?? ""}: ${body?.error?.message ?? ""}`); this.status = status; this.body = body; }
}

export class ReCartClient {
  constructor({ baseUrl, apiKey, fetchImpl }) { this.base = baseUrl.replace(/\/$/, ""); this.key = apiKey; this.fetch = fetchImpl ?? fetch; }
  async call(method, path, body, { idempotencyKey } = {}) {
    for (let attempt = 0; ; attempt++) {
      const r = await this.fetch(this.base + path, {
        method,
        headers: { authorization: `Bearer ${this.key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await r.json().catch(() => ({}));
      // Network-level retries are safe for idempotent requests; 429 and 5xx are retried with backoff.
      if ((r.status === 429 || r.status >= 500) && attempt < 3) { await new Promise((res) => setTimeout(res, Number(r.headers.get("retry-after") ?? 0) * 1000 || 500 * 2 ** attempt)); continue; }
      if (!r.ok) throw new ReCartError(r.status, json);
      return json;
    }
  }
}
