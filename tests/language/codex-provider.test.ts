import { describe, expect, it } from "vitest";
import { CodexProvider, HostedProvider, ProviderError } from "../../src/server/language/providers.js";

// The owner's Codex API gateway: request shape, response parsing, error mapping and the status probe, with a fake fetch.
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const scope = { sessionId: "s1" };

describe("CodexProvider", () => {
  it("sends OpenAI-style chat completions with the deadline and parses the answer", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return json(200, { model: "gpt-6-luna", choices: [{ message: { role: "assistant", content: "{\"a\":1}" } }], usage: { prompt_tokens: 1200, completion_tokens: 40 } }); }) as typeof fetch;
    const p = new CodexProvider({ url: "http://127.0.0.1:4101/", key: "k1", fetchFn });
    expect(p.configured).toBe(true);
    const out = await p.complete({ task: "extract_goal", messages: [{ role: "user", content: "hi" }], maxTokens: 1024, scope, budgetSeconds: 50 });
    expect(out).toMatchObject({ content: "{\"a\":1}", model: "gpt-6-luna", usage: { input_tokens: 1200, output_tokens: 40 } });
    expect(calls[0]!.url).toBe("http://127.0.0.1:4101/v1/chat/completions");
    expect((calls[0]!.init.headers as any).Authorization).toBe("Bearer k1");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ stream: false, response_format: { type: "json_object" }, deadline_s: 50, timeout_s: 50, messages: [{ role: "user", content: "hi" }] });
    expect(body.model).toBeUndefined(); // the gateway's default model unless CODEX_MODEL is set
  });
  it("passes a pinned model and effort through", async () => {
    let body: any;
    const fetchFn = (async (_u: any, init: any) => { body = JSON.parse(String(init.body)); return json(200, { model: "gpt-6-sol", choices: [{ message: { content: "{}" } }] }); }) as typeof fetch;
    const out = await new CodexProvider({ url: "http://g", key: "k", model: "gpt-6-sol", effort: "low", fetchFn }).complete({ task: "extract_goal", messages: [], maxTokens: 1, scope, budgetSeconds: 10 });
    expect(body).toMatchObject({ model: "gpt-6-sol", effort: "low" });
    expect(out.model).toBe("gpt-6-sol");
  });
  it("turns gateway refusals and transport failures into provider errors", async () => {
    const refused = new CodexProvider({ url: "http://g", key: "k", fetchFn: (async () => json(503, { error: { type: "deadline_unreachable", message: "deadline cannot be met" } })) as typeof fetch });
    await expect(refused.complete({ task: "extract_goal", messages: [], maxTokens: 1, scope, budgetSeconds: 10 })).rejects.toMatchObject({ status: 503, code: "deadline_unreachable" });
    const busy = new CodexProvider({ url: "http://g", key: "k", fetchFn: (async () => json(429, { error: { type: "rate_limit_error", message: "hourly limit reached for this key" } })) as typeof fetch });
    await expect(busy.complete({ task: "extract_goal", messages: [], maxTokens: 1, scope, budgetSeconds: 10 })).rejects.toBeInstanceOf(ProviderError);
    const down = new CodexProvider({ url: "http://g", key: "k", fetchFn: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch });
    await expect(down.complete({ task: "extract_goal", messages: [], maxTokens: 1, scope, budgetSeconds: 10 })).rejects.toMatchObject({ status: null, code: "unreachable" });
    const empty = new CodexProvider({ url: "http://g", key: "k", fetchFn: (async () => json(200, { choices: [] })) as typeof fetch });
    await expect(empty.complete({ task: "extract_goal", messages: [], maxTokens: 1, scope, budgetSeconds: 10 })).rejects.toMatchObject({ code: "empty_response" });
  });
  it("probes /v1/status with the key and never throws", async () => {
    const ok = new CodexProvider({ url: "http://g", key: "k", fetchFn: (async (u: any, init: any) => { expect(String(u)).toBe("http://g/v1/status"); expect(init.headers.Authorization).toBe("Bearer k"); return json(200, { model: "gpt-6-luna", reasoning_effort: "medium", running: false }); }) as typeof fetch });
    expect(await ok.probe()).toEqual({ reachable: true, model: "gpt-6-luna" });
    const bad = new CodexProvider({ url: "http://g", key: "wrong", fetchFn: (async () => json(401, { error: { type: "authentication_error", message: "missing or invalid API key" } })) as typeof fetch });
    expect(await bad.probe()).toMatchObject({ reachable: false, detail: expect.stringContaining("401") });
    const dead = new CodexProvider({ url: "http://g", key: "k", fetchFn: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
    expect(await dead.probe()).toMatchObject({ reachable: false, detail: expect.stringContaining("ECONNREFUSED") });
    expect(await new CodexProvider({ url: "", key: "" }).probe()).toMatchObject({ reachable: false });
  });
});

describe("HostedProvider", () => {
  it("keeps the hosted protocol: echoed request id, ok flag, content and model", async () => {
    let sent: any;
    const fetchFn = (async (_u: any, init: any) => { sent = JSON.parse(String(init.body)); return json(200, { ok: true, requestId: sent.requestId, model: "claude-haiku-4-5", content: "{}", usage: { input_tokens: 10 } }); }) as typeof fetch;
    const out = await new HostedProvider("http://h/", "t", { fetchFn }).complete({ task: "explain_change", messages: [{ role: "user", content: "x" }], maxTokens: 768, scope: { sessionId: null }, budgetSeconds: 15 });
    expect(out).toMatchObject({ model: "claude-haiku-4-5", content: "{}" });
    expect(sent).toMatchObject({ protocol: 1, task: "explain_change", maxTokens: 768, scope: { session: "platform-api" } });
    const mismatch = new HostedProvider("http://h", "t", { fetchFn: (async () => json(200, { ok: true, requestId: "other", content: "{}" })) as typeof fetch });
    await expect(mismatch.complete({ task: "explain_change", messages: [], maxTokens: 1, scope: { sessionId: null }, budgetSeconds: 15 })).rejects.toMatchObject({ code: "request_id_mismatch" });
  });
});
