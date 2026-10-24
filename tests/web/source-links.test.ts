import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sourceUrl } from "../../src/web/lib/source.js";

// The developers page links its examples into the public repository. The links once carried an extra /recart/ folder
// (the repository root is this project's root) and all six returned 404.
describe("links into the public repository", () => {
  it("starts paths at the repository root", () => {
    expect(sourceUrl("https://github.com/a252937166/recart", "examples/quickstart")).toBe("https://github.com/a252937166/recart/tree/main/examples/quickstart");
    expect(sourceUrl("https://github.com/a252937166/recart/", "examples/mcp-client/client.mjs")).toBe("https://github.com/a252937166/recart/tree/main/examples/mcp-client/client.mjs");
  });

  it("links the developers page only to paths that exist", () => {
    const page = readFileSync(new URL("../../src/web/pages/Developers.tsx", import.meta.url), "utf8");
    const paths = [...page.matchAll(/\bex\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(paths.length).toBeGreaterThanOrEqual(6);
    for (const p of paths) expect(existsSync(new URL(`../../${p}`, import.meta.url)), p).toBe(true);
  });
});
