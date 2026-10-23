import type { Catalog, CatalogSnapshot, ConfirmedGoal, Fact, FactValue, Recipe, RoleSpec, Variant } from "./types.js";

/**
 * Versioned fixture catalog for the competition demo.
 * Every product is a team-authored, brand-free simulation. Facts carry evidence mode FIXTURE and point
 * at the fixture specification sheet (docs/fixtures/spec-sheet-v1.md). They are not claims about
 * physical products.
 */
export const CATALOG_VERSION = "fixture-catalog-v1";
export const RECIPES_VERSION = "fixture-recipes-v1";

const F = (value: FactValue, source: string): Fact => ({ value, evidence: "FIXTURE", source });
const U = (source: string): Fact => ({ value: null, evidence: "UNKNOWN", source });

function v(sku: string, name: string, role: Variant["role"], priceCents: number, blurb: string, facts: Record<string, Fact>): Variant {
  return { sku, name, role, priceCents, blurb, facts };
}

export const CATALOG: Catalog = {
  version: CATALOG_VERSION,
  merchantId: "fixture-merchant-recart-audio",
  merchantName: "ReCart Demo Audio (simulated store)",
  evidenceMode: "FIXTURE",
  variants: [
    // Microphones
    v("MIC-DX-A", "Dynamic XLR Mic A", "mic", 4900, "Dynamic cardioid mic, XLR output, no phantom power needed.", {
      output: F("xlr", "spec-sheet-v1#MIC-DX-A"), needsPhantom: F(false, "spec-sheet-v1#MIC-DX-A"),
    }),
    v("MIC-DX-B", "Dynamic XLR Mic B", "mic", 6900, "Broadcast-style dynamic mic, XLR output.", {
      output: F("xlr", "spec-sheet-v1#MIC-DX-B"), needsPhantom: F(false, "spec-sheet-v1#MIC-DX-B"),
    }),
    v("MIC-CX-C", "Condenser XLR Mic C", "mic", 5900, "Condenser mic, XLR output, requires 48 V phantom power.", {
      output: F("xlr", "spec-sheet-v1#MIC-CX-C"), needsPhantom: F(true, "spec-sheet-v1#MIC-CX-C"),
    }),
    v("MIC-USB-D", "USB-C Mic D", "mic", 7900, "USB-C mic with a built-in monitor jack; for one-person setups.", {
      output: F("usb-c", "spec-sheet-v1#MIC-USB-D"), needsPhantom: F(false, "spec-sheet-v1#MIC-USB-D"), monitorJack: F(true, "spec-sheet-v1#MIC-USB-D"),
    }),
    // Audio interfaces
    v("IF-2C-LB", "2-in USB-C Interface with Loopback", "interface", 12900, "Two mic preamps, phantom power, two headphone outputs, USB-C, loopback routing.", {
      preamps: F(2, "spec-sheet-v1#IF-2C-LB"), phantom: F(true, "spec-sheet-v1#IF-2C-LB"), headphoneOuts: F(2, "spec-sheet-v1#IF-2C-LB"),
      hostPort: F("usb-c", "spec-sheet-v1#IF-2C-LB"), loopback: F(true, "spec-sheet-v1#IF-2C-LB"), os: F(["macos", "windows"], "spec-sheet-v1#IF-2C-LB"),
    }),
    v("IF-2C-NL", "2-in USB-C Interface (no loopback)", "interface", 9900, "Two mic preamps and two headphone outputs, but no loopback routing.", {
      preamps: F(2, "spec-sheet-v1#IF-2C-NL"), phantom: F(true, "spec-sheet-v1#IF-2C-NL"), headphoneOuts: F(2, "spec-sheet-v1#IF-2C-NL"),
      hostPort: F("usb-c", "spec-sheet-v1#IF-2C-NL"), loopback: F(false, "spec-sheet-v1#IF-2C-NL"), os: F(["macos", "windows"], "spec-sheet-v1#IF-2C-NL"),
    }),
    v("IF-2B-LB", "2-in USB-B Interface with Loopback", "interface", 15900, "Two mic preamps, phantom power, two headphone outputs, USB-B port, loopback routing.", {
      preamps: F(2, "spec-sheet-v1#IF-2B-LB"), phantom: F(true, "spec-sheet-v1#IF-2B-LB"), headphoneOuts: F(2, "spec-sheet-v1#IF-2B-LB"),
      hostPort: F("usb-b", "spec-sheet-v1#IF-2B-LB"), loopback: F(true, "spec-sheet-v1#IF-2B-LB"), os: F(["macos", "windows"], "spec-sheet-v1#IF-2B-LB"),
    }),
    v("IF-4C-LB", "4-in USB-C Interface with Loopback", "interface", 24900, "Four mic preamps, phantom power, two headphone outputs, USB-C, loopback routing.", {
      preamps: F(4, "spec-sheet-v1#IF-4C-LB"), phantom: F(true, "spec-sheet-v1#IF-4C-LB"), headphoneOuts: F(2, "spec-sheet-v1#IF-4C-LB"),
      hostPort: F("usb-c", "spec-sheet-v1#IF-4C-LB"), loopback: F(true, "spec-sheet-v1#IF-4C-LB"), os: F(["macos", "windows"], "spec-sheet-v1#IF-4C-LB"),
    }),
    v("IF-2C-UK", "2-in USB-C Interface (routing unverified)", "interface", 11900, "Two preamps and two headphone outputs; loopback support not yet documented.", {
      preamps: F(2, "spec-sheet-v1#IF-2C-UK"), phantom: F(true, "spec-sheet-v1#IF-2C-UK"), headphoneOuts: F(2, "spec-sheet-v1#IF-2C-UK"),
      hostPort: F("usb-c", "spec-sheet-v1#IF-2C-UK"), loopback: U("spec-sheet-v1#IF-2C-UK (loopback not documented)"), os: F(["macos", "windows"], "spec-sheet-v1#IF-2C-UK"),
    }),
    // Headphones
    v("HP-CB-A", "Closed-back Headphones A", "headphones", 2900, "Closed-back monitoring headphones; isolate well for shared rooms.", {
      type: F("closed", "spec-sheet-v1#HP-CB-A"),
    }),
    v("HP-OB-B", "Open-back Headphones B", "headphones", 4500, "Open-back headphones; comfortable, but leak more sound.", {
      type: F("open", "spec-sheet-v1#HP-OB-B"),
    }),
    // Cables, adapter, stands, splitter
    v("CBL-XLR-3", "XLR Cable 3 m", "micCable", 1200, "Balanced XLR microphone cable.", { ends: F(["xlr", "xlr"], "spec-sheet-v1#CBL-XLR-3") }),
    v("CBL-CC-1", "USB-C to USB-C Cable 1 m", "hostCable", 1000, "Connects a USB-C device to a USB-C computer.", {
      deviceEnd: F("usb-c", "spec-sheet-v1#CBL-CC-1"), hostEnd: F("usb-c", "spec-sheet-v1#CBL-CC-1"),
    }),
    v("CBL-BA-1", "USB-B to USB-A Cable 1 m", "hostCable", 1000, "Connects a USB-B device to a USB-A port.", {
      deviceEnd: F("usb-b", "spec-sheet-v1#CBL-BA-1"), hostEnd: F("usb-a", "spec-sheet-v1#CBL-BA-1"),
    }),
    v("ADP-AC", "USB-A to USB-C Host Adapter", "adapter", 1200, "Lets a USB-A cable plug into a USB-C computer port.", {
      from: F("usb-a", "spec-sheet-v1#ADP-AC"), to: F("usb-c", "spec-sheet-v1#ADP-AC"),
    }),
    v("STD-DK-A", "Desk Mic Stand", "stand", 1500, "Weighted desk stand.", { type: F("desk", "spec-sheet-v1#STD-DK-A") }),
    v("STD-BM-B", "Desk Boom Arm", "stand", 2500, "Clamp-on boom arm.", { type: F("boom", "spec-sheet-v1#STD-BM-B") }),
    v("SPL-HP-2", "Headphone Splitter (2-way)", "splitter", 900, "Feeds two headphones from one headphone output.", { outputs: F(2, "spec-sheet-v1#SPL-HP-2") }),
  ],
};

