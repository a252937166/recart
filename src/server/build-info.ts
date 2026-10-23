import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * What this process actually loaded. Each fingerprinted module hashes its own file when it is evaluated (once, at
 * startup), so /api/health shows which compiled code the running process holds, independent of what is on disk now.
 */
const loaded: Record<string, string> = {};
export const processStartedAt = new Date().toISOString();

export function fingerprint(moduleUrl: string, name: string) {
  try { loaded[name] = createHash("sha256").update(readFileSync(fileURLToPath(moduleUrl))).digest("hex"); }
  catch (e: any) { loaded[name] = `unreadable: ${String(e?.message ?? e).slice(0, 80)}`; }
}

export const loadedModules = (): Record<string, string> => ({ ...loaded });
