import { z } from "zod";
import { API_ROLES, EVIDENCE } from "./pack.js";

/**
 * The public contract. These schemas validate REST requests, generate the OpenAPI document and the MCP tool
 * schemas, so all three interfaces accept exactly the same input.
 */

const evidence = z.enum(EVIDENCE).describe("How the value is known. `unknown` makes any check that needs the attribute unconfirmable.");
const source = z.string().max(500).optional().describe("Where the fact comes from: a spec-sheet URL, document reference or test note.");
const attr = <T extends z.ZodType>(value: T, description: string) =>
  z.object({ value: value.nullable().optional(), evidence, source }).strict().describe(description);
const port = z.enum(["usb-c", "usb-a", "usb-b"]);

const attributeSets = {
  mic: z.object({
    output: attr(z.enum(["xlr", "usb-c", "usb-a"]), "Connector the mic outputs on."),
    needs_phantom: attr(z.boolean(), "Whether the mic needs 48 V phantom power."),
    monitor_jack: attr(z.boolean(), "Whether a USB mic has its own headphone jack."),
  }).partial().strict(),
  interface: z.object({
    preamps: attr(z.number().int().min(0).max(64), "Number of mic preamps (inputs)."),
    phantom: attr(z.boolean(), "Whether the interface supplies 48 V phantom power."),
    headphone_outputs: attr(z.number().int().min(0).max(16), "Independent headphone outputs."),
    host_port: attr(port, "The interface's port toward the computer."),
    loopback: attr(z.boolean(), "Whether it can route room mics into a call app (loopback)."),
    os_support: attr(z.array(z.enum(["macos", "windows", "linux"])).max(3), "Operating systems the interface supports."),
  }).partial().strict(),
  headphones: z.object({ type: attr(z.enum(["closed", "open"]), "Closed-back or open-back.") }).partial().strict(),
  mic_cable: z.object({ ends: attr(z.array(z.enum(["xlr", "trs", "usb-c", "usb-a", "usb-b"])).length(2), "Connector at each end.") }).partial().strict(),
  host_cable: z.object({ device_end: attr(port, "End that plugs into the device."), host_end: attr(port, "End that plugs into the computer or an adapter.") }).partial().strict(),
  adapter: z.object({ from: attr(port, "Connector it accepts."), to: attr(port, "Connector it presents to the computer.") }).partial().strict(),
  stand: z.object({ type: attr(z.enum(["desk", "boom", "floor"]), "Stand style.") }).partial().strict(),
  splitter: z.object({ outputs: attr(z.number().int().min(1).max(16), "Headphone feeds it produces from one output.") }).partial().strict(),
} as const;

const productBase = {
  product_id: z.string().min(1).max(200).describe("Your stable identifier for this sellable item (for Shopify, the variant GID). Unique per merchant."),
  sku: z.string().max(100).nullable().optional().describe("Display SKU. Not used as identity."),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  price_cents: z.number().int().min(0).max(100_000_000).describe("Unit price in minor units (cents)."),
  currency: z.string().regex(/^[A-Z]{3}$/).describe("ISO 4217 code. Must equal the merchant currency."),
  status: z.enum(["active", "draft", "archived"]).describe("Only `active` products are used in proposals."),
  source_updated_at: z.string().datetime({ offset: true }).optional().describe("When your system last changed this product."),
};

const productFor = (role: (typeof API_ROLES)[number]) =>
  z.object({ ...productBase, role: z.literal(role), attributes: (attributeSets[role] as unknown as z.ZodObject).default({}) }).strict();
export const ProductInput = z.discriminatedUnion("role", API_ROLES.map(productFor) as unknown as [z.ZodObject, ...z.ZodObject[]])
  .describe("A product in the standard format. Attributes depend on the role.");
/** Parsed product (the discriminated union is validated per role at runtime). */
export interface ProductInput {
  product_id: string; sku?: string | null | undefined; name: string; description?: string | null | undefined;
  price_cents: number; currency: string; status: "active" | "draft" | "archived"; source_updated_at?: string | undefined;
  role: (typeof API_ROLES)[number];
  attributes: Record<string, { value?: unknown; evidence: (typeof EVIDENCE)[number]; source?: string | undefined } | undefined>;
}