const need = (n: number | null, owned: number) => Math.max(0, (n ?? 0) - owned);
const fact = (v: Variant, key: string) => v.facts[key]?.value;

/**
 * Slot selectors use only declared roles and attributes, so the same recipes work for any catalog in the
 * audio-recording domain. `allowed` lists the fixture products each selector admits (fixture tooling and docs).
 */
export const SELECTORS = {
  xlrMic: (v: Variant) => v.role === "mic" && fact(v, "output") === "xlr",
  usbMonitorMic: (v: Variant) => v.role === "mic" && fact(v, "output") === "usb-c" && fact(v, "monitorJack") === true,
  interface: (v: Variant) => v.role === "interface",
  headphones: (v: Variant) => v.role === "headphones",
  xlrCable: (v: Variant) => v.role === "micCable" && Array.isArray(fact(v, "ends")) && (fact(v, "ends") as string[]).every((e) => e === "xlr"),
  hostCable: (v: Variant) => v.role === "hostCable",
  adapter: (v: Variant) => v.role === "adapter",
  stand: (v: Variant) => v.role === "stand",
  splitter: (v: Variant) => v.role === "splitter",
};
const fixtureIds = (select: (v: Variant) => boolean) => CATALOG.variants.filter(select).map((v) => v.sku).sort();
const slot = (role: RoleSpec["role"], label: string, select: (v: Variant) => boolean, kind: RoleSpec["kind"], quantity: RoleSpec["quantity"]): RoleSpec =>
  ({ role, label, select, allowed: fixtureIds(select), kind, quantity });

