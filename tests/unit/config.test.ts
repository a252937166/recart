import { describe, expect, it } from "vitest";
import { faultInjectionRefusal } from "../../src/server/config.js";

describe("PP04 fault injection guard", () => {
  const base = { PAYPAL_FAULT_INJECTION: "1" as const, PUBLIC_BASE_URL: "http://127.0.0.1:4060", HOST: "127.0.0.1" };

  it("is inert when the switch is off, even on a public server", () => {
    expect(faultInjectionRefusal({ ...base, PAYPAL_FAULT_INJECTION: "0", PUBLIC_BASE_URL: "https://recart.axiqo.xyz", HOST: "0.0.0.0" })).toBeNull();
  });

  it("allows a loopback-only local server", () => {
    expect(faultInjectionRefusal(base)).toBeNull();
    expect(faultInjectionRefusal({ ...base, PUBLIC_BASE_URL: "http://localhost:4060", HOST: "localhost" })).toBeNull();
  });

  it("refuses a public base URL or a non-loopback listener", () => {
    expect(faultInjectionRefusal({ ...base, PUBLIC_BASE_URL: "https://recart.axiqo.xyz" })).toMatch(/loopback/);
    expect(faultInjectionRefusal({ ...base, HOST: "0.0.0.0" })).toMatch(/loopback/);
    expect(faultInjectionRefusal({ ...base, PUBLIC_BASE_URL: "http://127.0.0.1.example.com:4060" })).toMatch(/loopback/);
  });
});
