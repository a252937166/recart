import { z } from "zod";
import { listProducts } from "./catalog.js";
import * as C from "./contract.js";
import type { PlatformCtx } from "./core.js";
import { withIdempotency } from "./idempotency.js";
import type { Principal } from "./merchants.js";
import { API_ROLES } from "./pack.js";
import { createRecovery, createReviewLink, getRecovery, previewRecovery } from "./recoveries.js";
import { draftRequirements } from "./requirements.js";
import { DraftRequest, RecoveryCreate, RecoveryPreview, type Scope } from "./schemas.js";

/** The remote MCP server's tools: thin adapters over the same services and scopes as the REST API. */
export const MCP_SERVER_INFO = { name: "recart", title: "ReCart recovery planning", version: "1.0.0" };
export const MCP_INSTRUCTIONS = [
  "ReCart plans a complete replacement purchase when an item of a merchant's order becomes unavailable, checking every combination of in-stock products against the buyer's confirmed requirements.",
  "Typical flow: draft_requirements from the buyer's words, confirm them with the buyer, then preview_recovery or create_recovery_proposal, create_buyer_review_link for the buyer, and get_recovery_status to follow up.",
  "Payment and order changes require the buyer's explicit approval of an exact proposal version on the review page. No tool can approve a proposal, change an order, reserve stock or move money.",
].join(" ");

interface Tool { name: string; title: string; description: string; scope: Scope; input: z.ZodType; output: z.ZodType; annotations: Record<string, boolean>; run: (pctx: PlatformCtx, p: Principal, args: any) => Promise<unknown> }

const RecoveryId = z.object({ recovery_id: z.string().min(1).max(64).describe("The recovery's id (rec_…).") }).strict();
export const MCP_TOOLS: Tool[] = [
  {
    name: "draft_requirements", title: "Draft buyer requirements", scope: "recoveries:write",
    description: "Turn the buyer's own words into draft requirements in ReCart's standard format, quoting the words behind each value and listing what is missing. A draft is never a confirmation: show it to the buyer and use only buyer-confirmed requirements in other tools.",
    input: DraftRequest, output: C.RequirementDraft, annotations: { readOnlyHint: true, openWorldHint: true },
    run: (pctx, p, a) => draftRequirements(pctx, p.merchant, a),
  },
  {
    name: "preview_recovery", title: "Preview a recovery", scope: "recoveries:read",
    description: "Compute what ReCart would propose for an order whose item became unavailable, without storing anything: the changed items, every compatibility check, the price difference and the outcome (proposal_ready, budget_conflict, no_supported_bundle, ...).",
    input: RecoveryPreview, output: C.RecoveryPreviewResult, annotations: { readOnlyHint: true, openWorldHint: false },
    run: (pctx, p, a) => previewRecovery(pctx, p.merchant, a),
  },
  {
    name: "create_recovery_proposal", title: "Create a recovery proposal", scope: "recoveries:write",
    description: "Open a recovery for an affected order and compute its first proposal (stored, versioned, with an expiry). This cannot approve the proposal, change the order or move money: only the buyer approves, on the review page. Pass idempotency_key to make retries safe; it is shared with the REST Idempotency-Key.",
    input: RecoveryCreate.extend({ idempotency_key: z.string().min(1).max(255).optional().describe("Same value as a REST Idempotency-Key: a retry returns the original result.") }),
    output: C.Recovery, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (pctx, p, a) => {
      const { idempotency_key, ...body } = a;
      const out = await withIdempotency(pctx.db, p.merchant.id, idempotency_key, "POST /v1/recoveries", body, async () => ({ status: 201, body: await createRecovery(pctx, p.merchant, body) }));
      return out.body;
    },
  },
  {
    name: "get_recovery_status", title: "Get recovery status", scope: "recoveries:read",
    description: "A recovery's status, who acts next, the current proposal (items, compatibility, totals, difference) and the latest execution.",
    input: RecoveryId, output: C.Recovery, annotations: { readOnlyHint: true, openWorldHint: false },
    run: (pctx, p, a) => getRecovery(pctx, p.merchant, a.recovery_id),
  },
  {
    name: "create_buyer_review_link", title: "Create a buyer review link", scope: "recoveries:write",
    description: "Create the link the buyer opens to review the current proposal and approve or decline it. Give it only to the buyer; it is the only place a proposal can be approved.",
    input: RecoveryId.extend({ expires_in_minutes: z.number().int().min(5).max(10080).default(1440) }), output: C.ReviewLink, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: (pctx, p, a) => createReviewLink(pctx, p.merchant, a.recovery_id, a.expires_in_minutes),
  },
  {
    name: "list_catalog_products", title: "List catalog products", scope: "catalog:read",
    description: "The merchant's products in the standard format: role, attributes with their evidence, price and status.",
    input: z.object({ role: z.enum(API_ROLES).optional(), status: z.enum(["active", "draft", "archived"]).optional(), after: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(),
    output: C.ProductList, annotations: { readOnlyHint: true, openWorldHint: false },
    run: (pctx, p, a) => listProducts(pctx.db, p.merchant.id, { role: a.role, status: a.status, after: a.after, limit: a.limit }),
  },
];