export const CatalogUpsert = z.object({ products: z.array(ProductInput).min(1).max(500) }).strict();
export const InventoryLevelInput = z.object({
  product_id: z.string().min(1).max(200),
  location_id: z.string().min(1).max(200).describe("Your location identifier. Planning sums the locations named in a recovery."),
  available: z.number().int().min(0).max(1_000_000).describe("Units free to sell now: exclude units already allocated to open orders."),
  as_of: z.string().datetime({ offset: true }).describe("When this count was true in your system. Older updates than the stored one are ignored."),
}).strict();
export const InventoryUpsert = z.object({ levels: z.array(InventoryLevelInput).min(1).max(1000) }).strict();

export const Requirements = z.object({
  local_people: z.number().int().min(0).max(20).nullable().describe("People recording in the same room."),
  remote_guests: z.number().int().min(0).max(20).nullable().describe("Participants joining through a call app."),
  host_port: z.enum(["usb-c", "usb-a", "usb-b"]).nullable().describe("The buyer's computer port."),
  os: z.enum(["macos", "windows", "linux"]).nullable(),
  call_app: z.enum(["zoom", "google-meet", "riverside", "other"]).nullable().describe("Required when remote_guests > 0."),
  budget: z.object({ max_total_cents: z.number().int().min(0).max(100_000_000), currency: z.string().regex(/^[A-Z]{3}$/) }).strict().nullable()
    .describe("All-in limit including tax. ReCart never raises it; only the buyer can."),
  needed_by: z.string().datetime({ offset: true }).nullable().describe("When the setup must be ready. Requires fulfillment.ready_at."),
  timezone: z.string().min(1).max(64).default("UTC"),
  owned: z.object({ headphones: z.number().int().min(0).max(20).optional(), mic_cables: z.number().int().min(0).max(20).optional(), stands: z.number().int().min(0).max(20).optional() }).strict().optional(),
  preferences: z.object({ headphone_type: z.enum(["closed", "open"]).optional(), stand_type: z.enum(["desk", "boom"]).optional() }).strict().optional()
    .describe("Soft preferences: they order proposals but never make a setup invalid."),
}).strict().describe("Buyer requirements the buyer has confirmed. Hard fields are local_people, remote_guests, host_port, os and budget; call_app is required with remote guests.");
export type Requirements = z.infer<typeof Requirements>;

const OrderItem = z.object({
  product_id: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(1000),
  unit_price_cents: z.number().int().min(0).max(100_000_000).optional().describe("Price the buyer agreed to. Defaults to the current catalog price."),
  held_quantity: z.number().int().min(0).max(1000).optional().describe("Units of this item you still hold for the order. Defaults to quantity minus unavailable units."),
}).strict();
const UnavailableItem = z.object({
  product_id: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(1000),
  reason: z.enum(["missing_at_packing", "damaged", "out_of_stock", "discontinued", "other"]).default("missing_at_packing"),
}).strict();

const recoveryFields = {
  external_order_id: z.string().min(1).max(200).describe("Your order reference. ReCart never creates or changes the order."),
  currency: z.string().regex(/^[A-Z]{3}$/).describe("ISO 4217 code of the order. Must equal the merchant currency."),
  requirements: Requirements,
  original_items: z.array(OrderItem).min(1).max(100).describe("Every item of the original order, including the unavailable one."),
  shipping_cents: z.number().int().min(0).max(100_000_000).default(0).describe("Shipping charged on the order. Carried unchanged into proposals and counted against the budget."),
  unavailable_items: z.array(UnavailableItem).min(1).max(100),
  fulfillment: z.object({
    location_ids: z.array(z.string().min(1).max(200)).max(20).optional().describe("Locations that can fulfil the replacement. Defaults to all."),
    ready_at: z.string().datetime({ offset: true }).optional().describe("When you could hand over or deliver the replacement."),
  }).strict().optional(),
  buyer_reference: z.string().max(200).optional().describe("Opaque reference to the buyer in your system. Do not send personal data."),
  metadata: z.record(z.string().max(40), z.string().max(500)).optional(),
};
export const RecoveryCreate = z.object(recoveryFields).strict();
export type RecoveryCreate = z.infer<typeof RecoveryCreate>;
/** A preview computes the same proposal without storing anything; the order reference is optional. */
export const RecoveryPreview = z.object({ ...recoveryFields, external_order_id: recoveryFields.external_order_id.optional() }).strict();
export type RecoveryPreview = z.infer<typeof RecoveryPreview>;

