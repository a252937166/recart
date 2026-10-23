# ReCart hosted agent (Astropods)

A small hosted HTTP service on Astropods with three jobs:

- **Language.** It forwards ReCart's two bounded language tasks to the platform's model gateway.
- **Webhook relay.** It relays PayPal Sandbox webhooks to the ReCart server.
- **Gateway probes.** It keeps the original fixed probes that first proved gateway access.

It uses the Python standard library only. It holds no PayPal credentials, makes no payment or inventory decisions, and never logs buyer text, model output or webhook payloads.

| Endpoint | Authentication | Behavior |
|---|---|---|
| `GET /health` | Public | Liveness and configuration booleans; no model call |
| `POST /v1/language` | Bearer | `extract_goal` or `explain_change` with repository-owned prompts; bounded and budgeted |
| `GET /v1/language/status` | Bearer | Lifetime request budget and token counters |
| `POST /v1/paypal/webhook` | None (PayPal cannot send a bearer) | Relays a PayPal delivery byte for byte to the ReCart server |
| `GET /v1/paypal/relay/status` | Bearer | Relay counters |
| `GET /probe/status`, `POST /probe/basic`, `POST /probe/tool-loop` | Bearer | The original fixed gateway probes |

## Language endpoint

The ReCart server sends `{protocol: 1, task, requestId, messages, maxTokens}`. Prompts live in the ReCart repository (`src/server/language/prompts.ts`), not here.

The service accepts only these two tasks:

| Task | Output-token cap |
|---|---|
| `extract_goal` | 1,024 |
| `explain_change` | 768 |

It accepts at most four messages, with system and user roles only. Each message is capped at 16,000 characters and a request at 24,000. Temperature is fixed at 0.

Admission control:

- Two model calls run at once, with four more queued for up to 10 seconds.
- At most 60 calls per minute.
- A durable lifetime cap, `RECART_LANGUAGE_REQUEST_LIMIT` (default 2,500), stored in SQLite under `/data`.
- Each upstream call has a 14-second timeout.

The reply echoes `requestId` and returns the text, token usage and duration. Errors are typed codes.

## PayPal webhook relay

PayPal Sandbox's webhook sender refuses the demo server's domain before sending any TLS data. It does deliver to this agent's public host. So PayPal posts here, and the relay forwards the exact raw body and PayPal's transmission headers to `RECART_WEBHOOK_FORWARD_URL`. The ReCart server verifies every event with PayPal's verify-webhook-signature API before using it. The relay therefore cannot invent or alter an event without failing verification.

The relay only forwards requests that look like PayPal deliveries:

- each PayPal transmission header appears exactly once;
- the certificate URL is on an official PayPal API host;
- the body is a JSON event whose ID starts with `WH-`;
- the body is at most 64 KiB, and chunked bodies are supported.

Rate limits are 120 requests per minute with 4 at once. Forwarding never follows redirects. An upstream 5xx or timeout returns 502, so PayPal retries. An upstream 4xx is passed through.

## Configuration

| Input | Purpose |
|---|---|
| `RECART_PROBE_API_KEY` (secret) | Bearer for every authenticated endpoint; at least 32 characters |
| `RECART_LANGUAGE_REQUEST_LIMIT` | Lifetime cap on language requests (1 to 10,000; default 2,500) |
| `RECART_WEBHOOK_FORWARD_URL` | ReCart's webhook route; the relay is off when empty |
| `RECART_PROBE_REQUEST_LIMIT` | Cap on the original probes (default 20) |

The platform injects `ASTRO_GATEWAY_URL`, `ASTRO_GATEWAY_API_KEY` and `MODEL_DEFAULT` (`claude-haiku-4-5`). Run a single instance with a writable `/data`. The container listens on port 80 as UID 1000.

## Build and deploy

```sh
ast spec validate
ast blueprint push recart-gateway-probe --visibility private -y --json   # prints the build ID
```

In the Astropods console, open the agent's General page, select the new build, and choose Redeploy. New inputs appear with their defaults, and configured secrets are kept. Builds so far:

| Build | Change |
|---|---|
| `727317d0`, `93a3b612`, `7e02af9b` | Probes |
| `e488487a` | Language endpoint |
| `2d85f941` | Webhook relay (current) |

## Local checks

```sh
python3 -m unittest discover -s tests -v
```

The 29 checks use mocked upstreams and a localhost listener. They never load credentials or call a model.
