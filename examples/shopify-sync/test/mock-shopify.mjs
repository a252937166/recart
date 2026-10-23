// A small stand-in for the Shopify Admin API (token endpoint and the GraphQL queries this example sends).
import { createServer } from "node:http";

export function mockShopify({ catalog, quantities, pageSize = 7 }) {
  const state = { quantities: { ...quantities }, tokens: 0, failNextWith401: false, products: catalog };
  const gid = (type, n) => `gid://shopify/${type}/${n}`;
  const products = catalog.map((c, i) => ({ id: gid("Product", 1000 + i), title: c.name, handle: c.sku.toLowerCase(), status: c.status ?? "DRAFT", updatedAt: "2026-10-10T04:34:20Z",
    variant: { id: gid("ProductVariant", 2000 + i), title: "Default Title", sku: c.sku, price: (c.price_cents / 100).toFixed(2), inventoryItem: { id: gid("InventoryItem", 3000 + i), tracked: true } } }));
  const page = (items, first, after) => {
    const start = after ? Number(after) : 0;
    const n = Math.min(first, pageSize);
    return { nodes: items.slice(start, start + n), pageInfo: { hasNextPage: start + n < items.length, endCursor: String(start + n) } };
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      if (req.url === "/admin/oauth/access_token") {
        const f = new URLSearchParams(body);
        if (f.get("grant_type") !== "client_credentials" || f.get("client_secret") !== "secret") return send(400, { error: "invalid_client" });
        state.tokens++;
        return send(200, { access_token: `shpat_mock_${state.tokens}`, scope: "read_products,read_inventory,read_locations", expires_in: 86399 });
      }
      if (req.url !== "/admin/api/2026-10/graphql.json") return send(404, {});
      if (!String(req.headers["x-shopify-access-token"] ?? "").startsWith("shpat_mock_")) return send(401, { errors: "Invalid API key or access token" });
      if (state.failNextWith401) { state.failNextWith401 = false; return send(401, { errors: "Invalid API key or access token" }); }
      const { query, variables } = JSON.parse(body);
      if (query.includes("shop {")) return send(200, { data: { shop: { id: gid("Shop", 1), name: "ReCart Audio Lab", myshopifyDomain: "recart-audio-lab.myshopify.com", currencyCode: "USD" }, currentAppInstallation: { accessScopes: [{ handle: "read_products" }, { handle: "read_inventory" }, { handle: "read_locations" }] } } });
      if (query.includes("products(")) return send(200, { data: { products: page(products.map(({ variant: _v, ...p }) => p), variables.first, variables.after) } });
      if (query.includes("product(id")) { const p = products.find((x) => x.id === variables.id); return send(200, { data: { product: { variants: page([p.variant], variables.first, variables.after) } } }); }
      if (query.includes("locations(")) return send(200, { data: { locations: page([{ id: gid("Location", 86563356766), name: "Shop location", isActive: true }], variables.first, variables.after) } });
      if (query.includes("location(id")) {
        const nodes = products.map((p) => ({ item: { id: p.variant.inventoryItem.id, variant: { id: p.variant.id, sku: p.variant.sku } }, quantities: [{ name: "available", quantity: state.quantities[p.variant.sku] ?? 0 }] }));
        return send(200, { data: { location: { inventoryLevels: page(nodes, variables.first, variables.after) } } });
      }
      return send(200, { errors: [{ message: "unsupported query in mock" }] });
    });
  });
  return { server, state, products, listen: () => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`))) };
}
