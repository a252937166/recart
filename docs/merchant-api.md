# ReCart merchant API

ReCart plans the recovery when an ordered item becomes unavailable and records the buyer's approval of one exact proposal version. Your systems keep inventory, orders and checkout. The same contract is available as REST, signed webhooks and a remote MCP server; all three use the same services, keys and scopes.

- Live reference: https://recart.axiqo.xyz/developers (docs, sandbox explorer, endpoint reference)
- OpenAPI 3.1: `GET /v1/openapi.json`; capabilities: `GET /v1/capabilities`; domain pack: `GET /v1/domains/audio-recording-v1`
- Runnable examples: [`examples/`](../examples/)

## Concepts

| Concept | Meaning |
|---|---|
| Merchant | Owns everything below. Sandbox merchants are self-serve and expire after 72 hours; operator merchants are created with `node dist/server/server/admin.js create-operator`. |
| API key | `Authorization: Bearer rk_test_…` or `rk_live_…`, stored as SHA-256. Scopes: `catalog:read`, `catalog:write`, `recoveries:read`, `recoveries:write`, `events:read`, `settings:write`. |
| Product | Your stable `product_id` (for Shopify, the variant GID), a display `sku`, a `role` from the domain pack, `attributes` with the evidence behind each fact (`documented`, `merchant_tested`, `fixture`, `unknown`, `contradicted`), price in minor units and currency. Only `active` products are proposed. |
| Stock count | `available` units per product and location, with `as_of` (when it was true). Older counts than the stored one are ignored; counts older than the merchant's freshness window are never planned with. |
| Recovery | One of your orders with an unavailable item: the buyer's confirmed requirements, the original items (with agreed prices and units you still hold), shipping, the unavailable items and optional fulfillment locations and ready time. |
| Proposal | A computed version with an outcome, changed items and reasons, compatibility checks, single-item swap analysis, totals (items, shipping, tax) and the difference from the original. Hashed and time-limited. |
| Review link | `POST /v1/recoveries/{id}/review-links` returns a capability URL for the buyer. Only the buyer approves, and only the exact version and hash they saw. |
| Execution | After approval, `POST /v1/recoveries/{id}/executions` revalidates the approved version and returns exactly what to apply. You acknowledge `succeeded`, `failed` or `unknown`; an unknown outcome blocks retries until reconciled. |

## Outcomes

| Outcome | Next |
|---|---|
| `proposal_ready` | Buyer reviews and approves on the review page |
| `no_change_needed` | You fulfil the original items (stock exists elsewhere) |
| `budget_conflict` | Buyer may raise the limit (only the buyer can) or decline |
| `deadline_conflict` | Buyer may accept the later time or decline |
| `no_supported_bundle` | You resolve the order under your own policy |
| `evidence_incomplete` | You document the listed attributes; ReCart recomputes |
| `inventory_stale` | You send fresh counts; ReCart recomputes |
| `needs_clarification` | You ask the buyer and update the requirements |
| `unsupported_requirements` | Outside the domain pack; handle manually |
| `search_incomplete` | The search hit its limit; recompute later |

Business outcomes are successful responses. Open proposals are re-planned automatically after catalog or stock changes; a changed plan becomes a new version and a `proposal.revised` event.

## Flow

```sh
# 1. A sandbox store with 18 fictional products, stock, an all-scope key and a hosted webhook inbox.
#    No account or payment details: the developers page's "Get a trial key" makes the same call and shows the key
#    with its expiry (72 hours), copy buttons for the key, MCP URL and Authorization header, and a connection test.
curl -X POST https://recart.axiqo.xyz/v1/sandbox/merchants -H 'Content-Type: application/json' -d '{"name":"My test store"}'

# 2. Open a recovery (the response above includes a ready-made body in try_next.body)
curl -X POST https://recart.axiqo.xyz/v1/recoveries \
  -H "Authorization: Bearer $RECART_KEY" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-1001-recovery' -d @recovery.json

# 3. Give the buyer the review link
curl -X POST https://recart.axiqo.xyz/v1/recoveries/$RECOVERY_ID/review-links \
  -H "Authorization: Bearer $RECART_KEY" -H 'Content-Type: application/json' -d '{}'

# 4. After the buyer approves: revalidate and apply, then acknowledge
curl -X POST https://recart.axiqo.xyz/v1/recoveries/$RECOVERY_ID/executions \
  -H "Authorization: Bearer $RECART_KEY" -H 'Content-Type: application/json' \
  -d '{"proposal_id":"prop_…","proposal_hash":"…"}'
curl -X POST https://recart.axiqo.xyz/v1/recoveries/$RECOVERY_ID/executions/$EXECUTION_ID/acknowledgement \
  -H "Authorization: Bearer $RECART_KEY" -H 'Content-Type: application/json' \
  -d '{"outcome":"succeeded","external_reference":"order-edit-77"}'
```

## Webhooks

`PUT /v1/webhook-endpoint` sets a public HTTPS URL (private and loopback addresses are refused). Each event is POSTed with `ReCart-Signature: t=<unix>,v1=<hex>`, an HMAC-SHA256 of `<t>.<raw body>` with the signing secret returned once. Verify in constant time, reject timestamps older than five minutes, reply 2xx, and de-duplicate by event ID. Non-2xx replies are retried after 30 s, 2 min, 10 min, 30 min, 2 h and 6 h. `GET /v1/events?after=<id>` is the polling alternative.

Event types: `catalog.updated`, `inventory.updated`, `recovery.created`, `proposal.created`, `proposal.revised`, `proposal.approved`, `proposal.declined`, `proposal.expired`, `recovery.requirements_updated`, `recovery.cancelled`, `execution.started`, `execution.succeeded`, `execution.failed`, `execution.unknown`, `webhook.test`.

## Errors, idempotency and limits

Errors are `{"error":{"type","code","message","request_id","details"}}` with the request ID also in the `ReCart-Request-Id` header. Send an `Idempotency-Key` with creates: the same key and request within 24 hours replays the stored response (`Idempotent-Replayed: true`); the same key with a different request fails with `idempotency_key_reused`. Limits: 300 requests per minute per merchant, 30 requirement drafts per hour, 500 products or 1,000 stock counts per batch, 2 MB bodies.

## MCP

`POST /mcp`, Streamable HTTP (stateless, JSON responses), `Authorization: Bearer <key>`. Tools: `draft_requirements`, `preview_recovery`, `create_recovery_proposal`, `get_recovery_status`, `create_buyer_review_link`, `list_catalog_products`. Tested with the official TypeScript SDK 1.32.1 (protocol 2025-11-25) in this project's test suite; see `examples/mcp-client/`.
