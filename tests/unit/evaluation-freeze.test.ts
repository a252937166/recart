import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dropUnsupportedSpans } from "../../src/server/language/spans.js";

// Release 17 changed prompts.ts and dates.ts, which the v4 and holdout freeze records hash, without archiving the
// frozen copies, so evaluation/history/README.md pointed at files that no longer matched. These checks keep the
// published evaluation reproducible and its scores tied to the current post-processing.
const root = new URL("../../", import.meta.url).pathname;
const history = path.join(root, "evaluation/history");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));

describe("frozen evaluation inputs", () => {
  it("keeps every file a freeze record hashed, at its original path or in evaluation/history", () => {
    const freezes = readdirSync(path.join(root, "evaluation")).filter((f) => /^FREEZE-.+\.json$/.test(f));
    const missing: string[] = [];
    for (const f of freezes) {
      for (const [file, hash] of Object.entries(json(`evaluation/${f}`).sha256 as Record<string, string>)) {
        const candidates = [path.join(root, file), ...readdirSync(history).map((v) => path.join(history, v, path.basename(file)))];
        if (!candidates.some((c) => existsSync(c) && sha256(c) === hash)) missing.push(`${f}: ${file}`);
      }
    }
    expect(freezes.length).toBeGreaterThanOrEqual(5);
    expect(missing).toEqual([]);
  });

  it("drops no value from the stored v4 and holdout drafts under the current quote-support check", () => {
    const dropped: string[] = [];
    let drafts = 0;
    const runs: [string, string][] = [["v4", "evaluation/cases-v1.json"], ["holdout-v1", "evaluation/holdout-v1.json"]];
    for (const [run, casesFile] of runs) {
      const text = new Map<string, string>(json(casesFile).cases.map((c: { id: string; text: string }) => [c.id, c.text]));
      for (const row of json(`evidence/benchmark/${run}/results.json`).extraction) {
        if (!row.draft) continue;
        drafts++;
        const after = dropUnsupportedSpans(row.draft, text.get(row.id)!) as unknown as Record<string, unknown>;
        for (const [field, before] of Object.entries(row.draft)) {
          if (before && typeof before === "object" && "span" in before && after[field] === null) dropped.push(`${run} ${row.id}.${field}`);
        }
      }
    }
    expect(drafts).toBe(28);
    expect(dropped).toEqual([]);
  });
});