function xlrRecipeRoles(): Recipe["roles"] {
  return [
    slot("mic", "Microphones", SELECTORS.xlrMic, "exact", (g) => g.localPeople ?? 0),
    slot("interface", "Audio interface", SELECTORS.interface, "exact", () => 1),
    slot("headphones", "Headphones", SELECTORS.headphones, "exact", (g) => need(g.localPeople, g.owned.headphones)),
    slot("micCable", "Microphone cables", SELECTORS.xlrCable, "exact", (g) => need(g.localPeople, g.owned.micCables)),
    slot("hostCable", "Computer cable", SELECTORS.hostCable, "exact", () => 1),
    slot("adapter", "Host adapter", SELECTORS.adapter, "optional", () => 1),
    slot("stand", "Stands", SELECTORS.stand, "exact", (g) => need(g.localPeople, g.owned.stands)),
    slot("splitter", "Headphone splitter", SELECTORS.splitter, "optional", () => 1),
  ];
}

export const RECIPES: Recipe[] = [
  {
    id: "R-LOCAL2-REMOTE1",
    version: "v1",
    title: "In-room hosts plus one remote guest",
    summary: "Up to two people in the room on XLR mics, plus one remote guest joining through a call app using interface loopback routing.",
    covers: (g) => (g.localPeople ?? 0) >= 1 && (g.localPeople ?? 0) <= 2 && g.remoteGuests === 1,
    supportedOS: ["macos", "windows"],
    remoteRouting: { method: "Interface loopback sends the room mics into the call app; the call audio returns on the interface headphone outputs.", callApps: ["zoom", "google-meet"] },
    roles: xlrRecipeRoles(),
    setupSteps: [
      "Mount each mic on its stand and connect it to an interface input with an XLR cable.",
      "Connect the interface to the computer with the computer cable (and host adapter if listed).",
      "Plug each headphone into its own interface headphone output.",
      "In the call app, choose the interface loopback as the microphone and the interface as the speaker.",
      "Record a 30-second test with the remote guest before the session.",
    ],
    exclusions: ["More than two people in the room", "More than one remote guest", "Linux or call apps outside the declared list"],
  },
  {
    id: "R-LOCAL-2",
    version: "v1",
    title: "In-room recording, no remote guest",
    summary: "One or two people recording in the same room on XLR mics.",
    covers: (g) => (g.localPeople ?? 0) >= 1 && (g.localPeople ?? 0) <= 2 && g.remoteGuests === 0,
    supportedOS: ["macos", "windows"],
    remoteRouting: null,
    roles: xlrRecipeRoles(),
    setupSteps: [
      "Mount each mic on its stand and connect it to an interface input with an XLR cable.",
      "Connect the interface to the computer with the computer cable (and host adapter if listed).",
      "Give each person headphones on an interface headphone output (or the splitter if listed).",
      "Select the interface as the input in the recording app and record a test.",
    ],
    exclusions: ["Remote guests", "More than two people in the room", "Linux"],
  },
  {
    id: "R-SOLO-REMOTE",
    version: "v1",
    title: "One-person remote interview",
    summary: "A single host on a USB-C mic with its monitor jack, interviewing at most one remote guest.",
    covers: (g) => g.localPeople === 1 && (g.remoteGuests ?? 0) <= 1 && g.hostPort === "usb-c",
    supportedOS: ["macos", "windows"],
    remoteRouting: { method: "The USB mic is selected directly as the call app microphone; call audio plays through the mic's monitor jack.", callApps: ["zoom", "google-meet"] },
    roles: [
      slot("mic", "Microphone", SELECTORS.usbMonitorMic, "exact", () => 1),
      slot("headphones", "Headphones", SELECTORS.headphones, "exact", (g) => need(1, g.owned.headphones)),
      slot("stand", "Stand", SELECTORS.stand, "exact", (g) => need(1, g.owned.stands)),
    ],
    setupSteps: [
      "Connect the USB-C mic directly to the computer with its included cable.",
      "Plug the headphones into the mic's monitor jack.",
      "Select the mic as both microphone and speaker in the call app.",
    ],
    exclusions: ["More than one person in the room", "USB-A-only computers"],
  },
];

