import { describe, expect, it } from "vitest";
import { solve, revalidateLines, evaluateCombination } from "../../src/domain/solver/solver.js";
import { referenceGoal, SCENARIOS, RECIPES, variantBySku } from "../../src/domain/catalog/fixtures.js";
import { taxCents, toPayPalValue, fromPayPalValue } from "../../src/domain/money.js";
import { firstPickupWindow } from "../../src/domain/time.js";
import type { ConfirmedGoal } from "../../src/domain/catalog/types.js";

// Expected values below are authored by hand from the fixture specification; none are produced by the solver.
const NOW = new Date("2026-10-12T17:00:00Z"); // Monday 10:00 PDT
const FRIDAY_10AM_PT = "2026-10-16T17:00:00Z"; // Friday Oct 16, 10:00 PDT
const goalA = (): ConfirmedGoal => referenceGoal(FRIDAY_10AM_PT);
const stock = (overrides: Record<string, number> = {}) => ({ ...SCENARIOS.A.inventory, ...overrides });
const lineSet = (lines: { sku: string; qty: number }[]) => lines.map((l) => `${l.sku}x${l.qty}`).sort();

const ORIGINAL = [
  { sku: "MIC-DX-A", qty: 2 }, { sku: "IF-2C-LB", qty: 1 }, { sku: "HP-CB-A", qty: 2 },
  { sku: "CBL-XLR-3", qty: 2 }, { sku: "CBL-CC-1", qty: 1 }, { sku: "STD-DK-A", qty: 2 },
];
const REVISED = [
  { sku: "MIC-DX-A", qty: 2 }, { sku: "IF-2B-LB", qty: 1 }, { sku: "HP-CB-A", qty: 2 }, { sku: "CBL-XLR-3", qty: 2 },
  { sku: "CBL-BA-1", qty: 1 }, { sku: "ADP-AC", qty: 1 }, { sku: "STD-DK-A", qty: 2 },
];

describe("money", () => {
  it("applies the fixture 8% tax with half-up rounding in integer cents", () => {
    expect(taxCents(34900)).toBe(2792);
    expect(taxCents(39100)).toBe(3128);
    expect(taxCents(1)).toBe(0); // 0.08 cents rounds down
    expect(taxCents(7)).toBe(1); // 0.56 cents rounds up
  });
  it("formats and parses PayPal amount strings", () => {
    expect(toPayPalValue(37692)).toBe("376.92");
    expect(toPayPalValue(5)).toBe("0.05");
    expect(fromPayPalValue("422.28")).toBe(42228);
    expect(fromPayPalValue("10")).toBe(1000);
  });
});

describe("pickup policy", () => {
  it("chooses the first 2-hour slot starting at least two hours ahead", () => {
    const w = firstPickupWindow(NOW); // Monday 10:00 PDT -> 12:00–14:00 PDT slot
    expect(w.start).toBe("2026-10-12T19:00:00.000Z");
    expect(w.end).toBe("2026-10-12T21:00:00.000Z");
  });
  it("rolls to the next morning after store hours", () => {
    const w = firstPickupWindow(new Date("2026-10-13T03:30:00Z")); // Monday 20:30 PDT
    expect(w.start).toBe("2026-10-13T17:00:00.000Z"); // Tuesday 10:00 PDT
  });
});

