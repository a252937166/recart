# MCP client

```sh
npm install
node client.mjs                                   # creates a sandbox store on https://recart.axiqo.xyz
RECART_API_KEY=rk_test_... node client.mjs        # use your own key
RECART_BASE_URL=http://127.0.0.1:4060 node client.mjs
```

Connects to `<base>/mcp` over Streamable HTTP with `Authorization: Bearer <key>`, lists the tools, drafts requirements from a sentence, previews and creates a recovery, and creates the buyer's review link. Any MCP client that supports Streamable HTTP with a custom header can connect the same way. No tool can approve, charge or change an order: the buyer approves on the review page.
