import { describe, expect, it } from "vitest";
import { groundingProblem, type ExplainFacts } from "../../src/server/language/adapter.js";
import { explainChangeMessages } from "../../src/server/language/prompts.js";
import { OPTION_LABEL } from "../../src/server/services/explain.js";

const facts: ExplainFacts = {
  allowedMoney: ["$376.92", "$422.28", "$45.36", "$450.00"],
  allowedNames: ["2-in USB-B Interface with Loopback", "USB-B to USB-A Cable 1 m", "USB-A to USB-C Host Adapter", "Dynamic XLR Mic A"],
};

describe("explanations name setups the way the buyer sees them", () => {
  it("rejects text that refers to a setup by its position (live explanation, 23 Oct 2026)", () => {
    const live = "The recomputed bundles replace the USB-C interface and cable with the USB-B interface, cable, and host adapter. Both totals fit the $450.00 budget. Option 1 also changes the microphones; option 0 keeps them.";
    expect(groundingProblem(live, facts)).toMatch(/refers to a setup by its position \("Option 1"\)/);
    expect(groundingProblem("Setup #2 costs more.", facts)).toMatch(/position/);
    expect(groundingProblem("Choose between options 0 and 1.", facts)).toMatch(/position/);
  });

  it("accepts the buyer's labels, product names with numbers, and counts", () => {
    expect(groundingProblem("Fewest changes keeps your microphones; the Alternative also replaces them. Both fit the $450.00 budget.", facts)).toBeNull();
    expect(groundingProblem("The 2-in USB-B Interface with Loopback has 2 inputs and needs the USB-B to USB-A Cable 1 m.", facts)).toBeNull();
    expect(groundingProblem("Both setups fit; 2 setups were complete.", facts)).toBeNull();
  });

  it("labels the options in the facts and tells the model to use those labels", () => {
    expect([OPTION_LABEL(0), OPTION_LABEL(1)]).toEqual(["Fewest changes", "Alternative"]);
    const system = explainChangeMessages(facts)[0]!.content;
    expect(system).toContain('"Fewest changes"');
    expect(system).toMatch(/never by index or number/);
  });
});