describe("solver — scenario A (recovered ending)", () => {
  it("returns the reference $376.92 bundle first", () => {
    const r = solve({ goal: goalA(), availability: stock(), now: NOW });
    expect(r.status).toBe("FEASIBLE");
    expect(r.searchComplete).toBe(true);
    const top = r.candidates[0]!;
    expect(lineSet(top.lines)).toEqual(lineSet(ORIGINAL));
    expect(top.subtotalCents).toBe(34900);
    expect(top.taxCents).toBe(2792);
    expect(top.totalCents).toBe(37692);
  });
  it("breaks the $369 subtotal tie by stable SKU order (condenser mics before the boom-arm variant)", () => {
    const r = solve({ goal: goalA(), availability: stock(), now: NOW });
    const second = r.candidates[1]!;
    expect(second.subtotalCents).toBe(36900);
    expect(lineSet(second.lines)).toEqual(lineSet([
      { sku: "MIC-CX-C", qty: 2 }, { sku: "IF-2C-LB", qty: 1 }, { sku: "HP-CB-A", qty: 2 }, { sku: "CBL-XLR-3", qty: 2 }, { sku: "CBL-CC-1", qty: 1 }, { sku: "STD-DK-A", qty: 2 },
    ]));
  });
  it("rebuilds the whole bundle when the interface goes missing: USB-B loopback interface, USB-B cable and adapter", () => {
    const r = solve({ goal: goalA(), availability: stock({ "IF-2C-LB": 0 }), now: NOW, original: ORIGINAL });
    expect(r.status).toBe("FEASIBLE");
    const top = r.candidates[0]!;
    expect(lineSet(top.lines)).toEqual(lineSet(REVISED));
    expect(top.subtotalCents).toBe(39100);
    expect(top.taxCents).toBe(3128);
    expect(top.totalCents).toBe(42228);
    expect(top.totalCents - 37692).toBe(4536);
    // The cheaper no-loopback interface is excluded by remote routing, not by price.
    expect(r.exclusionCounts.REMOTE_ROUTING).toBeGreaterThan(0);
  });
  it("rejects the cheap candidate with an explicit routing failure", () => {
    const recipe = RECIPES.find((x) => x.id === "R-LOCAL2-REMOTE1")!;
    const picked = recipe.roles.map((spec) => {
      const pick: Record<string, string | null> = { mic: "MIC-DX-A", interface: "IF-2C-NL", headphones: "HP-CB-A", micCable: "CBL-XLR-3", hostCable: "CBL-CC-1", adapter: null, stand: "STD-DK-A", splitter: null };
      const sku = pick[spec.role] ?? null;
      return { spec, variant: sku ? variantBySku(sku) : null, qty: sku ? spec.quantity(goalA()) : 0 };
    });
    const ev = evaluateCombination(goalA(), recipe, picked, stock({ "IF-2C-LB": 0 }), firstPickupWindow(NOW));
    expect(ev.checks.find((c) => c.id === "REMOTE_ROUTING")!.outcome).toBe("fail");
    expect(ev.total).toBe(34452); // 31900 + 2552 tax: cheaper, yet invalid
  });
});

describe("solver — scenario B (decision needed)", () => {
  it("stops with a near miss that requires raising the budget to $422.28", () => {
    const goal = { ...goalA(), budgetCents: 40000 };
    const r = solve({ goal, availability: stock({ "IF-2C-LB": 0 }), now: NOW, original: ORIGINAL });
    expect(r.status).toBe("NO_FEASIBLE_SUPPORTED_BUNDLE");
    expect(r.candidates).toHaveLength(0);
    expect(r.nearMisses[0]!.requires.budgetCents).toBe(42228);
    expect(lineSet(r.nearMisses[0]!.bundle.lines)).toEqual(lineSet(REVISED));
  });
});

describe("solver — scenario C (unable to fulfill)", () => {
  it("completes the finite search and finds no supported bundle", () => {
    // Exclusion argument: the interface role allows IF-2B-LB, IF-2C-LB, IF-2C-NL, IF-2C-UK, IF-4C-LB.
    // In this inventory IF-2B-LB, IF-2C-LB, IF-2C-UK and IF-4C-LB have 0 units, and IF-2C-NL has no loopback,
    // so every combination fails AVAILABILITY or REMOTE_ROUTING.
    const r = solve({ goal: goalA(), availability: { ...SCENARIOS.C.inventory, "IF-2C-LB": 0 }, now: NOW, original: ORIGINAL });
    expect(r.status).toBe("NO_FEASIBLE_SUPPORTED_BUNDLE");
    expect(r.searchComplete).toBe(true);
    expect(r.nearMisses).toHaveLength(0);
    expect(Object.keys(r.uniqueBlockers).sort()).toEqual(["AVAILABILITY", "REMOTE_ROUTING"]);
  });
});