/** The fixture catalog as a solver snapshot: USD prices and the fixture's 8% tax rule. */
export const FIXTURE_SNAPSHOT: CatalogSnapshot = { version: CATALOG_VERSION, currency: "USD", taxRateBps: 800, variants: CATALOG.variants };

/** The scenario A buyer goal from the specification's reference scenario. */
export function referenceGoal(pickupBy: string, timezone = "America/Los_Angeles"): ConfirmedGoal {
  return {
    task: "podcast", localPeople: 2, remoteGuests: 1, hostPort: "usb-c", os: "macos", callApp: "zoom",
    owned: { headphones: 0, micCables: 0, stands: 0 }, budgetCents: 45000, pickupBy, timezone, preferences: {},
  };
}

export function variantBySku(sku: string): Variant {
  const found = CATALOG.variants.find((x) => x.sku === sku);
  if (!found) throw new Error(`unknown sku ${sku}`);
  return found;
}

export type ScenarioId = "A" | "B" | "C";
export interface Scenario {
  id: ScenarioId;
  title: string;
  ending: "Recovered" | "Decision needed" | "Unable to fulfill";
  description: string;
  budgetCents: number;
  inventory: Record<string, number>;
}

/** Fixture store stock before any order (scenario A and B levels). */
export const BASE_STOCK: Record<string, number> = {
  "MIC-DX-A": 4, "MIC-DX-B": 3, "MIC-CX-C": 3, "MIC-USB-D": 2,
  "IF-2C-LB": 1, "IF-2C-NL": 3, "IF-2B-LB": 2, "IF-4C-LB": 1, "IF-2C-UK": 0,
  "HP-CB-A": 6, "HP-OB-B": 2, "CBL-XLR-3": 10, "CBL-CC-1": 5, "CBL-BA-1": 5, "ADP-AC": 4,
  "STD-DK-A": 6, "STD-BM-B": 2, "SPL-HP-2": 3,
};

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  A: { id: "A", title: "Interface goes missing, store has an alternative", ending: "Recovered", budgetCents: 45000, inventory: { ...BASE_STOCK },
    description: "The $450 setup is authorized, then the packing check finds the only loopback USB-C interface missing. ReCart rebuilds the whole bundle around a USB-B loopback interface plus the adapter it needs." },
  B: { id: "B", title: "Only a pricier fix exists", ending: "Decision needed", budgetCents: 40000, inventory: { ...BASE_STOCK },
    description: "Same goal with a $400 ceiling. The only complete replacement costs $422.28, so ReCart stops and asks the buyer to raise the budget or cancel. It never relaxes the limit itself." },
  C: { id: "C", title: "No supported replacement", ending: "Unable to fulfill", budgetCents: 45000, inventory: { ...BASE_STOCK, "IF-2B-LB": 0, "IF-4C-LB": 0 },
    description: "The missing interface was the last loopback-capable unit in stock. Search completes over the declared catalog, finds no supported bundle, and the authorization is voided." },
};
