import { BASE_STOCK } from "../domain/catalog/fixtures.js";
import { clock } from "../server/clock.js";
import { withTx } from "../server/db/pool.js";
import { ApiError, type PlatformCtx } from "./core.js";
import { inboxUrl } from "./events.js";
import { createMerchant, issueApiKey, merchantView, setWebhookEndpoint } from "./merchants.js";
import { fixtureProducts } from "./pack.js";

/** The reference order every audio-fixture sandbox starts with: the $376.92 two-person podcast setup. */
export const REFERENCE_ORDER_ITEMS = [
  { product_id: "IF-2C-LB", quantity: 1 }, { product_id: "MIC-DX-A", quantity: 2 }, { product_id: "CBL-XLR-3", quantity: 2 },
  { product_id: "HP-CB-A", quantity: 2 }, { product_id: "CBL-CC-1", quantity: 1 }, { product_id: "STD-DK-A", quantity: 2 },
];
export const SANDBOX_LOCATION = "main";

/** A complete, runnable recovery request for the reference order (copy it into the explorer or quickstart). */
export function referenceRecoveryRequest(budgetCents = 45000) {
  return {
    external_order_id: "order-1001",
    currency: "USD",
    requirements: { local_people: 2, remote_guests: 1, host_port: "usb-c", os: "macos", call_app: "zoom", budget: { max_total_cents: budgetCents, currency: "USD" }, needed_by: null, timezone: "America/Los_Angeles" },
    original_items: REFERENCE_ORDER_ITEMS,
    unavailable_items: [{ product_id: "IF-2C-LB", quantity: 1, reason: "missing_at_packing" }],
    fulfillment: { location_ids: [SANDBOX_LOCATION] },
  };
}

/**
 * Self-serve sandbox merchant: fictional fixture catalog, stock with the reference order's units already allocated,
 * an all-scope test key and (optionally) webhooks pointed at a ReCart-hosted inbox. Expires automatically.
 */
export async function createSandboxMerchant(ctx: PlatformCtx, a: { name: string; seed: "audio_fixture" | "empty"; webhook_inbox: boolean; tax_rate_bps?: number }) {
  if (ctx.cfg.SANDBOX_SIGNUP !== "true") throw new ApiError("permission_denied", "sandbox_disabled", "Sandbox sign-up is disabled on this server.");
  return withTx(ctx.db, async (tx) => {
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + ctx.cfg.SANDBOX_TTL_HOURS * 3600_000);
    let m = await createMerchant(tx, { name: a.name, kind: "sandbox", currency: "USD", taxRateBps: a.tax_rate_bps ?? 800, expiresAt, inventoryMaxAgeSeconds: 7 * 24 * 3600, proposalTtlSeconds: 24 * 3600 });
    const key = await issueApiKey(tx, m, "sandbox default key");
    const webhook = a.webhook_inbox ? await setWebhookEndpoint(tx, m, inboxUrl(ctx.cfg, m.id)) : null;
    if (a.seed === "audio_fixture") {
      for (const p of fixtureProducts()) {
        await tx.query(`insert into catalog_products(merchant_id,product_id,sku,name,role,description,attributes,price_cents,currency,status,source_updated_at,updated_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`, [m.id, p.product_id, p.sku, p.name, p.role, p.description, JSON.stringify(p.attributes), p.price_cents, p.currency, p.status, now]);
        const allocated = REFERENCE_ORDER_ITEMS.find((i) => i.product_id === p.product_id)?.quantity ?? 0;
        await tx.query("insert into inventory_levels(merchant_id,product_id,location_id,available,as_of,received_at) values ($1,$2,$3,$4,$5,$5)", [m.id, p.product_id, SANDBOX_LOCATION, Math.max(0, (BASE_STOCK[p.product_id] ?? 0) - allocated), now]);
      }
      await tx.query("update merchants set catalog_version=1 where id=$1", [m.id]);
      m = { ...m, catalog_version: 1, webhook_url: webhook?.url ?? null };
    }
    return {
      merchant: merchantView({ ...m, webhook_url: webhook?.url ?? null }),
      api_key: key.key, api_key_id: key.id, scopes: key.scopes,
      webhook: webhook ? { url: webhook.url, secret: webhook.secret, inbox: "GET /v1/sandbox/inbox shows each delivered callback and whether its signature verified." } : null,
      seed: a.seed === "audio_fixture" ? { products: fixtureProducts().length, location_id: SANDBOX_LOCATION, reference_order: { external_order_id: "order-1001", items: REFERENCE_ORDER_ITEMS, note: "Its units are already allocated: available counts exclude them." } } : null,
      try_next: a.seed === "audio_fixture" ? { method: "POST", path: "/v1/recoveries", body: referenceRecoveryRequest() } : null,
      expires_at: expiresAt.toISOString(),
      notice: "Sandbox data is fictional and is deleted after expiry. Store the API key now; it is shown once.",
    };
  });
}
