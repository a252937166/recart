# Shopify reference sync (read-only)

Reads a Shopify store's products, variants, locations and stock through the Admin GraphQL API (2026-10), maps them to ReCart's standard format and sends them through ReCart's public API. All Shopify-specific knowledge lives here, outside ReCart.

**Supported:** catalog sync, inventory sync, stock-change watch, recovery requests for a reference order defined by the example, buyer review links.
**Not supported:** Shopify checkout, Shopify order edits, payments, writes to Shopify. This is a data and planning example, not a payment integration.

## Setup

1. In the Shopify Dev Dashboard, create an app in the same organization as the store with the scopes `read_products`, `read_inventory` and `read_locations`, and install it on the store. Same-organization apps can use the client credentials grant; other merchants need their own authorization flow.
2. Get a ReCart key with `catalog:write`, `recoveries:write` and `settings:write` (a sandbox store from `/developers` works).
3. Create an env file (keep it private):
   ```sh
   SHOPIFY_SHOP=your-store.myshopify.com
   SHOPIFY_CLIENT_ID=...
   SHOPIFY_CLIENT_SECRET=...
   RECART_BASE_URL=https://recart.axiqo.xyz
   RECART_API_KEY=rk_...
   ```

## Commands

```sh
node --env-file=shopify.env cli.mjs sync [--include-drafts]           # full sync once
node --env-file=shopify.env cli.mjs watch --include-drafts --interval 60
node --env-file=shopify.env cli.mjs demo-order [--budget 45000]       # reference recovery + review link
node --env-file=shopify.env cli.mjs status
npm test                                                              # mock Shopify, real ReCart (RECART_BASE_URL)
```

## Mapping

- **Identity:** `product_id` is the variant GID; the SKU is display-only and selects the reviewed facts in `mapping.json`.
- **Compatibility facts:** Shopify has no field for connectors or loopback, so `mapping.json` supplies role and attributes per SKU, each with its evidence. The reference store sells the fictional ReCart fixtures, so every fact is `fixture`. A real store would cite its spec sheets (`documented`) or bench tests (`merchant_tested`).
- **Unmapped variants** are skipped and logged, never guessed.
- **Drafts:** `DRAFT` products are sent as `draft` and never proposed, unless `--include-drafts` is given explicitly. The reference store's products are drafts.
- **Stock:** `available` at each active location; `as_of` is when the count was read.
- **Prices:** decimal strings become integer cents, and the currency comes from the shop.

## Stock-change demonstration

The reference order is the fixture order whose 2-in USB-C interface is missing at packing. While Shopify still counts one more of that interface, ReCart answers `no_change_needed`. Set that product's available quantity to 0 in Shopify admin: the watcher sends the new count, and ReCart revises the open proposal to `proposal_ready` with the USB-B interface, cable and adapter (+$45.36). Restore the quantity to revise it back.

The access token from the client credentials grant expires after about 24 hours. The client caches it, renews it five minutes early, and renews once more on a 401.
