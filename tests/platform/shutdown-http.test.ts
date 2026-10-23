import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { LanguageAdapter } from "../../src/server/language/adapter.js";
import { drainHttp, FORCE_CLOSE_WAIT_MS } from "../../src/server/shutdown.js";
import { platformSetup, type P } from "./helpers.js";

// Closing the HTTP server must not wait on an open event stream, and must be bounded even for a request that hangs.
let p: P | null = null;
afterEach(async () => { await p?.h.db.end(); p = null; });

async function start() {
  p = await platformSetup();
  await p.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (p.app.server.address() as any).port as number;
  const s = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scenario: "A" }) });
  const cookie = (s.headers.get("set-cookie") ?? "").split(";")[0]!;
  const csrf = ((await s.json()) as { csrf: string }).csrf;
  return { port, cookie, csrf };
}
/** An event-stream client that records what arrives and when the stream ends. */
function openStream(port: number, cookie: string) {
  const got = { text: "", ended: false };
  const opened = new Promise<void>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/events", headers: { cookie, accept: "text/event-stream" } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (d) => { got.text += d; if (got.text.includes("event: hello")) resolve(); });
      res.on("end", () => { got.ended = true; });
      res.on("close", () => { got.ended = true; });
    });
    req.on("error", reject);
  });
  return { got, opened };
}
const until = async (cond: () => boolean, what: string, ms = 5000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 10)); } };

describe("bounded HTTP shutdown", () => {
  it("ends an open event stream at once, removing its listener and timer, so the close completes promptly", async () => {
    const { port, cookie } = await start();
    const listenersBefore = p!.h.ctx.events.listenerCount("changed");
    const timersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const stream = openStream(port, cookie);
    await stream.opened;
    expect(p!.app.openEventStreams()).toBe(1);
    expect(p!.h.ctx.events.listenerCount("changed")).toBe(listenersBefore + 1);
    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBeGreaterThan(timersBefore);
    const t0 = Date.now();
    expect(await drainHttp(p!.app, 5000)).toEqual({ drained: true, forced: false });
    expect(Date.now() - t0).toBeLessThan(1000);
    await until(() => stream.got.ended, "the stream to end");
    expect(stream.got.text).toMatch(/retry: 3000/);
    expect(stream.got.text).toMatch(/event: shutdown/);
    expect(p!.app.openEventStreams()).toBe(0);
    expect(p!.h.ctx.events.listenerCount("changed")).toBe(listenersBefore);
    expect(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length).toBeLessThanOrEqual(timersBefore);
  });

  it("closes the connection of a request still running after the drain bound, so the close cannot hang", async () => {
    const { port, cookie, csrf } = await start();
    // A draft whose model never answers.
    const original = p!.h.ctx.language;
    let entered = false;
    p!.h.ctx.language = { ...original, extractGoal: () => { entered = true; return new Promise(() => {}); } } as LanguageAdapter;
    const hung = fetch(`http://127.0.0.1:${port}/api/goal/extract`, { method: "POST", headers: { "content-type": "application/json", cookie, "x-recart-csrf": csrf }, body: JSON.stringify({ text: "two of us and one remote guest on Zoom, USB-C laptop, $450." }) }).then((r) => `HTTP ${r.status}`, (e) => `connection closed: ${e?.cause?.code ?? e?.message}`);
    const stream = openStream(port, cookie);
    await stream.opened;
    await until(() => entered, "the draft to reach the model");
    const t0 = Date.now();
    expect(await drainHttp(p!.app, 300)).toEqual({ drained: false, forced: true });
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(300 + FORCE_CLOSE_WAIT_MS + 500);
    expect(await hung).toMatch(/^connection closed/);
    await until(() => stream.got.ended, "the stream to end");
    expect(p!.app.openEventStreams()).toBe(0);
  });
});
