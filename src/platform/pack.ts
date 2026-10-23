import { CATALOG, RECIPES, RECIPES_VERSION, SELECTORS as SELECTOR_NAMES } from "../domain/catalog/fixtures.js";
import type { ConfirmedGoal, EvidenceMode, Fact, Role, Variant } from "../domain/catalog/types.js";
import { CHECK_LABELS } from "../domain/solver/solver.js";
import { FAILURE_PHRASE } from "../server/services/explain.js";

/**
 * The audio-recording domain pack: the public, versioned vocabulary merchants use to describe products and
 * buyers' requirements, and its mapping onto the solver's internal facts. Recipes and checks stay in the domain
 * core; this module only translates. New product domains would add another pack, not change the core.
 */
export const PACK_ID = "audio-recording-v1";

export const API_ROLES = ["mic", "interface", "headphones", "mic_cable", "host_cable", "adapter", "stand", "splitter"] as const;
export type ApiRole = (typeof API_ROLES)[number];
const ROLE_TO_INTERNAL: Record<ApiRole, Role> = { mic: "mic", interface: "interface", headphones: "headphones", mic_cable: "micCable", host_cable: "hostCable", adapter: "adapter", stand: "stand", splitter: "splitter" };
const ROLE_TO_API = Object.fromEntries(Object.entries(ROLE_TO_INTERNAL).map(([a, i]) => [i, a])) as Record<Role, ApiRole>;
export const roleToInternal = (r: ApiRole): Role => ROLE_TO_INTERNAL[r];
export const roleToApi = (r: Role): ApiRole => ROLE_TO_API[r];

export const EVIDENCE = ["documented", "merchant_tested", "fixture", "unknown", "contradicted"] as const;
export type ApiEvidence = (typeof EVIDENCE)[number];
const EVIDENCE_TO_INTERNAL: Record<ApiEvidence, EvidenceMode> = { documented: "DOCUMENTED", merchant_tested: "MERCHANT_TESTED", fixture: "FIXTURE", unknown: "UNKNOWN", contradicted: "CONTRADICTED" };
export const evidenceToApi = (e: EvidenceMode): ApiEvidence => (Object.entries(EVIDENCE_TO_INTERNAL).find(([, v]) => v === e)![0] as ApiEvidence);

/** Public attribute name -> internal fact key, per role. */
export const ATTRIBUTE_KEYS: Record<ApiRole, Record<string, string>> = {
  mic: { output: "output", needs_phantom: "needsPhantom", monitor_jack: "monitorJack" },
  interface: { preamps: "preamps", phantom: "phantom", headphone_outputs: "headphoneOuts", host_port: "hostPort", loopback: "loopback", os_support: "os" },
  headphones: { type: "type" },
  mic_cable: { ends: "ends" },
  host_cable: { device_end: "deviceEnd", host_end: "hostEnd" },
  adapter: { from: "from", to: "to" },
  stand: { type: "type" },
  splitter: { outputs: "outputs" },
};

export interface ApiAttribute { value?: unknown; evidence: ApiEvidence; source?: string | undefined }

/** Convert public attributes to solver facts. Missing attributes are simply absent, which the solver treats as UNKNOWN. */
export function attributesToFacts(role: ApiRole, attrs: Record<string, ApiAttribute | undefined>): Record<string, Fact> {
  const facts: Record<string, Fact> = {};
  for (const [apiKey, internal] of Object.entries(ATTRIBUTE_KEYS[role])) {
    const a = attrs[apiKey];
    if (!a) continue;
    const evidence = EVIDENCE_TO_INTERNAL[a.evidence];
    facts[internal] = { value: evidence === "UNKNOWN" ? null : ((a.value ?? null) as Fact["value"]), evidence, source: a.source ?? "" };
  }
  return facts;
}

export function factsToAttributes(role: ApiRole, facts: Record<string, Fact>): Record<string, ApiAttribute> {
  const out: Record<string, ApiAttribute> = {};
  for (const [apiKey, internal] of Object.entries(ATTRIBUTE_KEYS[role])) {
    const f = facts[internal];
    if (!f) continue;
    out[apiKey] = { ...(f.evidence === "UNKNOWN" ? {} : { value: f.value }), evidence: evidenceToApi(f.evidence), ...(f.source ? { source: f.source } : {}) };
  }
  return out;
}

