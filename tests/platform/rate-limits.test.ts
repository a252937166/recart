import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformSetup, type P } from "./helpers.js";

// Quotas are counted per client address. Only the reverse proxy may say what that address is, a 429 says when the
// window resets, and the limits come from configuration.
const fwd = (p: P, remote: string, forwarded?: string, extra: Record<string, unknown> = {}) =>
  p.app.inject({ method: "POST", url: "/api/sessions", remoteAddress: remote, headers: { "content-type": "application/json", ...(forwarded ? { "x-forwarded-for": forwarded } : {}) }, payload: { scenario: "A" }, ...extra });

describe("rate-limit identity and Retry-After", () => {
  let p: P;
  beforeAll(async () => { p = await platformSetup({ DEMO_SESSIONS_PER_HOUR: 2, SANDBOX_SIGNUPS_PER_HOUR: 1, LANGUAGE_CALLS_PER_HOUR: 1 }); });
  afterAll(async () => { await p.app.close(); await p.h.db.end(); });

  it("counts the address the loopback proxy reports, and a client-forged prefix changes nothing", async () => {
    // nginx on this host forwards the real address; the app trusts loopback only (TRUST_PROXY default).
    expect((await fwd(p, "127.0.0.1", "203.0.113.5")).statusCode).toBe(200);
    expect((await fwd(p, "127.0.0.1", "203.0.113.5")).statusCode).toBe(200);
    const third = await fwd(p, "127.0.0.1", "203.0.113.5");
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: "too_many_sessions" });
    expect(third.json().message).toMatch(/Try again in \d+ minute/);
    const retry = Number(third.headers["retry-after"]);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(3600);
    expect(third.json().detail.retry_after_seconds).toBe(retry);
    expect(Date.parse(third.json().detail.retry_at)).toBeGreaterThan(Date.now());
    // A list where the client put its own value first (an appending proxy): the rightmost untrusted hop still wins.
    for (const forged of ["198.51.100.9, 203.0.113.5", "1.1.1.1, 2.2.2.2, 203.0.113.5"]) expect((await fwd(p, "127.0.0.1", forged)).statusCode).toBe(429);
    // Another real address has its own quota.
    expect((await fwd(p, "127.0.0.1", "203.0.113.6")).statusCode).toBe(200);
  });

  it("ignores X-Forwarded-For from anything that is not the proxy", async () => {
    expect((await fwd(p, "198.51.100.7", "1.1.1.1")).statusCode).toBe(200);
    expect((await fwd(p, "198.51.100.7", "2.2.2.2")).statusCode).toBe(200);
    expect((await fwd(p, "198.51.100.7", "3.3.3.3")).statusCode).toBe(429);
    expect((await fwd(p, "198.51.100.7")).statusCode).toBe(429);
    expect((await fwd(p, "198.51.100.8")).statusCode).toBe(200);
  });

  it("limits sandbox sign-ups per address separately, with Retry-After and the reset time", async () => {
    const make = (forwarded: string) => p.app.inject({ method: "POST", url: "/v1/sandbox/merchants", remoteAddress: "127.0.0.1", headers: { "content-type": "application/json", "x-forwarded-for": forwarded }, payload: { name: "Store" } });
    expect((await make("203.0.113.50")).statusCode).toBe(201);
    const r = await make("203.0.113.50");
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toMatchObject({ type: "rate_limited", code: "rate_limited" });
    expect(Number(r.headers["retry-after"])).toBe(r.json().error.details.retry_after_seconds);
    expect(Date.parse(r.json().error.details.retry_at)).toBeGreaterThan(Date.now());
    expect((await make("9.9.9.9, 203.0.113.50")).statusCode).toBe(429);
    expect((await make("203.0.113.51")).statusCode).toBe(201);
  });

  it("limits AI drafts per address separately from sessions, and the 429 says when", async () => {
    const s = await fwd(p, "127.0.0.1", "203.0.113.70");
    expect(s.statusCode).toBe(200);
    const cookie = s.cookies.find((c) => c.name === "recart_sid")!.value;
    const extract = () => p.app.inject({ method: "POST", url: "/api/goal/extract", remoteAddress: "127.0.0.1", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.70", "x-recart-csrf": s.json().csrf }, cookies: { recart_sid: cookie }, payload: { text: "Two people in the room and one remote guest, USB-C laptop, $450." } });
    expect((await extract()).statusCode).toBe(200);
    const r = await extract();
    expect(r.statusCode).toBe(429);
    expect(r.json()).toMatchObject({ error: "language_rate" });
    expect(r.json().message).toMatch(/form below still works/);
    expect(Number(r.headers["retry-after"])).toBeGreaterThan(0);
    expect(Date.parse(r.json().detail.retry_at)).toBeGreaterThan(Date.now());
  });
});

describe("TRUST_PROXY=none", () => {
  let p: P;
  beforeAll(async () => { p = await platformSetup({ DEMO_SESSIONS_PER_HOUR: 1, TRUST_PROXY: "none" }); });
  afterAll(async () => { await p.app.close(); await p.h.db.end(); });
  it("uses the socket address even for headers from loopback", async () => {
    expect((await fwd(p, "127.0.0.1", "203.0.113.5")).statusCode).toBe(200);
    expect((await fwd(p, "127.0.0.1", "203.0.113.6")).statusCode).toBe(429);
    expect((await fwd(p, "10.0.0.2", "203.0.113.7")).statusCode).toBe(200);
  });
});
