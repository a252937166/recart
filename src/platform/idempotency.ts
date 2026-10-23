import { clock } from "../server/clock.js";
import { maybeOne } from "../server/db/pool.js";
import { ApiError, canonicalJson, sha256, type Queryable } from "./core.js";

export interface IdemResult { status: number; body: unknown; replayed: boolean }

/**
 * Caller-scoped idempotency (keys live 24 hours). The same key with the same request replays the stored response;
 * the same key with a different request is rejected; a request still in progress returns a conflict.
 */
export async function withIdempotency(q: Queryable, merchantId: string, key: string | undefined, route: string, request: unknown, run: () => Promise<{ status: number; body: unknown }>): Promise<IdemResult> {
  if (!key) return { ...(await run()), replayed: false };
  if (key.length > 255 || !/^[\x21-\x7e]+$/.test(key)) throw new ApiError("invalid_request", "invalid_idempotency_key", "Idempotency-Key must be 1-255 printable ASCII characters.");
  const requestHash = sha256(route + "\n" + canonicalJson(request));
  const inserted = await q.query("insert into idempotency_records(merchant_id,idem_key,route,request_hash,created_at) values ($1,$2,$3,$4,$5) on conflict (merchant_id, idem_key) do nothing", [merchantId, key, route, requestHash, clock.now()]);
  if (!inserted.rowCount) {
    const prior = await maybeOne<{ route: string; request_hash: string; status_code: number | null; response: unknown }>(q, "select route, request_hash, status_code, response from idempotency_records where merchant_id=$1 and idem_key=$2", [merchantId, key]);
    if (!prior) throw new ApiError("conflict", "idempotency_in_progress", "Retry this request.");
    if (prior.route !== route || prior.request_hash !== requestHash) throw new ApiError("idempotency_error", "idempotency_key_reused", "This Idempotency-Key was already used with a different request.");
    if (prior.status_code === null) throw new ApiError("conflict", "idempotency_in_progress", "A request with this Idempotency-Key is still being processed.");
    return { status: prior.status_code, body: prior.response, replayed: true };
  }
  try {
    const r = await run();
    await q.query("update idempotency_records set status_code=$3, response=$4 where merchant_id=$1 and idem_key=$2", [merchantId, key, r.status, JSON.stringify(r.body)]);
    return { ...r, replayed: false };
  } catch (e) {
    await q.query("delete from idempotency_records where merchant_id=$1 and idem_key=$2", [merchantId, key]);
    throw e;
  }
}
