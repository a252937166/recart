import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LanguageService } from "../../src/server/language/adapter.js";
import type { LanguageProvider } from "../../src/server/language/providers.js";
import { one } from "../../src/server/db/pool.js";
import { setup, START, type Harness } from "../integration/harness.js";

// The draft a live model returned for the guided demo's sample request on 23 Oct 2026: the operating system was read
// out of "USB-C laptop". The service must turn it into a question before anything reaches the buyer or the log.
const TEXT = "I need to record a podcast on Friday with two people in the room and one remote guest. I have a USB-C laptop. My total budget is $450. [support]";
const DRAFT = JSON.stringify({
  localPeople: { value: 2, span: "two people in the room" }, remoteGuests: { value: 1, span: "one remote guest" },
  hostPort: { value: "usb-c", span: "USB-C laptop" }, os: { value: "macos", span: "USB-C laptop" }, callApp: null,
  budgetCents: { value: 45000, span: "$450", allIn: true }, recordingDate: null, recordingTime: null,
  owned: { headphones: 0, micCables: 0, stands: 0 }, negations: [], unknowns: ["callApp"], conflicts: [],
  questions: ["Which app will the remote guest join through?"],
});
const provider: LanguageProvider = {
  name: "codex", configured: true, maxSeconds: (b) => b + 1,
  async complete() { return { content: DRAFT, model: "gpt-6-luna", usage: null, durationMs: 5 }; },
  async probe() { return { reachable: true, model: "gpt-6-luna" }; },
};

let h: Harness;
beforeAll(async () => { h = await setup(); });
afterAll(async () => { await h.db.end(); });

describe("the language service checks that quotes support their values", () => {
  it("asks for an operating system the model read from a quote about the port", async () => {
    const r = await new LanguageService(h.db, { primary: provider }).extractGoal({ sessionId: null as any, intentId: null as any, text: TEXT, referenceTime: START, timezone: "America/Los_Angeles" });
    expect(r).toMatchObject({ status: "OK", source: "model", provider: "codex" });
    expect(r.extraction.os).toBeNull();
    expect(r.extraction.hostPort).toEqual({ value: "usb-c", span: "USB-C laptop" });
    expect(r.extraction.unknowns).toEqual(expect.arrayContaining(["os", "callApp"]));
    expect(r.extraction.questions[0]).toBe("Which operating system does the laptop run?");
    const run = await one<any>(h.db, "select request, response from language_runs where request->>'text' like '%[support]%'");
    expect(run.request.postprocess).toBe("postprocess-v4");
    expect(run.response.os).toBeNull();
  });
});
