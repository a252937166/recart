import { writeFileSync } from "node:fs";
import { CATALOG, CATALOG_VERSION, RECIPES, RECIPES_VERSION, SCENARIOS } from "../src/domain/catalog/fixtures.js";
const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const fmt = (v: unknown) => (v === null ? "not documented" : Array.isArray(v) ? v.join(", ") : String(v));
const lines: string[] = [];
lines.push(`# Fixture specification sheet (${CATALOG_VERSION})`, "");
lines.push("Every product below is a team-authored, brand-free simulation for the ReCart demo. The facts are the fixture's declared properties; they are not claims about any physical product. Each fact in `src/domain/catalog/fixtures.ts` cites its row here as `spec-sheet-v1#SKU`. This page is generated from that file.", "");
lines.push("Evidence modes: **FIXTURE** means declared by this sheet; **UNKNOWN** means deliberately undocumented, so any check that depends on it cannot pass.", "");
lines.push("| SKU | Product | Role | Price | Declared facts |", "|---|---|---|---|---|");
for (const v of CATALOG.variants) {
  const facts = Object.entries(v.facts).map(([k, f]) => `${k}: ${fmt(f.value)}${f.evidence === "UNKNOWN" ? " (UNKNOWN)" : ""}`).join("; ");
  lines.push(`| <a id="${v.sku}"></a>${v.sku} | ${v.name} | ${v.role} | ${usd(v.priceCents)} | ${facts} |`);
}
lines.push("", `## Recipes (${RECIPES_VERSION})`, "");
for (const r of RECIPES) {
  lines.push(`### ${r.id}: ${r.title}`, "", r.summary, "", `Supported OS: ${r.supportedOS.join(", ")}.${r.remoteRouting ? ` Remote routing: ${r.remoteRouting.method} Declared call apps: ${r.remoteRouting.callApps.join(", ")}.` : ""}`, "");
  lines.push("| Role | Allowed products | Kind |", "|---|---|---|");
  for (const role of r.roles) lines.push(`| ${role.label} | ${role.allowed.join(", ")} | ${role.kind} |`);
  lines.push("", `Excluded: ${r.exclusions.join("; ")}.`, "");
}
lines.push("## Demo scenario stock", "", "| SKU | A | B | C |", "|---|---|---|---|");
for (const v of CATALOG.variants) lines.push(`| ${v.sku} | ${SCENARIOS.A.inventory[v.sku] ?? 0} | ${SCENARIOS.B.inventory[v.sku] ?? 0} | ${SCENARIOS.C.inventory[v.sku] ?? 0} |`);
lines.push("", "Tax is a fixture rule: 8% of the subtotal, rounded half up to the cent. Pickup is at a simulated store counter in two-hour slots starting at 10 am, 12 pm, 2 pm, 4 pm and 6 pm Pacific, with a two-hour lead time (pickup-policy-v1).", "");
writeFileSync("docs/fixtures/spec-sheet-v1.md", lines.join("\n"));
console.log("written", lines.length, "lines");
