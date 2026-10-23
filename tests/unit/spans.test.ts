import { describe, expect, it } from "vitest";
import { dropUnsupportedSpans, quoteNamesValue } from "../../src/server/language/spans.js";
import type { Extraction } from "../../src/server/language/adapter.js";

// The guided demo's sample request.
const TEXT = "I need to record a podcast on Friday with two people in the room and one remote guest. I have a USB-C laptop. My total budget is $450.";
const draft = (over: Partial<Extraction> = {}): Extraction => ({
  localPeople: { value: 2, span: "two people in the room" }, remoteGuests: { value: 1, span: "one remote guest" },
  hostPort: { value: "usb-c", span: "USB-C laptop" }, os: null, callApp: null,
  budgetCents: { value: 45000, span: "$450", allIn: true }, recordingDate: null, recordingTime: null,
  owned: { headphones: 0, micCables: 0, stands: 0 }, negations: [], unknowns: ["os", "callApp"], conflicts: [],
  questions: ["Which app will the remote guest join through?"], ...over,
});

describe("a drafted value needs a quote that supports it", () => {
  it("drops an operating system read from a quote about the port, and asks for it first (live run, 23 Oct 2026)", () => {
    const out = dropUnsupportedSpans(draft({ os: { value: "macos", span: "USB-C laptop" }, unknowns: ["callApp"] }), TEXT);
    expect(out.os).toBeNull();
    expect(out.unknowns).toContain("os");
    expect(out.questions).toEqual(["Which operating system does the laptop run?", "Which app will the remote guest join through?"]);
    expect(out.hostPort).toEqual({ value: "usb-c", span: "USB-C laptop" });
  });

  it("keeps values whose quote names them", () => {
    const text = "Two of us on a MacBook Pro with Thunderbolt ports, guest joins on Google Meet, budget 450 dollars.";
    const out = dropUnsupportedSpans(draft({
      localPeople: { value: 2, span: "Two of us" }, remoteGuests: { value: 1, span: "guest joins" },
      hostPort: { value: "usb-c", span: "Thunderbolt ports" }, os: { value: "macos", span: "MacBook Pro" },
      callApp: { value: "google-meet", span: "Google Meet" }, budgetCents: { value: 45000, span: "450 dollars", allIn: true }, unknowns: [], questions: [],
    }), text);
    expect(out).toMatchObject({ hostPort: { value: "usb-c" }, os: { value: "macos" }, callApp: { value: "google-meet" }, budgetCents: { value: 45000 } });
    expect(out.unknowns).toEqual([]);
    expect(out.questions).toEqual([]);
  });

  it("checks each categorical field against its own names", () => {
    expect(quoteNamesValue("hostPort", "usb-a", "USB-C laptop")).toBe(false);
    expect(quoteNamesValue("hostPort", "usb-c", "a type-c port")).toBe(true);
    expect(quoteNamesValue("os", "windows", "my PC")).toBe(false);
    expect(quoteNamesValue("os", "windows", "Windows 11 laptop")).toBe(true);
    expect(quoteNamesValue("os", "linux", "Ubuntu")).toBe(true);
    expect(quoteNamesValue("os", "macos", "my Mac")).toBe(true);
    expect(quoteNamesValue("callApp", "zoom", "a video call")).toBe(false);
    expect(quoteNamesValue("callApp", "riverside", "Riverside.fm")).toBe(true);
    // "other" covers apps the store does not list; numbers keep the presence check.
    expect(quoteNamesValue("callApp", "other", "on Discord")).toBe(true);
    expect(quoteNamesValue("localPeople", 2, "me and my co-host")).toBe(true);
  });

  it("asks for a dropped call app only when someone joins remotely", () => {
    const text = "Just me, solo, on Zoom sometimes. USB-C laptop.";
    const solo = dropUnsupportedSpans(draft({ localPeople: { value: 1, span: "Just me" }, remoteGuests: { value: 0, span: "solo" }, callApp: { value: "zoom", span: "solo" }, budgetCents: null, questions: [] }), text);
    expect(solo.callApp).toBeNull();
    expect(solo.questions).toEqual([]);
    const guest = dropUnsupportedSpans(draft({ callApp: { value: "zoom", span: "one remote guest" }, questions: [] }), TEXT);
    expect(guest.callApp).toBeNull();
    expect(guest.questions).toEqual(["Which call app will the remote guest use?"]);
  });

  it("drops a budget whose quote states a different amount, and keeps one written in words", () => {
    const wrong = dropUnsupportedSpans(draft({ budgetCents: { value: 50000, span: "$450", allIn: true } }), TEXT);
    expect(wrong.budgetCents).toBeNull();
    expect(wrong.unknowns).toContain("budgetCents");
    expect(wrong.questions[0]).toBe("What is your all-in budget?");
    const words = "Two of us, one remote guest, budget is four hundred fifty all in.";
    expect(dropUnsupportedSpans(draft({ budgetCents: { value: 45000, span: "four hundred fifty", allIn: true }, questions: [] }), words).budgetCents).toEqual({ value: 45000, span: "four hundred fifty", allIn: true });
    expect(dropUnsupportedSpans(draft({ budgetCents: { value: 120000, span: "$1,200", allIn: true } }), "Up to $1,200.").budgetCents?.value).toBe(120000);
  });

  it("still drops a quote that is not in the text, keeps questions to three, and leaves the input untouched", () => {
    const input = draft({ os: { value: "macos", span: "Mac Studio" }, callApp: { value: "zoom", span: "Zoom" }, questions: ["What day?", "Which time?", "Which mic?"] });
    const before = JSON.stringify(input);
    const out = dropUnsupportedSpans(input, TEXT);
    expect(out.os).toBeNull();
    expect(out.callApp).toBeNull();
    expect(out.questions).toEqual(["Which operating system does the laptop run?", "Which call app will the remote guest use?", "What day?"]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("does not repeat a question the draft already asks", () => {
    const out = dropUnsupportedSpans(draft({ os: { value: "macos", span: "USB-C laptop" }, questions: ["What OS is the laptop on?"] }), TEXT);
    expect(out.questions).toEqual(["What OS is the laptop on?"]);
  });
});
