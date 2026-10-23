import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { LanguageAdapter } from "../server/language/adapter.js";
import type { Config } from "../server/config.js";

export type Queryable = Pool | PoolClient;
export interface PlatformCtx { db: Pool; cfg: Config; language: LanguageAdapter }

export type ErrorType =
  | "invalid_request" | "authentication_required" | "permission_denied" | "not_found" | "conflict"
  | "idempotency_error" | "rate_limited" | "gone" | "dependency_unavailable" | "internal_error";

const STATUS: Record<ErrorType, number> = {
  invalid_request: 422, authentication_required: 401, permission_denied: 403, not_found: 404, conflict: 409,
  idempotency_error: 422, rate_limited: 429, gone: 410, dependency_unavailable: 503, internal_error: 500,
};

/** A typed public API error. Business outcomes (no solution, budget conflict) are never errors. */
export class ApiError extends Error {
  readonly status: number;
  constructor(readonly type: ErrorType, readonly code: string, message: string, readonly details?: unknown, status?: number) {
    super(message);
    this.status = status ?? STATUS[type];
  }
}

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
/** Prefixed random identifier, e.g. rec_k3f9..., 20 random base-36 characters (about 103 bits). */
export function newId(prefix: string): string {
  const bytes = randomBytes(20);
  let s = "";
  for (const b of bytes) s += ALPHABET[b % 36];
  return `${prefix}_${s}`;
}
/** Bearer-style secret (API keys, review tokens, webhook secrets). Shown once; only a hash is stored where possible. */
export const newSecret = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v as object).filter((k) => (v as any)[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson((v as any)[k])).join(",") + "}";
  return JSON.stringify(v);
}

/** Signature header for a callback body: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`. */
export function signCallback(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Verify a callback signature; rejects timestamps older than the tolerance to stop replays. */
export function verifyCallback(secret: string, body: string, header: string | undefined, nowSeconds: number, toleranceSeconds = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(nowSeconds - t) > toleranceSeconds || !parts.v1) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(parts.v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
