# ReCart

**When one part of an order goes missing, ReCart rebuilds the whole purchase, explains every change, and settles only after the buyer approves the exact new version.**

Built for the PayPal AI Hackathon 2026. Payments run on PayPal Sandbox; no real money moves. Products are fictional.

- **Live site:** https://recart.axiqo.xyz, including a live interactive example on the home page.
- **Guided demo:** https://recart.axiqo.xyz/demo. Play the buyer and the store in a self-contained shop with real PayPal Sandbox holds, voids and captures. The Sandbox buyer login is shown on the page.
- **Developers:** https://recart.axiqo.xyz/developers. REST API, signed webhooks, remote MCP server, a live sandbox explorer and the endpoint reference from the published OpenAPI document. "Get a trial key" gives any visitor an isolated sandbox store and a temporary test key for REST and MCP, with no sign-up.
- **For merchants:** https://recart.axiqo.xyz/merchants. Live status of the Shopify reference integration.
- **Evidence:** https://recart.axiqo.xyz/evidence. Sandbox resources, automated checks and the frozen evaluation.
- **Demo video:** https://www.youtube.com/watch?v=iMizZDPYph0.

## The problem

A podcaster orders a recording setup: two mics, an audio interface, headphones, cables and stands. The interface is missing at the packing check. Swapping in "the next interface" can silently break the setup. A USB-B interface needs a different cable and an adapter, a cheaper one may lack the loopback routing the remote guest needs, and a pricier one may break the budget. The original payment must also be released before a different order is charged.

## What ReCart does

1. **Confirms the need.** An AI drafts requirements from the buyer's own words and quotes the words behind each value; a value counts only when those words name it, and anything else becomes a question. The buyer corrects and confirms.
2. **Checks every combination.** A deterministic solver tests every in-stock bundle a declared recipe allows against mic inputs, phantom power, headphone feeds, the remote guest's routing, the computer port, stock, deadline and the all-in budget.
3. **Explains the change.** Changed parts with a reason per role, why a like-for-like swap fails, every passed check with its evidence, and the exact price difference.
4. **Asks for approval of one exact version.** Proposals are versioned and hashed. A stock or price change produces a new version to review; ReCart never relaxes a limit or assumes an undocumented fact.
5. **Settles safely.** In the hosted demo store, PayPal voids the first hold and captures the new total once. External stores revalidate the approved version through the API, apply it in their own systems and acknowledge the outcome.

## Ways to use it

| Entry point | What it is | Money |
|---|---|---|
| Guided demo (`/demo`) | A self-contained shop with buyer and store views and a guide that always shows the next step | Real PayPal Sandbox authorize, void, capture and refund |
| Merchant API (`/v1`) | Versioned REST with OpenAPI 3.1, scoped keys, idempotency and signed webhooks | None: the merchant applies an approved version in its own checkout |
| Remote MCP (`/mcp`) | Streamable HTTP server with planning tools for AI agents, same keys and services as REST | None: no tool can approve, charge or change an order |
| Shopify reference | `examples/shopify-sync`, outside the core: reads a development store's catalog and stock and sends them through the public API | None: read-only, no Shopify checkout, order or payment integration |

The boundary is the same everywhere: ReCart plans recoveries and records the buyer's approval of an exact proposal version; stores own inventory, orders and checkout. See [docs/merchant-api.md](docs/merchant-api.md).

## How PayPal is used

- **Checkout.** JS SDK v6 one-time payment session with server-created `AUTHORIZE` orders, opened as a popup. If a popup blocker stops it, PayPal's in-page overlay takes over. The SDK's automatic mode sometimes never opened anything in our measurements, so it is not used. The browser never decides that money moved.
- **Payment states.** Authorize, then the store confirms, then capture. Otherwise the authorization is voided. A capture that PayPal confirms only at or after the store's deadline is fully refunded and never releases goods; this is checked in the same transaction that records the capture. Payment and fulfillment states are tracked separately.
- **Idempotency.** Every PayPal call is a persisted operation with its own `PayPal-Request-Id`. A lost response becomes "unknown" and is reconciled from PayPal before anything else happens. This was proven against Sandbox by discarding a real capture reply (PP04).
- **Webhooks.** Webhooks only trigger reconciliation. Each one is verified with `verify-webhook-signature` on the raw body before use. PayPal Sandbox does not deliver to the demo's domain, so deliveries pass through a byte-for-byte relay on the Astropods-hosted agent; verification still happens on the ReCart server.

