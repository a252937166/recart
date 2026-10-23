import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { prefixLines } from "../../src/server/logging.js";
import { shutdownPlan } from "../../src/server/shutdown.js";

// The service units must use only what the demo host's systemd (219) understands, log to the journal explicitly, and
// give the app's bounded shutdown room before systemd escalates. The authoritative check runs on the host itself
// (deploy/validate-service.sh: systemd-analyze verify, effective settings, and log lines reaching the journal).
const TARGET_SYSTEMD = 219;
const unit = (name: string) => {
  const text = readFileSync(new URL(`../../deploy/${name}`, import.meta.url), "utf8");
  const entries = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("[")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)] as const; });
  return { text, entries, get: (k: string) => entries.filter(([key]) => key === k).map(([, v]) => v) };
};
// Directives these units use, with the systemd version that introduced them (all well before 219 except as noted).
const SINCE: Record<string, number> = { Description: 1, After: 1, Wants: 1, Type: 1, User: 1, Group: 1, WorkingDirectory: 1, EnvironmentFile: 1, Environment: 1, ExecStart: 1, Restart: 1, RestartSec: 1, MemoryLimit: 1, NoNewPrivileges: 187, StandardOutput: 1, StandardError: 1, SyslogIdentifier: 1, KillSignal: 1, TimeoutStopSec: 1, WantedBy: 1 };
// Output targets and the version that added them: `fd:` 235, `file:` 236, `append:` 240, `truncate:` 248.
const OUTPUT_SINCE: [RegExp, number][] = [[/^(inherit|null|tty|journal|syslog|kmsg|journal\+console|syslog\+console|kmsg\+console|socket)$/, 1], [/^fd:/, 235], [/^file:/, 236], [/^append:/, 240], [/^truncate:/, 248]];

describe("service units for the demo host (systemd 219)", () => {
  for (const name of ["recart.service", "recart-shopify-sync.service"]) {
    it(`${name} uses only directives and output targets that systemd ${TARGET_SYSTEMD} supports`, () => {
      for (const [key, value] of unit(name).entries) {
        expect(SINCE[key], `${name}: ${key} is not on the checked list; check its systemd version and add it`).toBeDefined();
        expect(SINCE[key]!, `${name}: ${key}`).toBeLessThanOrEqual(TARGET_SYSTEMD);
        if (key === "StandardOutput" || key === "StandardError") {
          const since = OUTPUT_SINCE.find(([re]) => re.test(value))?.[1];
          expect(since, `${name}: ${key}=${value} is not a known output target`).toBeDefined();
          expect(since!, `${name}: ${key}=${value} needs systemd ${since}`).toBeLessThanOrEqual(TARGET_SYSTEMD);
        }
      }
    });
  }

  it("recart.service logs to the journal explicitly, under its own identifier, with priorities", () => {
    const u = unit("recart.service");
    expect(u.get("StandardOutput")).toEqual(["journal"]);
    expect(u.get("StandardError")).toEqual(["journal"]);
    expect(u.get("SyslogIdentifier")).toEqual(["recart"]);
    expect(u.get("Environment")).toContain("LOG_PRIORITY_PREFIX=true");
    expect(u.text).not.toMatch(/\/var\/log\/recart\.log/);
  });

  it("gives the app's bounded shutdown room before systemd's SIGKILL", () => {
    const u = unit("recart.service");
    const stop = Number(/^(\d+)s?$/.exec(u.get("TimeoutStopSec")[0] ?? "")?.[1]);
    const plan = shutdownPlan(loadConfig({}));
    expect(plan).toEqual({ drainMs: 15_000, graceMs: 10_000, languageGraceMs: 1000, dbMs: 5000, hardMs: 25_000 });
    expect(stop).toBeGreaterThanOrEqual(plan.hardMs / 1000 + 10);
    expect(u.get("KillSignal")).toEqual(["SIGTERM"]);
  });

  it("prefixes every line of an error so journald files the whole message at that priority", () => {
    expect(prefixLines("<3>", ["[worker] job %s failed:", "explain_case#7", new Error("boom")]).split("\n").every((l) => l.startsWith("<3>"))).toBe(true);
    expect(prefixLines("<4>", ["one line"])).toBe("<4>one line");
  });
});
