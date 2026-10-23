import { describe, expect, it } from "vitest";
import { authorizationHeader, curlExample, expiryOf, maskKey, mcpUrl } from "../../src/web/lib/trial.js";

// The developers page's trial key: judges get an isolated sandbox store without an account.
describe("trial key helpers", () => {
  const key = "rk_test_abcdefghijklmnopqrstuvwxyz0123";
  it("copies exactly what an agent needs", () => {
    expect(mcpUrl("https://recart.example")).toBe("https://recart.example/mcp");
    expect(authorizationHeader(key)).toBe(`Authorization: Bearer ${key}`);
    const curl = curlExample("https://recart.example", key);
    expect(curl).toContain(`-H 'Authorization: Bearer ${key}'`);
    expect(curl).toContain("https://recart.example/mcp");
    expect(curl).toContain('"method":"tools/list"');
  });
  it("masks the key on screen but never in the copied text", () => {
    expect(maskKey(key)).toBe("rk_test_abcd…0123");
    expect(maskKey(key)).not.toContain("efgh");
    expect(authorizationHeader(key)).toContain("efgh");
  });
  it("says how long the key has left, and when it expired", () => {
    const now = Date.parse("2026-10-10T10:00:00Z");
    expect(expiryOf("2026-10-13T09:58:00Z", now)).toEqual({ expired: false, label: "in 71 h 58 min" });
    expect(expiryOf("2026-10-10T10:05:30Z", now)).toEqual({ expired: false, label: "in 5 min" });
    expect(expiryOf("2026-10-10T10:00:00Z", now)).toEqual({ expired: true, label: "expired 1 min ago" });
    expect(expiryOf("2026-10-10T07:30:00Z", now)).toEqual({ expired: true, label: "expired 2 h 30 min ago" });
    expect(expiryOf(null, now)).toEqual({ expired: false, label: "expiry unknown" });
    expect(expiryOf("not a date", now)).toEqual({ expired: false, label: "expiry unknown" });
  });
});