## How AI is used

The AI does two bounded jobs. The primary provider is a self-hosted Codex API gateway (OpenAI-compatible, GPT-6 Luna); the endpoint hosted on Astropods (`hosted-agent/`, Claude Haiku 4.5 via the platform gateway) is the backup, used only while the Codex gateway cannot answer. `/api/health` shows which one is active:

- **`extract_goal`** drafts requirements from the buyer's words. Each value must quote words from the text that support it (a quote about the computer's port cannot set its operating system); unstated or unsupported values stay unknown and become questions. Code then recomputes relative dates and refuses to guess ambiguous ones such as "next Friday". Conflicting budgets become a question.
- **`explain_change`** explains a recomputed bundle. It may mention only the amounts and product names in the checked facts, and must call setups by the names the buyer sees ("Fewest changes", "Alternative"); otherwise ReCart shows a deterministic template.

The AI never chooses products, declares that no solution exists, or touches payment state. If the service is unavailable, the rules extractor and the explanation template take over.

## What is real and what is simulated

| Layer | Status |
|---|---|
| PayPal orders, authorizations, captures, voids, refunds, webhooks (guided demo) | Real PayPal Sandbox resources |
| AI drafts and explanations | Real model calls (GPT-6 Luna via the owner's Codex gateway; Claude Haiku 4.5 via Astropods as backup), with rules and template fallbacks |
| Merchant API, MCP server, webhooks, sandbox stores | Real and live; sandbox stores and their data are fictional and expire after 72 hours |
| Shopify reference store | A real Shopify development store read through a real, read-only Admin API app; its products are the fictional fixtures |
| Products, prices, stock, tax and pickup in the demo store | Team-authored fixtures (`docs/fixtures/spec-sheet-v1.md`), brand-free |
| Store associate and notification inbox in the demo | Simulated inside each isolated demo session |

## Evaluation

The evaluation used 20 frozen, team-authored cases with hand-derived expectations; the details are in `evaluation/REPORT.md`.

- **Solver.** The solver classified all 20 correctly. It solved all 14 feasible cases with the exact expected bundle and total, and produced no invalid payable bundles.
- **Against item-only swaps.** In 19 recovery cases, ReCart found a complete bundle 14 times; replacing only the missing item worked 8 times. ReCart never failed where the item-only swap succeeded.
- **AI extraction.** The untouched first pass got 17 of 20 cases fully right. After fixing what it exposed (date ambiguity moved into code, a conflict rule), reruns reached 20 of 20, and a fresh 8-case holdout scored 8 of 8. Those later scores cover the model plus the deterministic checks after it, not the bare model. Every run is published.

## Run it locally

You need Node 22. PostgreSQL is optional, because `npm run dev:db` starts an embedded one.

```sh
npm ci
npm run dev:db                       # embedded PostgreSQL on 127.0.0.1:5434 (keep it running)
cp .env.example .env                 # add your PayPal Sandbox app credentials
set -a; . ./.env; set +a
npm run build && npm start           # http://127.0.0.1:4060
```

Set `PAYPAL_MODE=fake` to click through without PayPal; an in-process simulator stands in for approval. Without `LANGUAGE_URL`, the rules and template fallbacks are used. Then try `node examples/quickstart/quickstart.mjs` with `RECART_BASE_URL=http://127.0.0.1:4060`.

## Tests and evidence tools

| Command | What it does |
|---|---|
| `npm test` | 258 checks: solver and money units; the language layer's quote-support and explanation-wording rules; payment, recovery and stage-model integration (simulated PayPal client, real PostgreSQL, controlled clock), including immediate refund restart recovery with the original request ID; merchant API, isolation, idempotency, webhooks and OpenAPI; MCP through the official SDK client; language failover, cooldown and probe sharing with deterministic concurrency interleavings, proxy-timeout budgets, job lanes with atomic terminal failures (including a process killed mid-transaction), bounded SIGTERM shutdown of a real server process with an open event stream, the service unit against systemd 219 and effective shutdown settings, and scoped fault simulation; the web app's cache policy, draft persistence, trial-key helpers, PayPal start deadlines, one fresh-document token recovery, cancellation and late-result guards, and links into this repository; the frozen evaluation files; and the published examples run against an unmodified server |
| `cd examples/sample-store-python && python3 -m unittest -v` | The independent sample store's capability tests (needs a running server, `RECART_BASE_URL`) |
| `cd examples/shopify-sync && npm test` | The Shopify example's capability tests (mock Shopify, real ReCart server) |
| `cd hosted-agent && python3 -m unittest discover -s tests` | 29 checks for the hosted agent (language endpoint and webhook relay) |
| `node tools/e2e-judge-flow.mjs` | The guided demo in an isolated browser against real PayPal Sandbox; `SCENARIO=A`, `B` or `C` |
| `node tools/paypal-spike.mjs` | PP01 to PP03: authorize and capture, authorize and void, full refund |
| `node tools/paypal-sdk-check.mjs` | Times the checkout button's three PayPal SDK start steps in a fresh browser and names any step or PayPal request that never answers; no credentials |
| `npx tsx tools/pp04-evidence.mts <order>` | Reads back a lost-capture recovery, including stock consumed at handoff (local server with `PAYPAL_FAULT_INJECTION=1`) |
| `npx tsx tools/run-benchmark.ts` | The frozen evaluation (see `evaluation/`) |
| `node tools/build-evidence.mjs` | Rebuilds the summaries the evidence page shows |

### Browser tools

`e2e-judge-flow.mjs`, `paypal-spike.mjs` and `paypal-sdk-check.mjs` drive Google Chrome, which must be installed, through Playwright's library. `npm ci` installs that library (`playwright-core`), which downloads no browser. Each run uses a new temporary profile, never your own. `PLAYWRIGHT_CHANNEL` picks another installed browser channel, and `PLAYWRIGHT_CORE` another copy of Playwright (the path to its `index.mjs`).

- **`paypal-sdk-check.mjs`** needs no credentials: `BASE=https://recart.axiqo.xyz node tools/paypal-sdk-check.mjs`.
- **`e2e-judge-flow.mjs`** needs a server running with `PAYPAL_MODE=sandbox` (`BASE`, default `http://127.0.0.1:4060`) and a PayPal Sandbox buyer. Set `BUYER_EMAIL` and `BUYER_PASSWORD` (the login the demo page shows works), or put `PP_SANDBOX_TESTER_EMAIL` and `PP_SANDBOX_TESTER_PASSWORD` in the credentials file. `HEADLESS=0` shows the browser. Results go to `evidence/e2e/<SCENARIO>[-<OUT_TAG>]/`.
- **`paypal-spike.mjs`** calls PayPal's REST API itself. Its credentials file needs your Sandbox app's `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`, plus the two tester entries. It replaces `evidence/sandbox/spike-pp01-pp03.json`.

The credentials file holds `KEY=value` lines. It is `~/.config/recart/paypal-sandbox.env`, or the path in `RECART_PAYPAL_ENV`.

## Repository map

| Path | Contents |
|---|---|
| `src/domain/` | Catalog fixtures, recipes, the exhaustive solver, money and time rules |
| `src/platform/` | Merchant planning platform: domain pack, request and response contract, catalog and stock, planning, recoveries, review links, executions, events and webhooks, idempotency, MCP tools |
| `src/server/` | Fastify server: browser routes, REST `/v1`, OpenAPI, MCP, PostgreSQL ledger and migrations, PayPal payment coordinator, demo recovery cases, webhook inbox, job worker, language adapter, operator CLI (`admin.ts`) |
| `src/web/` | React app: home, guided demo, buyer review page, merchants, developers, evidence |
| `examples/` | Quickstart, independent Python sample store, Shopify reference sync, MCP client |
| `hosted-agent/` | The Astropods-hosted agent: backup language endpoint and PayPal webhook relay |
| `evaluation/` | Frozen cases, scoring rules, freeze records, the report and rebuilt historical sources |
| `evidence/` | Recorded Sandbox runs, test summaries and evaluation results |
| `deploy/` | systemd units, nginx site and deployment steps |

## Limits

- The domain pack covers small podcast and interview setups. Nothing here validates physical equipment compatibility; the reference products are fictional.
- The merchant API is live but young: sandbox stores are self-serve and temporary, and operator merchants are created by the operator CLI. There is no merchant self-sign-up for production keys.
- The Shopify example is read-only. It does not edit Shopify orders, run Shopify checkout or take payments.
- The evaluation is builder-authored and small. The five-person comprehension check from the design has not been run.
- Demo sessions live in one browser profile for 24 hours; demo recovery links do not work in other browsers. Merchant review links work anywhere until they expire.

## License

MIT, see `LICENSE`.
