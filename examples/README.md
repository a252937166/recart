# Examples

Each example uses only ReCart's published API. `tests/examples/examples.test.ts` runs the first three against an unmodified ReCart server on every `npm test`.

| Example | Shows | Runtime |
|---|---|---|
| [`quickstart/`](quickstart/) | Sandbox store, recovery, buyer link, stock changes that revise the proposal, events and verified webhooks | Node 20+, no dependencies |
| [`sample-store-python/`](sample-store-python/) | An independently written store with its own catalog, tax rule and order book: sync, recovery, approval, execution and acknowledgement | Python 3.9+, standard library |
| [`shopify-sync/`](shopify-sync/) | Read-only Shopify reference: maps products and stock to the standard format, watches stock and creates a reference recovery | Node 20.6+, no dependencies |
| [`mcp-client/`](mcp-client/) | Remote MCP client using the official TypeScript SDK | Node 20+, `@modelcontextprotocol/sdk` |

All default to `https://recart.axiqo.xyz`; set `RECART_BASE_URL` for a local server.
