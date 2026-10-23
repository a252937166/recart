/** The trial key shown on the developers page: what each copy button copies, and how long the key has left. */
export const maskKey = (key: string) => (key.length <= 16 ? key : `${key.slice(0, 12)}…${key.slice(-4)}`);
export const mcpUrl = (origin: string) => `${origin}/mcp`;
export const authorizationHeader = (key: string) => `Authorization: Bearer ${key}`;

/** A tools/list call that works as pasted: the key is filled in. */
export const curlExample = (origin: string, key: string) =>
  `curl ${mcpUrl(origin)} \\\n  -H '${authorizationHeader(key)}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;

/** "in 71 h 58 min", "in 5 min", or "expired 2 h ago"; unknown when there is no usable timestamp. */
export function expiryOf(expiresAt: string | null | undefined, now: number): { expired: boolean; label: string } {
  const ms = expiresAt ? Date.parse(expiresAt) - now : NaN;
  if (!Number.isFinite(ms)) return { expired: false, label: "expiry unknown" };
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600_000);
  const m = Math.floor((abs % 3600_000) / 60_000);
  const span = h >= 1 ? `${h} h${m ? ` ${m} min` : ""}` : `${Math.max(1, m)} min`;
  return ms <= 0 ? { expired: true, label: `expired ${span} ago` } : { expired: false, label: `in ${span}` };
}