describe("solver — other outcomes", () => {
  it("asks for clarification instead of guessing a missing OS", () => {
    const r = solve({ goal: { ...goalA(), os: null }, availability: stock(), now: NOW });
    expect(r.status).toBe("NEEDS_CLARIFICATION");
    expect(r.missingFields).toEqual(["os"]);
  });
  it("requires the call app when there is a remote guest", () => {
    const r = solve({ goal: { ...goalA(), callApp: null }, availability: stock(), now: NOW });
    expect(r.missingFields).toEqual(["callApp"]);
  });
  it("marks three people in the room as unsupported", () => {
    expect(solve({ goal: { ...goalA(), localPeople: 3 }, availability: stock(), now: NOW }).status).toBe("UNSUPPORTED_GOAL");
  });
  it("reports evidence-incomplete when only an undocumented-loopback interface could work", () => {
    const r = solve({ goal: goalA(), availability: stock({ "IF-2C-LB": 0, "IF-2B-LB": 0, "IF-4C-LB": 0, "IF-2C-UK": 1 }), now: NOW });
    expect(r.status).toBe("EVIDENCE_INCOMPLETE");
    expect(r.unknownFacts).toEqual([{ sku: "IF-2C-UK", fact: "loopback", check: "REMOTE_ROUTING" }]);
  });
  it("turns an impossible pickup deadline into a near miss, never a payable bundle", () => {
    const r = solve({ goal: { ...goalA(), pickupBy: "2026-10-12T18:00:00Z" }, availability: stock(), now: NOW });
    expect(r.status).toBe("NO_FEASIBLE_SUPPORTED_BUNDLE");
    expect(r.nearMisses[0]!.requires.pickupBy).toBe("2026-10-12T21:00:00.000Z");
  });
  it("drops owned headphones from the purchase (subtotal $291)", () => {
    const r = solve({ goal: { ...goalA(), owned: { headphones: 2, micCables: 0, stands: 0 } }, availability: stock(), now: NOW });
    expect(r.candidates[0]!.subtotalCents).toBe(29100);
    expect(r.candidates[0]!.lines.some((l) => l.role === "headphones")).toBe(false);
  });
  it("honours a stated open-back preference before price", () => {
    const r = solve({ goal: { ...goalA(), preferences: { headphoneType: "open" } }, availability: stock(), now: NOW });
    expect(r.candidates[0]!.lines.find((l) => l.role === "headphones")!.sku).toBe("HP-OB-B");
    expect(r.candidates[0]!.subtotalCents).toBe(38100);
  });
  it("refuses a superfluous adapter", () => {
    const res = revalidateLines(goalA(), "R-LOCAL2-REMOTE1", [...ORIGINAL, { sku: "ADP-AC", qty: 1 }], stock(), firstPickupWindow(NOW));
    expect(res.ok).toBe(false);
    expect(res.checks.find((c) => c.id === "NO_SUPERFLUOUS_ACCESSORY")!.outcome).toBe("fail");
  });
  it("revalidates the original accepted bundle and detects a stock change", () => {
    const w = firstPickupWindow(NOW);
    expect(revalidateLines(goalA(), "R-LOCAL2-REMOTE1", ORIGINAL, stock(), w).ok).toBe(true);
    expect(revalidateLines(goalA(), "R-LOCAL2-REMOTE1", ORIGINAL, stock({ "IF-2C-LB": 0 }), w).ok).toBe(false);
  });
  it("reports SEARCH_INCOMPLETE rather than a no-solution claim when the work cap is hit", () => {
    const r = solve({ goal: goalA(), availability: stock({ "IF-2C-LB": 0, "IF-2B-LB": 0, "IF-4C-LB": 0 }), now: NOW, workCap: 10 });
    expect(r.status).toBe("SEARCH_INCOMPLETE");
    expect(r.searchComplete).toBe(false);
  });
  it("is deterministic across runs", () => {
    const a = solve({ goal: goalA(), availability: stock(), now: NOW });
    const b = solve({ goal: goalA(), availability: stock(), now: NOW });
    expect(a.candidates.map((c) => c.rankKey)).toEqual(b.candidates.map((c) => c.rankKey));
  });
});
