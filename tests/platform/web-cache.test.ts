import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformSetup, type P } from "./helpers.js";

// Signal Room review, P2: index.html was cached for an hour, so returning visitors saw the previous release.
const web = path.resolve(process.cwd(), "dist/web");
const built = existsSync(path.join(web, "index.html"));

describe.skipIf(!built)("web app caching", () => {
  let p: P;
  beforeAll(async () => { p = await platformSetup(); });
  afterAll(async () => { await p.app.close(); await p.h.db.end(); });

  it("revalidates the HTML entry point, including app routes served by the fallback", async () => {
    for (const url of ["/", "/index.html", "/demo/start", "/developers"]) {
      const r = await p.app.inject({ method: "GET", url });
      expect(r.statusCode, url).toBe(200);
      expect(r.headers["content-type"], url).toMatch(/text\/html/);
      expect(r.headers["cache-control"], url).toBe("no-cache");
    }
  });

  it("keeps content-hashed assets for a year and other public files for an hour", async () => {
    const asset = readdirSync(path.join(web, "assets")).find((f) => f.endsWith(".js"))!;
    const a = await p.app.inject({ method: "GET", url: `/assets/${asset}` });
    expect(a.statusCode).toBe(200);
    expect(a.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    const brand = readdirSync(path.join(web, "brand")).find((f) => f.endsWith(".svg"))!;
    const b = await p.app.inject({ method: "GET", url: `/brand/${brand}` });
    expect(b.statusCode).toBe(200);
    expect(b.headers["cache-control"]).toBe("public, max-age=3600");
  });
});
