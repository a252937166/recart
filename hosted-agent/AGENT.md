---
description: "ReCart language adapter (bounded extract_goal / explain_change inference behind a service bearer) and PayPal webhook relay to the ReCart server, plus the original gateway probes."
tags: [recart, probe]
authors: []
capabilities: [http, tool-calling]
integrations:
  []
---

Validates a fixed JSON response and a synthetic stock tool loop through the platform-injected gateway. It accepts no arbitrary prompts and performs no payment or merchant operations. `POST /v1/paypal/webhook` relays PayPal Sandbox webhook deliveries byte-for-byte to the ReCart server, which verifies each event with PayPal before using it; the relay holds no PayPal credentials and never logs payloads. External callers need the separate ReCart probe bearer secret; the model credential never leaves the service.
