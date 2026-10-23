import { z } from "zod";
import { EVENT_TYPES } from "./events.js";
import { API_ROLES, EVIDENCE } from "./pack.js";
import { OUTCOMES, UNAVAILABLE_REASONS } from "./planning.js";
import { Requirements, SCOPES } from "./schemas.js";

/**
 * Response contract. The OpenAPI document publishes these schemas and the contract tests parse real responses with
 * them, so an undocumented or renamed field fails the build instead of surprising an integration.
 */
const id = z.string();
const ts = z.string().describe("ISO 8601 timestamp (UTC).");
const cents = z.number().int().describe("Integer minor units (cents).");
export const RECOVERY_STATUSES = ["awaiting_buyer", "action_required", "no_solution", "no_change_needed", "approved", "executing", "reconciling", "completed", "declined", "cancelled", "expired"] as const;

export const ErrorResponse = z.strictObject({
  error: z.strictObject({
    type: z.enum(["invalid_request", "authentication_required", "permission_denied", "not_found", "conflict", "idempotency_error", "rate_limited", "gone", "dependency_unavailable", "internal_error"]),
    code: z.string().describe("Stable machine-readable code, e.g. proposal_superseded."),
    message: z.string(), request_id: z.string().nullable(), details: z.unknown().nullable(),
  }),
}).describe("Every error uses this shape. Business outcomes such as budget_conflict are successful responses, not errors.");

const Attribute = z.strictObject({ value: z.unknown().optional(), evidence: z.enum(EVIDENCE), source: z.string().optional() });
export const Product = z.strictObject({
  product_id: id, sku: z.string().nullable(), name: z.string(), role: z.enum(API_ROLES), description: z.string().nullable(),
  attributes: z.record(z.string(), Attribute), price_cents: cents, currency: z.string(), status: z.enum(["active", "draft", "archived"]),
  source_updated_at: ts.nullable(), updated_at: ts.nullable(),
});
export const ProductDetail = Product.extend({ inventory: z.array(z.strictObject({ location_id: z.string(), available: z.number().int(), as_of: ts.nullable(), received_at: ts.nullable() })) });
export const ProductList = z.strictObject({ data: z.array(Product), has_more: z.boolean(), next_after: z.string().nullable() });
export const CatalogUpsertResult = z.strictObject({
  catalog_version: z.number().int(), created: z.number().int(), updated: z.number().int(), unchanged: z.number().int(), ignored_older_updates: z.number().int(),
  products: z.array(z.strictObject({ product_id: id, result: z.enum(["created", "updated", "unchanged", "ignored_older_update"]) })),
});
export const InventoryUpsertResult = z.strictObject({
  applied: z.number().int(), changed: z.number().int(),
  refreshed: z.number().int().describe("Counts with an unchanged quantity that were too old to plan with and are now fresh; open recoveries are re-planned."),
  ignored_older_updates: z.number().int(), unknown_product_ids: z.array(z.string()),
});
export const InventoryList = z.strictObject({ data: z.array(z.strictObject({ product_id: id, location_id: z.string(), available: z.number().int(), as_of: ts.nullable(), received_at: ts.nullable(), fresh: z.boolean() })) });

