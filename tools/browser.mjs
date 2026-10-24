// Browser launcher for the evidence tools: a fresh temporary profile each run, never the user's own browser profile.
// Playwright is this project's playwright-core devDependency (npm ci installs it; it downloads no browser). The browser is
// the installed Google Chrome, through Playwright's "chrome" channel.
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs   use another copy of Playwright
//   PLAYWRIGHT_CHANNEL=msedge                            use another installed browser channel
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export async function chromium() {
  try {
    return (await import(process.env.PLAYWRIGHT_CORE ?? "playwright-core")).chromium;
  } catch (e) {
    throw new Error(`Playwright could not be loaded (${e?.message ?? e}). Run npm ci in the project root, or set PLAYWRIGHT_CORE to a playwright-core index.mjs.`);
  }
}

/** A persistent context in a new temporary profile directory named <prefix>-<uuid>. */
export async function launchTemporaryProfile(prefix, options = {}) {
  const browser = await chromium();
  return browser.launchPersistentContext(path.join(os.tmpdir(), `${prefix}-${randomUUID()}`), { channel: process.env.PLAYWRIGHT_CHANNEL || "chrome", ...options });
}