export const RecoveryUpdate = z.object({
  requirements: Requirements.describe("Requirements the buyer re-confirmed, for example a raised budget."),
}).strict();

export const ExecutionCreate = z.object({
  proposal_id: z.string().min(1).max(64).describe("The approved proposal you are about to apply."),
  proposal_hash: z.string().regex(/^[0-9a-f]{64}$/).describe("Hash of the exact approved version."),
}).strict();
export const ExecutionAcknowledge = z.object({
  outcome: z.enum(["succeeded", "failed", "unknown"]).describe("What happened in your system. Report `unknown` when you cannot tell yet; resolve it before retrying."),
  external_reference: z.string().max(200).optional().describe("Your reference for the applied change, e.g. an order edit or payment ID."),
  message: z.string().max(500).optional(),
}).strict();

export const SCOPES = ["catalog:read", "catalog:write", "recoveries:read", "recoveries:write", "events:read", "settings:write"] as const;
export type Scope = (typeof SCOPES)[number];
export const ApiKeyCreate = z.object({
  label: z.string().min(1).max(80),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length).describe("Grant only what the integration needs, e.g. a catalog sync job needs catalog:write."),
}).strict();

export const IntegrationReport = z.object({
  name: z.string().min(1).max(80).describe("Your integration, e.g. `Shopify reference sync`."),
  platform: z.string().min(1).max(40).describe("Source platform, e.g. `shopify` or `custom`."),
  version: z.string().min(1).max(40),
  source: z.string().max(200).optional().describe("Store or system identifier shown on the status page."),
  capabilities: z.array(z.enum(["catalog_sync", "inventory_sync", "stock_change_watch", "recovery_requests", "buyer_review_links", "webhook_receiver", "execution_acknowledgement"])).max(10),
  not_supported: z.array(z.string().min(1).max(80)).max(10).default([]).describe("Capabilities this integration deliberately does not provide, e.g. `checkout`."),
}).strict();

export const BuyerDecision = z.object({
  proposal_id: z.string().min(1).max(64),
  proposal_hash: z.string().regex(/^[0-9a-f]{64}$/),
  decision: z.enum(["approve", "decline"]),
}).strict();
export const BuyerBudget = z.object({
  proposal_id: z.string().min(1).max(64).describe("The proposal the buyer was looking at."),
  max_total_cents: z.number().int().min(0).max(100_000_000),
}).strict();

export const ReviewLinkCreate = z.object({
  expires_in_minutes: z.number().int().min(5).max(7 * 24 * 60).default(1440),
}).strict();

export const DraftRequest = z.object({
  text: z.string().min(1).max(2000).describe("The buyer's own words."),
  reference_time: z.string().datetime({ offset: true }).optional().describe("Resolves relative dates. Defaults to now."),
  timezone: z.string().min(1).max(64).default("UTC"),
}).strict();

export const WebhookEndpointSet = z.object({
  url: z.string().url().max(500).describe("HTTPS endpoint that receives signed status notifications."),
}).strict();

export const SandboxMerchantCreate = z.object({
  name: z.string().min(1).max(80).default("Sandbox audio store"),
  seed: z.enum(["audio_fixture", "empty"]).default("audio_fixture").describe("audio_fixture loads the 18 fictional audio products with stock."),
  webhook_inbox: z.boolean().default(true).describe("Point webhooks at a ReCart-hosted inbox so you can watch signed callbacks."),
  tax_rate_bps: z.number().int().min(0).max(5000).default(800).describe("Tax on item subtotals in basis points (800 = 8%), rounded half up to the cent."),
}).strict();

export const ID = { recovery: z.string().regex(/^rec_[a-z0-9]{12,40}$/), proposal: z.string().regex(/^prop_[a-z0-9]{12,40}$/) };