const Item = z.strictObject({ product_id: id, sku: z.string().nullable(), name: z.string(), role: z.enum(API_ROLES).nullable(), quantity: z.number().int(), unit_price_cents: cents, line_total_cents: cents });
const Totals = z.strictObject({ items_cents: cents, shipping_cents: cents, tax_cents: cents, total_cents: cents.describe("Items + shipping + tax: the amount compared with the buyer's limit.") });
const Check = z.strictObject({ check: z.string(), label: z.string(), result: z.enum(["pass", "fail", "unknown"]), detail: z.string(), evidence: z.array(z.enum(EVIDENCE)) });
const Setup = z.strictObject({
  recipe: z.strictObject({ id: z.string(), title: z.string(), version: z.string() }),
  items: z.array(Item.extend({ change: z.enum(["kept", "added", "quantity_changed"]), previous_quantity: z.number().int().optional(), attributes: z.record(z.string(), Attribute) })),
  removed_items: z.array(Item.extend({ reason: z.enum(["unavailable", "replaced"]) })),
  totals: Totals, difference_cents: cents.describe("New total minus the original order's total."),
  budget: z.strictObject({ max_total_cents: cents, remaining_cents: cents }).nullable(), ready_at: ts.nullable(),
  compatibility: z.array(Check).describe("Every hard check the setup passed, with the evidence modes behind it."), setup_steps: z.array(z.string()),
});
const BriefItem = z.strictObject({ product_id: id, name: z.string(), quantity: z.number().int() });
const proposalBody = {
  outcome: z.enum(OUTCOMES), summary: z.string().describe("Plain-language explanation, generated from the structured result."),
  domain: z.string(), currency: z.string(),
  original: z.strictObject({ items: z.array(Item), totals: Totals }),
  unavailable_items: z.array(z.strictObject({ product_id: id, quantity: z.number().int(), reason: z.enum(UNAVAILABLE_REASONS), name: z.string() })),
  replacement: Setup.nullable().describe("The proposed complete setup (outcomes proposal_ready and no_change_needed)."),
  changes: z.array(z.strictObject({ role: z.enum(API_ROLES), before: z.array(BriefItem), after: z.array(BriefItem), reason: z.string() })),
  single_item_swaps: z.array(z.strictObject({ replaces: id, product_id: id, name: z.string(), works: z.boolean(), total_cents: cents.nullable(), reasons: z.array(z.string()) }))
    .describe("Each like-for-like substitute for an unavailable item, checked with everything else unchanged."),
  conflict: z.strictObject({
    type: z.enum(["budget", "deadline", "budget_and_deadline"]), required_max_total_cents: cents.optional(), current_max_total_cents: cents.nullable().optional(),
    earliest_ready_at: ts.optional(), needed_by: ts.nullable().optional(), closest: Setup,
  }).nullable(),
  missing_fields: z.array(z.string()),
  unknown_facts: z.array(z.strictObject({ product_id: id, name: z.string(), attribute: z.string(), check: z.string() })),
  stale_products: z.array(z.strictObject({ product_id: id, name: z.string(), available_if_counted: z.number().int(), as_of: ts.nullable() })),
  search: z.strictObject({ combinations_checked: z.number().int(), feasible_count: z.number().int(), complete: z.boolean(), duration_ms: z.number(), blocking_reasons: z.array(z.string()) }),
  provenance: z.strictObject({ catalog_version: z.number().int(), recipes_version: z.string(), solver_version: z.string(), ranking_version: z.string(), inventory_max_age_seconds: z.number().int(), planned_at: ts }),
};
export const Proposal = z.strictObject({
  id, recovery_id: id, version: z.number().int(), status: z.enum(["active", "superseded", "approved", "declined", "expired"]),
  approvable: z.boolean().describe("True only for an active proposal_ready version. Only the buyer can approve, on the review page."),
  hash: z.string().describe("SHA-256 binding approval and execution to this exact version."),
  created_at: ts, expires_at: ts, decided_at: ts.nullable(), ...proposalBody,
});
export const RecoveryPreviewResult = z.strictObject({ object: z.literal("recovery_preview"), persisted: z.literal(false), approvable: z.literal(false), approvable_after_create: z.boolean(), ...proposalBody });
export const NextAction = z.strictObject({ actor: z.enum(["buyer", "merchant", "none"]), code: z.string(), message: z.string() });
export const Execution = z.strictObject({ id, proposal_id: id, proposal_hash: z.string(), status: z.enum(["pending", "succeeded", "failed", "unknown"]), valid_until: ts, external_reference: z.string().nullable(), message: z.string().nullable(), created_at: ts, acknowledged_at: ts.nullable() });
export const Recovery = z.strictObject({
  id, external_order_id: z.string(), status: z.enum(RECOVERY_STATUSES), next_action: NextAction, currency: z.string(),
  requirements: Requirements,
  original_items: z.array(z.strictObject({ product_id: id, quantity: z.number().int(), unit_price_cents: cents, held_quantity: z.number().int() })),
  shipping_cents: cents,
  unavailable_items: z.array(z.strictObject({ product_id: id, quantity: z.number().int(), reason: z.enum(UNAVAILABLE_REASONS) })),
  fulfillment: z.strictObject({ location_ids: z.array(z.string()).optional(), ready_at: z.string().optional() }).nullable(),
  buyer_reference: z.string().nullable(), metadata: z.record(z.string(), z.string()),
  proposal: Proposal.nullable(), latest_execution: Execution.nullable(), created_at: ts, updated_at: ts,
});
export const RecoveryList = z.strictObject({ data: z.array(Recovery), has_more: z.boolean(), next_before: z.string().nullable() });
export const ProposalList = z.strictObject({ data: z.array(Proposal) });
export const RecomputeResult = z.strictObject({ revised: z.boolean(), recovery: Recovery });
export const ReviewLink = z.strictObject({ id, url: z.string(), token: z.string(), recovery_id: id, expires_at: ts, note: z.string() });
export const ExecutionStarted = z.strictObject({
  execution: Execution,
  apply: z.strictObject({ proposal_id: id, items: Setup.shape.items, removed_items: Setup.shape.removed_items, totals: Totals, difference_cents: cents }).describe("Exactly what to apply in your system."),
  recovery: Recovery,
});
export const RequirementDraft = z.strictObject({
  object: z.literal("requirement_draft"), confirmed: z.literal(false), source: z.enum(["model", "rules"]), model: z.string().nullable(), provider: z.enum(["codex", "hosted"]).nullable().describe("Which language provider answered: the primary Codex gateway or the hosted backup; null when the rules drafted."), fallback_reason: z.string().nullable(),
  requirements: Requirements, quotes: z.record(z.string(), z.strictObject({ quote: z.string() }).nullable()),
  missing_fields: z.array(z.string()), conflicts: z.array(z.strictObject({ field: z.string(), detail: z.string() })), questions: z.array(z.string()), note: z.string(),
});
export const Event = z.strictObject({ id, type: z.enum(EVENT_TYPES), created_at: ts, data: z.record(z.string(), z.unknown()) }).describe("Delivered to your webhook endpoint as the POST body, signed with ReCart-Signature.");
export const EventList = z.strictObject({ data: z.array(Event), has_more: z.boolean(), next_after: z.string().nullable() });
export const WebhookDeliveryList = z.strictObject({ data: z.array(z.strictObject({ id, event_id: id, event_type: z.string(), url: z.string(), status: z.enum(["pending", "delivered", "failed"]), attempts: z.number().int(), last_status_code: z.number().int().nullable(), last_error: z.string().nullable(), created_at: ts, delivered_at: ts.nullable(), next_attempt_at: ts.nullable() })) });
export const ApiKeyCreated = z.strictObject({ id, key: z.string(), prefix: z.string(), scopes: z.array(z.enum(SCOPES)), note: z.string() });
export const Loose = z.record(z.string(), z.unknown());
