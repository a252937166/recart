import { describe, expect, it } from "vitest";
import { retryAtText } from "../../src/web/lib/retry.js";

describe("retry wording after a 429", () => {
  it("says when the quota resets, relative and absolute", () => {
    const now = Date.parse("2026-10-10T15:04:00Z");
    const text = retryAtText("2026-10-10T15:42:00Z", now)!;
    expect(text).toMatch(/^You can try again at .*\(in 38 min\)\.$/);
    expect(retryAtText("2026-10-10T15:04:10Z", now)).toMatch(/in 1 min/);
    expect(retryAtText(null, now)).toBeNull();
    expect(retryAtText("soon", now)).toBeNull();
  });
});
