import { z } from "zod";
import * as C from "../../platform/contract.js";
import { SCOPES } from "../../platform/schemas.js";
import * as S from "../../platform/schemas.js";

type Op = { method: "get" | "post" | "put" | "delete"; path: string; id: string; summary: string; scope?: string | null; request?: string; response: string; status?: number; idempotent?: boolean; query?: [string, string][]; tag: string };

/** OpenAPI 3.1, generated from the same zod schemas that validate requests and the contract tests' response schemas. */
export function buildOpenApi(baseUrl: string) {
  const schema = (s: z.ZodType, io: "input" | "output") => { const j = z.toJSONSchema(s, { io, unrepresentable: "any" }) as any; delete j.$schema; return j; };
  const requests: Record<string, z.ZodType> = {
    CatalogUpsert: S.CatalogUpsert, InventoryUpsert: S.InventoryUpsert, Requirements: S.Requirements, RecoveryCreate: S.RecoveryCreate, RecoveryPreview: S.RecoveryPreview,
    RecoveryUpdate: S.RecoveryUpdate, ReviewLinkCreate: S.ReviewLinkCreate, ExecutionCreate: S.ExecutionCreate, ExecutionAcknowledge: S.ExecutionAcknowledge,
    ApiKeyCreate: S.ApiKeyCreate, IntegrationReport: S.IntegrationReport, DraftRequest: S.DraftRequest, WebhookEndpointSet: S.WebhookEndpointSet, SandboxMerchantCreate: S.SandboxMerchantCreate,
  };
  const responses: Record<string, z.ZodType> = {
    Error: C.ErrorResponse, Product: C.Product, ProductDetail: C.ProductDetail, ProductList: C.ProductList, CatalogUpsertResult: C.CatalogUpsertResult, InventoryUpsertResult: C.InventoryUpsertResult,
    InventoryList: C.InventoryList, Proposal: C.Proposal, RecoveryPreviewResult: C.RecoveryPreviewResult, Recovery: C.Recovery, RecoveryList: C.RecoveryList, ProposalList: C.ProposalList,
    RecomputeResult: C.RecomputeResult, ReviewLink: C.ReviewLink, ExecutionStarted: C.ExecutionStarted, RequirementDraft: C.RequirementDraft, Event: C.Event, EventList: C.EventList,
    WebhookDeliveryList: C.WebhookDeliveryList, ApiKeyCreated: C.ApiKeyCreated, Object: C.Loose,
  };
  const ops: Op[] = [
    { tag: "Discovery", method: "get", path: "/v1/capabilities", id: "getCapabilities", summary: "Features, limits, scopes, outcomes and the execution boundary of this server", scope: null, response: "Object" },
    { tag: "Discovery", method: "get", path: "/v1/domains/audio-recording-v1", id: "getDomainPack", summary: "Roles, attributes, evidence modes, recipes and checks of the audio-recording domain pack", scope: null, response: "Object" },
    { tag: "Sandbox", method: "post", path: "/v1/sandbox/merchants", id: "createSandboxMerchant", summary: "Create a temporary sandbox merchant with a test key, fixture catalog and hosted webhook inbox", scope: null, request: "SandboxMerchantCreate", response: "Object", status: 201 },
    { tag: "Sandbox", method: "get", path: "/v1/sandbox/inbox", id: "listSandboxInbox", summary: "Callbacks the hosted inbox received, with signature verification results", scope: "events:read", response: "Object", query: [["limit", "1-100"]] },
    { tag: "Merchant", method: "get", path: "/v1/merchant", id: "getMerchant", summary: "The merchant behind the API key and the key's scopes", scope: "any", response: "Object" },
    { tag: "Merchant", method: "get", path: "/v1/merchant/status", id: "getIntegrationStatus", summary: "Integration health: catalog, stock freshness, recoveries, callbacks", scope: "any", response: "Object" },
    { tag: "Merchant", method: "put", path: "/v1/merchant/integration", id: "reportIntegration", summary: "Declare what your integration supports (shown on the status page)", scope: "settings:write", request: "IntegrationReport", response: "Object" },
    { tag: "Catalog", method: "get", path: "/v1/catalog/products", id: "listProducts", summary: "List products", scope: "catalog:read", response: "ProductList", query: [["status", "active|draft|archived"], ["role", "mic|interface|..."], ["after", "product_id cursor"], ["limit", "1-500"]] },
    { tag: "Catalog", method: "post", path: "/v1/catalog/products", id: "upsertProducts", summary: "Create or update up to 500 products in the standard format", scope: "catalog:write", request: "CatalogUpsert", response: "CatalogUpsertResult", idempotent: true },
    { tag: "Catalog", method: "get", path: "/v1/catalog/products/{product_id}", id: "getProduct", summary: "One product with its stock counts (URL-encode the product_id)", scope: "catalog:read", response: "ProductDetail" },
    { tag: "Catalog", method: "get", path: "/v1/inventory/levels", id: "listInventory", summary: "Stock counts and whether each is fresh enough to plan with", scope: "catalog:read", response: "InventoryList", query: [["product_id", "filter"], ["limit", "1-1000"]] },
    { tag: "Catalog", method: "post", path: "/v1/inventory/levels", id: "upsertInventory", summary: "Record up to 1000 stock counts; older counts than stored are ignored", scope: "catalog:write", request: "InventoryUpsert", response: "InventoryUpsertResult", idempotent: true },
    { tag: "Planning", method: "post", path: "/v1/requirement-drafts", id: "draftRequirements", summary: "Draft requirements from the buyer's own words (never a confirmation)", scope: "recoveries:write", request: "DraftRequest", response: "RequirementDraft" },
    { tag: "Planning", method: "post", path: "/v1/recovery-previews", id: "previewRecovery", summary: "Compute a proposal without storing anything", scope: "recoveries:read", request: "RecoveryPreview", response: "RecoveryPreviewResult" },
    { tag: "Recoveries", method: "post", path: "/v1/recoveries", id: "createRecovery", summary: "Open a recovery for an order and compute its first proposal", scope: "recoveries:write", request: "RecoveryCreate", response: "Recovery", status: 201, idempotent: true },
    { tag: "Recoveries", method: "get", path: "/v1/recoveries", id: "listRecoveries", summary: "List recoveries, newest first", scope: "recoveries:read", response: "RecoveryList", query: [["status", "filter"], ["external_order_id", "filter"], ["before", "recovery id cursor"], ["limit", "1-100"]] },
    { tag: "Recoveries", method: "get", path: "/v1/recoveries/{id}", id: "getRecovery", summary: "Status, next action, current proposal and latest execution", scope: "recoveries:read", response: "Recovery" },
    { tag: "Recoveries", method: "get", path: "/v1/recoveries/{id}/proposals", id: "listProposals", summary: "Every proposal version, newest first", scope: "recoveries:read", response: "ProposalList" },
    { tag: "Recoveries", method: "put", path: "/v1/recoveries/{id}/requirements", id: "updateRequirements", summary: "Replace the buyer-confirmed requirements and re-plan", scope: "recoveries:write", request: "RecoveryUpdate", response: "Recovery", idempotent: true },
    { tag: "Recoveries", method: "post", path: "/v1/recoveries/{id}/recompute", id: "recomputeRecovery", summary: "Re-plan with current catalog and stock; a new version only if the plan changed", scope: "recoveries:write", response: "RecomputeResult" },
    { tag: "Recoveries", method: "post", path: "/v1/recoveries/{id}/cancel", id: "cancelRecovery", summary: "Cancel a recovery that has no execution", scope: "recoveries:write", response: "Recovery", idempotent: true },
    { tag: "Recoveries", method: "post", path: "/v1/recoveries/{id}/review-links", id: "createReviewLink", summary: "Create the buyer's review link (the only place a proposal can be approved)", scope: "recoveries:write", request: "ReviewLinkCreate", response: "ReviewLink", status: 201, idempotent: true },
    { tag: "Execution", method: "post", path: "/v1/recoveries/{id}/executions", id: "startExecution", summary: "Revalidate the approved version and receive exactly what to apply", scope: "recoveries:write", request: "ExecutionCreate", response: "ExecutionStarted", status: 201, idempotent: true },
    { tag: "Execution", method: "post", path: "/v1/recoveries/{id}/executions/{execution_id}/acknowledgement", id: "acknowledgeExecution", summary: "Report succeeded, failed or unknown after applying it in your system", scope: "recoveries:write", request: "ExecutionAcknowledge", response: "Recovery", idempotent: true },
    { tag: "Events", method: "get", path: "/v1/events", id: "listEvents", summary: "Events in order; poll with after=<last event id>", scope: "events:read", response: "EventList", query: [["after", "event id cursor"], ["type", "event type"], ["limit", "1-100"]] },
    { tag: "Events", method: "get", path: "/v1/webhook-deliveries", id: "listWebhookDeliveries", summary: "Callback delivery attempts and results", scope: "events:read", response: "WebhookDeliveryList", query: [["limit", "1-100"]] },
    { tag: "Events", method: "put", path: "/v1/webhook-endpoint", id: "setWebhookEndpoint", summary: "Set the HTTPS callback URL (the signing secret is returned once)", scope: "settings:write", request: "WebhookEndpointSet", response: "Object", query: [["rotate_secret", "true to rotate"]] },
    { tag: "Events", method: "delete", path: "/v1/webhook-endpoint", id: "deleteWebhookEndpoint", summary: "Stop callbacks (events remain readable)", scope: "settings:write", response: "Object" },
    { tag: "Events", method: "post", path: "/v1/webhook-endpoint/test", id: "testWebhookEndpoint", summary: "Send a signed webhook.test event", scope: "settings:write", response: "Object" },
    { tag: "Merchant", method: "get", path: "/v1/api-keys", id: "listApiKeys", summary: "List API keys (never the secrets)", scope: "settings:write", response: "Object" },
    { tag: "Merchant", method: "post", path: "/v1/api-keys", id: "createApiKey", summary: "Create a key restricted to the scopes an integration needs", scope: "settings:write", request: "ApiKeyCreate", response: "ApiKeyCreated", status: 201 },
    { tag: "Merchant", method: "delete", path: "/v1/api-keys/{key_id}", id: "revokeApiKey", summary: "Revoke a key (not the one making the call)", scope: "settings:write", response: "Object" },
  ];
  const paths: Record<string, any> = {};
  for (const o of ops) {
    const params = [...o.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    const query = (o.query ?? []).map(([name, description]) => ({ name, in: "query", required: false, description, schema: { type: "string" } }));
    const headers = o.idempotent ? [{ name: "Idempotency-Key", in: "header", required: false, description: "Retry-safe key (1-255 printable ASCII). Same key + same request replays the stored response for 24 h; a different request is rejected.", schema: { type: "string", maxLength: 255 } }] : [];
    const errorRef = { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } };
    (paths[o.path] ??= {})[o.method] = {
      operationId: o.id, summary: o.summary, tags: [o.tag],
      ...(o.scope === null ? { security: [] } : { security: [{ apiKey: [] }], "x-recart-scope": o.scope }),
      parameters: [...params, ...query, ...headers],
      ...(o.request ? { requestBody: { required: true, content: { "application/json": { schema: { $ref: `#/components/schemas/${o.request}` } } } } } : {}),
      responses: { [String(o.status ?? 200)]: { description: "Success", content: { "application/json": { schema: { $ref: `#/components/schemas/${o.response}` } } } }, "4XX": errorRef, "5XX": errorRef },
    };
  }
  const components: Record<string, any> = {};
  for (const [k, v] of Object.entries(requests)) components[k] = schema(v, "input");
  for (const [k, v] of Object.entries(responses)) components[k] = schema(v, "output");
  return {
    openapi: "3.1.0",
    info: {
      title: "ReCart Recovery Planning API", version: "v1 (2026-10-10)",
      description: "Recover a complete purchase when an ordered item becomes unavailable. Send your catalog and stock in the standard format, open a recovery for an affected order, and give the buyer a review link. ReCart plans and records the buyer's approval of an exact proposal version; your systems own inventory, orders and checkout, apply the approved version and acknowledge the outcome. Amounts are integer minor units with an explicit currency; timestamps are ISO 8601 with offset.",
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: [{ url: baseUrl.replace(/\/$/, "") }],
    tags: ["Discovery", "Sandbox", "Merchant", "Catalog", "Planning", "Recoveries", "Execution", "Events"].map((name) => ({ name })),
    paths,
    webhooks: {
      recartEvent: {
        post: {
          summary: "ReCart status notification",
          description: "Sent to your webhook endpoint. Verify `ReCart-Signature: t=<unix>,v1=<hex>`: compute HMAC-SHA256 with your signing secret over `<t>.<raw body>`, compare in constant time and reject timestamps older than 5 minutes. Respond 2xx; other responses are retried (30s, 2m, 10m, 30m, 2h, 6h). Deliveries can repeat: de-duplicate by event id.",
          parameters: [{ name: "ReCart-Signature", in: "header", required: true, schema: { type: "string" } }, { name: "ReCart-Event-Id", in: "header", required: true, schema: { type: "string" } }, { name: "ReCart-Event-Type", in: "header", required: true, schema: { type: "string" } }],
          requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Event" } } } },
          responses: { "200": { description: "Received" } },
        },
      },
    },
    components: {
      schemas: components,
      securitySchemes: { apiKey: { type: "http", scheme: "bearer", description: `ReCart API key (rk_test_… for sandbox). Scopes: ${SCOPES.join(", ")}.` } },
    },
  };
}
