// Shopify Admin GraphQL client for an app installed on a store in the same organization (client credentials grant).
// Read-only: it requests products, variants, locations and inventory levels; it never writes to Shopify.
export const API_VERSION = "2026-10";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ShopifyClient {
  /** @param {{ shop: string, clientId: string, clientSecret: string, apiBase?: string, fetchImpl?: typeof fetch }} o */
  constructor(o) {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(o.shop)) throw new Error("SHOPIFY_SHOP must be the store's myshopify.com hostname");
    this.shop = o.shop;
    this.base = (o.apiBase ?? `https://${o.shop}`).replace(/\/$/, "");
    this.clientId = o.clientId;
    this.clientSecret = o.clientSecret;
    this.fetch = o.fetchImpl ?? fetch;
    this.cached = null;
    this.requests = 0;
  }

  /** Access tokens from this grant expire (about 24 h): cache one and renew it five minutes early. */
  async token() {
    if (this.cached && this.cached.expiresAt - 5 * 60_000 > Date.now()) return this.cached.token;
    const r = await this.fetch(`${this.base}/admin/oauth/access_token`, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.clientId, client_secret: this.clientSecret }),
    });
    this.requests++;
    if (!r.ok) throw new Error(`Shopify token request failed with HTTP ${r.status}; check the app credentials and that the app is installed`);
    const j = await r.json();
    this.cached = { token: j.access_token, expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000, scopes: String(j.scope ?? "").split(",").filter(Boolean) };
    return this.cached.token;
  }

  async graphql(query, variables = {}) {
    for (let attempt = 0; ; attempt++) {
      const r = await this.fetch(`${this.base}/admin/api/${API_VERSION}/graphql.json`, {
        method: "POST", redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json", "x-shopify-access-token": await this.token() },
        body: JSON.stringify({ query, variables }),
      });
      this.requests++;
      if (r.status === 401 && attempt === 0) { this.cached = null; continue; } // expired or revoked token: renew once
      if ((r.status === 429 || r.status >= 500) && attempt < 4) { await sleep(500 * 2 ** attempt); continue; }
      if (!r.ok) throw new Error(`Shopify GraphQL HTTP ${r.status}`);
      const j = await r.json();
      if (j.errors?.some((e) => e.extensions?.code === "THROTTLED") && attempt < 4) { await sleep(1000 * 2 ** attempt); continue; }
      if (j.errors?.length) throw new Error(`Shopify GraphQL error: ${j.errors.map((e) => e.message).join("; ")}`);
      return j.data;
    }
  }

  async *pages(query, variables, select) {
    let after = null;
    for (let i = 0; i < 1000; i++) {
      const conn = select(await this.graphql(query, { ...variables, after, first: 50 }));
      yield* conn.nodes;
      if (!conn.pageInfo.hasNextPage) return;
      after = conn.pageInfo.endCursor;
    }
  }

  async shopInfo() {
    const d = await this.graphql(`query { shop { id name myshopifyDomain currencyCode } currentAppInstallation { accessScopes { handle } } }`);
    return { ...d.shop, scopes: d.currentAppInstallation.accessScopes.map((s) => s.handle) };
  }

  /** Products with their variants (all pages). */
  async products() {
    const out = [];
    for await (const p of this.pages(`query Products($after: String, $first: Int!) { products(first: $first, after: $after, sortKey: ID) { nodes { id title handle status updatedAt } pageInfo { hasNextPage endCursor } } }`, {}, (d) => d.products)) {
      const variants = [];
      for await (const v of this.pages(`query Variants($id: ID!, $after: String, $first: Int!) { product(id: $id) { variants(first: $first, after: $after) { nodes { id title sku price inventoryItem { id tracked } } pageInfo { hasNextPage endCursor } } } }`, { id: p.id }, (d) => d.product.variants)) variants.push(v);
      out.push({ ...p, variants });
    }
    return out;
  }

  async locations() {
    const out = [];
    for await (const l of this.pages(`query Locations($after: String, $first: Int!) { locations(first: $first, after: $after) { nodes { id name isActive } pageInfo { hasNextPage endCursor } } }`, {}, (d) => d.locations)) out.push(l);
    return out.filter((l) => l.isActive !== false);
  }

  /** Available units per variant at one location. */
  async inventoryLevels(locationId) {
    const out = [];
    const q = `query Levels($id: ID!, $after: String, $first: Int!) { location(id: $id) { inventoryLevels(first: $first, after: $after) { nodes { item { id variant { id sku } } quantities(names: ["available"]) { name quantity } } pageInfo { hasNextPage endCursor } } } }`;
    for await (const n of this.pages(q, { id: locationId }, (d) => d.location.inventoryLevels)) {
      if (!n.item?.variant) continue;
      out.push({ variantId: n.item.variant.id, sku: n.item.variant.sku, locationId, available: n.quantities.find((x) => x.name === "available")?.quantity ?? 0 });
    }
    return out;
  }
}
