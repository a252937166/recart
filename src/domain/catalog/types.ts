/** Evidence modes from the ReCart v1.2.1 specification, section 6. */
export type EvidenceMode = "FIXTURE" | "DOCUMENTED" | "MERCHANT_TESTED" | "UNKNOWN" | "CONTRADICTED";

export type Role = "mic" | "interface" | "headphones" | "micCable" | "hostCable" | "adapter" | "stand" | "splitter";
export type Port = "usb-c" | "usb-a" | "usb-b";
export type OS = "macos" | "windows" | "linux";
export type CallApp = "zoom" | "google-meet" | "riverside" | "other";

export type FactValue = boolean | number | string | string[] | null;

export interface Fact {
  value: FactValue;
  evidence: EvidenceMode;
  /** Locator inside the versioned fixture specification sheet (or a manufacturer source in a real pilot). */
  source: string;
}

export interface Variant {
  /** Stable product identity inside one catalog: the fixture SKU, or a merchant's own product ID. */
  sku: string;
  /** Merchant-facing SKU when it differs from the identity (merchant catalogs). Display and mapping only. */
  displaySku?: string;
  name: string;
  role: Role;
  priceCents: number;
  /** One-line description shown to buyers. */
  blurb: string;
  facts: Record<string, Fact>;
}

export interface Catalog {
  version: string;
  merchantId: string;
  merchantName: string;
  evidenceMode: EvidenceMode;
  variants: Variant[];
}

/** A role slot in a recipe. Quantity is computed from the confirmed goal. */
export interface RoleSpec {
  role: Role;
  label: string;
  /** Which catalog products may fill this slot, decided from declared role and attributes, never from names. */
  select: (v: Variant) => boolean;
  /** The fixture catalog's products for this slot (derived from `select`), kept for fixture tooling. */
  allowed: string[];
  /** "exact": quantity(goal) units of a single SKU; "optional": 0 or 1 unit, kept only when a check needs it. */
  kind: "exact" | "optional";
  quantity: (goal: ConfirmedGoal) => number;
}

export type CheckId =
  | "TASK_COVERAGE"
  | "MIC_INPUTS"
  | "PHANTOM_POWER"
  | "HEADPHONE_OUTPUTS"
  | "REMOTE_ROUTING"
  | "HOST_CONNECTION"
  | "OS_SUPPORT"
  | "NO_SUPERFLUOUS_ACCESSORY"
  | "AVAILABILITY"
  | "PICKUP_DEADLINE"
  | "BUDGET";

export interface Recipe {
  id: string;
  version: string;
  title: string;
  summary: string;
  /** Task coverage: which confirmed goals this recipe supports. */
  covers: (goal: ConfirmedGoal) => boolean;
  supportedOS: OS[];
  /** Remote-guest routing method and the call apps it was declared for (team-defined fixture facts). */
  remoteRouting: null | { method: string; callApps: CallApp[] };
  roles: RoleSpec[];
  setupSteps: string[];
  exclusions: string[];
}

/** The buyer-confirmed goal. Hard requirements must be present before solving. */
export interface ConfirmedGoal {
  task: "podcast";
  localPeople: number | null;
  remoteGuests: number | null;
  hostPort: Port | null;
  os: OS | null;
  callApp: CallApp | null;
  owned: { headphones: number; micCables: number; stands: number };
  budgetCents: number | null;
  /** Absolute instant (ISO 8601 with offset) by which pickup must be complete. */
  pickupBy: string | null;
  timezone: string;
  preferences: { headphoneType?: "closed" | "open" | undefined; stand?: "desk" | "boom" | undefined };
}

export const HARD_FIELDS = ["localPeople", "remoteGuests", "hostPort", "os", "budgetCents", "pickupBy"] as const;

/**
 * Everything the solver needs to know about one catalog: products with declared facts, the currency every price uses,
 * and the tax rule applied to proposal totals. Fixture and merchant catalogs both arrive in this shape.
 */
export interface CatalogSnapshot {
  version: string;
  currency: string;
  /** Tax applied to the subtotal, in basis points, rounded half up to the cent (800 = 8%). */
  taxRateBps: number;
  variants: Variant[];
}