/** Public requirements (buyer constraints) in the standard format. */
export interface ApiRequirements {
  local_people: number | null;
  remote_guests: number | null;
  host_port: "usb-c" | "usb-a" | "usb-b" | null;
  os: "macos" | "windows" | "linux" | null;
  call_app: "zoom" | "google-meet" | "riverside" | "other" | null;
  budget: { max_total_cents: number; currency: string } | null;
  needed_by: string | null;
  timezone: string;
  owned?: { headphones?: number; mic_cables?: number; stands?: number } | undefined;
  preferences?: { headphone_type?: "closed" | "open" | undefined; stand_type?: "desk" | "boom" | undefined } | undefined;
}

export function requirementsToGoal(r: ApiRequirements): ConfirmedGoal {
  return {
    task: "podcast",
    localPeople: r.local_people, remoteGuests: r.remote_guests, hostPort: r.host_port, os: r.os, callApp: r.call_app,
    owned: { headphones: r.owned?.headphones ?? 0, micCables: r.owned?.mic_cables ?? 0, stands: r.owned?.stands ?? 0 },
    budgetCents: r.budget ? r.budget.max_total_cents : null,
    pickupBy: r.needed_by,
    timezone: r.timezone,
    preferences: { headphoneType: r.preferences?.headphone_type, stand: r.preferences?.stand_type },
  };
}

export const REQUIREMENT_FIELDS: Record<string, string> = {
  localPeople: "local_people", remoteGuests: "remote_guests", hostPort: "host_port", os: "os", callApp: "call_app", budgetCents: "budget", pickupBy: "needed_by",
};

/** The fixture products in the public standard format (used to seed sandbox merchants and in documentation). */
export function fixtureProducts(): { product_id: string; sku: string; name: string; role: ApiRole; description: string; price_cents: number; currency: string; status: "active"; attributes: Record<string, ApiAttribute> }[] {
  return CATALOG.variants.map((v) => ({
    product_id: v.sku, sku: v.sku, name: v.name, role: roleToApi(v.role), description: v.blurb, price_cents: v.priceCents, currency: "USD", status: "active" as const,
    attributes: factsToAttributes(roleToApi(v.role), v.facts),
  }));
}

/** A machine-readable description of the pack, served at GET /v1/domains/audio-recording-v1. */
export function describePack() {
  const slotRule: Record<string, string> = {
    xlrMic: "role mic with output xlr", usbMonitorMic: "role mic with output usb-c and monitor_jack true", interface: "role interface", headphones: "role headphones",
    xlrCable: "role mic_cable with both ends xlr", hostCable: "role host_cable", adapter: "role adapter", stand: "role stand", splitter: "role splitter",
  };
  return {
    id: PACK_ID,
    title: "Podcast and interview recording setups",
    recipes_version: RECIPES_VERSION,
    roles: API_ROLES.map((r) => ({ role: r, attributes: Object.keys(ATTRIBUTE_KEYS[r]) })),
    evidence_modes: EVIDENCE.map((e) => ({ mode: e, meaning: ({ documented: "Stated in a manufacturer or merchant specification you can cite", merchant_tested: "Verified by the merchant on real equipment", fixture: "Declared by a test catalog; never a physical claim", unknown: "Not documented; any check that needs it cannot pass", contradicted: "Sources disagree; checks that need it fail" } as const)[e] })),
    recipes: RECIPES.map((r) => ({
      id: r.id, version: r.version, title: r.title, summary: r.summary, supported_os: r.supportedOS,
      remote_routing: r.remoteRouting ? { method: r.remoteRouting.method, call_apps: r.remoteRouting.callApps } : null,
      slots: r.roles.map((s) => {
        const sel = Object.entries(SELECTOR_NAMES).find(([, fn]) => fn === s.select)?.[0];
        return { role: roleToApi(s.role), label: s.label, kind: s.kind, accepts: sel ? slotRule[sel] : `role ${roleToApi(s.role)}` };
      }),
      exclusions: r.exclusions,
    })),
    checks: Object.entries(CHECK_LABELS).map(([id, label]) => ({ id, label, failure: FAILURE_PHRASE[id] ?? null })),
  };
}


/** Rebuild a solver variant from a stored merchant product. */
export function toVariant(p: { product_id: string; sku: string | null; name: string; role: ApiRole; description: string | null; price_cents: number; attributes: Record<string, ApiAttribute> }): Variant {
  return { sku: p.product_id, ...(p.sku ? { displaySku: p.sku } : {}), name: p.name, role: roleToInternal(p.role), priceCents: p.price_cents, blurb: p.description ?? "", facts: attributesToFacts(p.role, p.attributes) };
}
