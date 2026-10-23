import { clock } from "../server/clock.js";
import { many, maybeOne, one } from "../server/db/pool.js";
import { ApiError, iso, newId, newSecret, sha256, type Queryable } from "./core.js";
import { SCOPES, type Scope } from "./schemas.js";

export interface MerchantRow {
  id: string; name: string; kind: "sandbox" | "operator"; domain: string; currency: string; tax_rate_bps: number;
  inventory_max_age_seconds: number; proposal_ttl_seconds: number; webhook_url: string | null; webhook_secret: string | null;
  catalog_version: number; integration: IntegrationInfo | null; integration_reported_at: Date | null;
  created_at: Date; expires_at: Date | null; disabled_at: Date | null;
}
export interface IntegrationInfo { name: string; platform: string; version: string; source?: string | undefined; capabilities: string[]; not_supported: string[] }
export interface Principal { merchant: MerchantRow; keyId: string; scopes: Scope[] }

export async function createMerchant(q: Queryable, a: { name: string; kind: MerchantRow["kind"]; currency?: string; taxRateBps?: number; expiresAt?: Date | null; inventoryMaxAgeSeconds?: number; proposalTtlSeconds?: number }): Promise<MerchantRow> {
  return one<MerchantRow>(q, `insert into merchants(id,name,kind,currency,tax_rate_bps,expires_at,inventory_max_age_seconds,proposal_ttl_seconds,created_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [newId("mch"), a.name, a.kind, a.currency ?? "USD", a.taxRateBps ?? 0, a.expiresAt ?? null, a.inventoryMaxAgeSeconds ?? 86400, a.proposalTtlSeconds ?? 86400, clock.now()]);
}

/** Issue an API key. The plaintext is returned once; only its SHA-256 is stored. */
export async function issueApiKey(q: Queryable, merchant: Pick<MerchantRow, "id" | "kind">, label = "default", scopes: readonly Scope[] = SCOPES): Promise<{ id: string; key: string; prefix: string; scopes: Scope[] }> {
  const key = newSecret(merchant.kind === "sandbox" ? "rk_test" : "rk_live");
  const id = newId("key");
  const prefix = key.slice(0, 12);
  const granted = SCOPES.filter((s) => scopes.includes(s));
  await q.query("insert into api_keys(id,merchant_id,prefix,key_hash,scopes,label,created_at) values ($1,$2,$3,$4,$5,$6,$7)", [id, merchant.id, prefix, sha256(key), granted, label, clock.now()]);
  return { id, key, prefix, scopes: granted };
}

/** Resolve a bearer key to its merchant, refusing revoked keys and disabled or expired merchants. */
export async function authenticateKey(q: Queryable, raw: string | undefined): Promise<Principal> {
  if (!raw || !/^rk_(test|live)_[A-Za-z0-9_-]{20,64}$/.test(raw)) throw new ApiError("authentication_required", "invalid_api_key", "Send a valid API key as `Authorization: Bearer rk_...`.");
  const row = await maybeOne<MerchantRow & { key_id: string; key_scopes: Scope[]; revoked_at: Date | null; last_used_at: Date | null }>(q,
    "select m.*, k.id key_id, k.scopes key_scopes, k.revoked_at, k.last_used_at from api_keys k join merchants m on m.id=k.merchant_id where k.key_hash=$1", [sha256(raw)]);
  if (!row || row.revoked_at) throw new ApiError("authentication_required", "invalid_api_key", "This API key is not valid or was revoked.");
  if (row.disabled_at || (row.expires_at && row.expires_at.getTime() <= clock.now().getTime())) throw new ApiError("permission_denied", "merchant_inactive", "This merchant account is expired or disabled. Create a new sandbox merchant.");
  if (!row.last_used_at || clock.now().getTime() - row.last_used_at.getTime() > 60_000) await q.query("update api_keys set last_used_at=$2 where id=$1", [row.key_id, clock.now()]);
  const { key_id, key_scopes, revoked_at: _r, last_used_at: _l, ...merchant } = row;
  return { merchant, keyId: key_id, scopes: key_scopes };
}

export function requireScope(p: Principal, scope: Scope): void {
  if (!p.scopes.includes(scope)) throw new ApiError("permission_denied", "missing_scope", `This API key lacks the ${scope} scope.`, { required: scope, granted: p.scopes });
}

export async function getMerchant(q: Queryable, id: string): Promise<MerchantRow | null> {
  return maybeOne<MerchantRow>(q, "select * from merchants where id=$1", [id]);
}

export async function listApiKeys(q: Queryable, merchantId: string) {
  const rows = await many<any>(q, "select id, prefix, label, scopes, created_at, last_used_at, revoked_at from api_keys where merchant_id=$1 order by created_at", [merchantId]);
  return rows.map((k) => ({ id: k.id, prefix: k.prefix, label: k.label, scopes: k.scopes, created_at: iso(k.created_at), last_used_at: iso(k.last_used_at), revoked_at: iso(k.revoked_at) }));
}

/** Revoke a key. A key cannot revoke itself, so an integration cannot lock its merchant out by mistake. */
export async function revokeApiKey(q: Queryable, p: Principal, keyId: string) {
  if (keyId === p.keyId) throw new ApiError("conflict", "cannot_revoke_current_key", "Use a different key to revoke this one.");
  const r = await q.query("update api_keys set revoked_at=coalesce(revoked_at,$3) where id=$1 and merchant_id=$2", [keyId, p.merchant.id, clock.now()]);
  if (!r.rowCount) throw new ApiError("not_found", "api_key_not_found", "No such API key for this merchant.");
}

/** Set the callback URL. A secret is generated on first use or rotation and returned only then. */
export async function setWebhookEndpoint(q: Queryable, merchant: MerchantRow, url: string | null, rotate = false): Promise<{ url: string | null; secret: string | null }> {
  if (url === null) {
    await q.query("update merchants set webhook_url=null where id=$1", [merchant.id]);
    return { url: null, secret: null };
  }
  const secret = !merchant.webhook_secret || rotate ? newSecret("whsec") : null;
  await q.query("update merchants set webhook_url=$2, webhook_secret=coalesce($3, webhook_secret) where id=$1", [merchant.id, url, secret]);
  return { url, secret };
}

export async function reportIntegration(q: Queryable, merchantId: string, info: IntegrationInfo) {
  await q.query("update merchants set integration=$2, integration_reported_at=$3 where id=$1", [merchantId, JSON.stringify(info), clock.now()]);
}

export function merchantView(m: MerchantRow) {
  return {
    id: m.id, name: m.name, kind: m.kind, domain: m.domain, currency: m.currency, tax_rate_bps: m.tax_rate_bps,
    inventory_max_age_seconds: m.inventory_max_age_seconds, proposal_ttl_seconds: m.proposal_ttl_seconds,
    webhook_url: m.webhook_url, catalog_version: m.catalog_version, integration: m.integration, integration_reported_at: iso(m.integration_reported_at),
    created_at: m.created_at.toISOString(), expires_at: iso(m.expires_at),
  };
}
