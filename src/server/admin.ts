import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { createPool, many, withTx } from "./db/pool.js";
import { migrate } from "./db/migrations.js";
import { createMerchant, issueApiKey } from "../platform/merchants.js";
import { SCOPES, type Scope } from "../platform/schemas.js";
import { clearFault, languageFaultSchema, listFaults, setFault } from "./language/faults.js";

/**
 * Operator CLI (run on the server with the service environment):
 *   node dist/server/server/admin.js create-operator --name "Store" [--tax-rate-bps 800] [--max-age-seconds 7200] [--scopes a,b]
 *   node dist/server/server/admin.js issue-key --merchant mch_... --label "..." --scopes a,b
 *   node dist/server/server/admin.js list-merchants
 *   node dist/server/server/admin.js language-fault --scope session:<id>|merchant:<id> --fault '{"primary":{"delay_ms":70000}}' [--ttl-seconds 900]
 *   node dist/server/server/admin.js language-fault --scope ... --clear | language-fault --list
 *   (--fault-b64 <base64 of the JSON> is the same as --fault, for callers that go through several shells)
 * Keys are printed once and stored only as SHA-256. A language fault shapes that one session's or merchant's model
 * calls (a delay, an unreachable primary, a refusal) and nothing else: no other caller, no shared cooldown.
 */
const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  name: { type: "string" }, merchant: { type: "string" }, label: { type: "string", default: "operator" }, scopes: { type: "string" },
  "tax-rate-bps": { type: "string", default: "0" }, "max-age-seconds": { type: "string", default: "86400" }, "proposal-ttl-seconds": { type: "string", default: "86400" },
  scope: { type: "string" }, fault: { type: "string" }, "fault-b64": { type: "string" }, "ttl-seconds": { type: "string", default: "900" }, clear: { type: "boolean", default: false }, list: { type: "boolean", default: false },
} });
const cfg = loadConfig();
const db = createPool(cfg.DATABASE_URL, 2);
const scopes = (values.scopes ? values.scopes.split(",").map((s) => s.trim()) : [...SCOPES]) as Scope[];
for (const s of scopes) if (!SCOPES.includes(s)) throw new Error(`unknown scope ${s}`);
try {
  await migrate(db);
  if (positionals[0] === "create-operator") {
    if (!values.name) throw new Error("--name is required");
    const out = await withTx(db, async (tx) => {
      const m = await createMerchant(tx, { name: values.name!, kind: "operator", taxRateBps: Number(values["tax-rate-bps"]), inventoryMaxAgeSeconds: Number(values["max-age-seconds"]), proposalTtlSeconds: Number(values["proposal-ttl-seconds"]) });
      const k = await issueApiKey(tx, m, values.label, scopes);
      return { merchant_id: m.id, api_key: k.key, scopes: k.scopes };
    });
    console.log(JSON.stringify(out, null, 2));
  } else if (positionals[0] === "issue-key") {
    if (!values.merchant) throw new Error("--merchant is required");
    const k = await issueApiKey(db, { id: values.merchant, kind: "operator" }, values.label, scopes);
    console.log(JSON.stringify({ merchant_id: values.merchant, api_key: k.key, scopes: k.scopes }, null, 2));
  } else if (positionals[0] === "list-merchants") {
    console.log(JSON.stringify(await many(db, "select id, name, kind, created_at, expires_at from merchants where kind='operator' order by created_at"), null, 2));
  } else if (positionals[0] === "language-fault") {
    if (values.list) console.log(JSON.stringify(await listFaults(db), null, 2));
    else if (!values.scope) throw new Error("--scope session:<id> or merchant:<id> is required");
    else if (values.clear) { await clearFault(db, values.scope); console.log(JSON.stringify({ scope: values.scope, cleared: true })); }
    else {
      const raw = values.fault ?? (values["fault-b64"] ? Buffer.from(values["fault-b64"], "base64").toString("utf8") : null);
      if (!raw) throw new Error("--fault '<json>' or --fault-b64 is required (or --clear)");
      const fault = languageFaultSchema.parse(JSON.parse(raw));
      const expiresAt = new Date(Date.now() + Number(values["ttl-seconds"]) * 1000);
      await setFault(db, values.scope, fault, expiresAt);
      console.log(JSON.stringify({ scope: values.scope, fault, expires_at: expiresAt.toISOString() }));
    }
  } else {
    console.log("usage: admin.js create-operator|issue-key|list-merchants|language-fault [options]");
  }
} finally {
  await db.end();
}
