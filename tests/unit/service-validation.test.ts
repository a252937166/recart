import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { shutdownPlan } from "../../src/server/shutdown.js";

// Run the real installed validator with systemd 219's property format and a temporary compiled app. The app modules
// come from the current sources; its shutdownPlan supplies the bound, not a second formula in this test or the shell.
const root = fileURLToPath(new URL("../../", import.meta.url));
let tmp: string, app: string, bin: string;
beforeAll(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "recart-service-validation-"));
  app = path.join(tmp, "app"); bin = path.join(tmp, "bin");
  const compiled = path.join(app, "dist/server/server");
  mkdirSync(compiled, { recursive: true }); mkdirSync(bin);
  writeFileSync(path.join(app, "package.json"), '{"type":"module"}');
  symlinkSync(path.join(root, "node_modules"), path.join(app, "node_modules"), "dir");
  for (const name of ["config", "shutdown", "build-info"]) {
    const source = readFileSync(path.join(root, `src/server/${name}.ts`), "utf8");
    writeFileSync(path.join(compiled, `${name}.js`), transformSync(source, { loader: "ts", format: "esm", target: "node22" }).code);
  }
  writeFileSync(path.join(bin, "systemctl"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('systemd 219'); process.exit(0); }
if (args[0] !== 'show') process.exit(1);
const key = args[args.indexOf('-p') + 1];
const values = {
  StandardOutput: 'journal', StandardError: 'journal', SyslogIdentifier: 'recart', KillSignal: '15',
  Environment: process.env.VALIDATOR_TEST_UNIT_ENV,
  EnvironmentFiles: process.env.VALIDATOR_TEST_ENV_FILES,
  FragmentPath: '/etc/systemd/system/recart.service', DropInPaths: '',
  WorkingDirectory: process.env.VALIDATOR_TEST_APP,
  ExecStart: '{ path=' + process.execPath + ' ; argv[]=' + process.execPath + ' dist/server/server/main.js ; }',
  TimeoutStopUSec: process.env.VALIDATOR_TEST_STOP,
};
if (!(key in values)) process.exit(1);
// On the production systemd 219 host, asking for EnvironmentFiles yields the singular property name.
const shownKey = key === 'EnvironmentFiles' ? (process.env.VALIDATOR_TEST_ENV_FILES_PROPERTY || 'EnvironmentFile') : key;
console.log(shownKey + '=' + values[key]);
`, { mode: 0o755 });
  for (const command of ["journalctl", "systemd-analyze"]) writeFileSync(path.join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});
afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

function installed(a: { files?: string[]; unitEnv?: string; stop?: string; missingFile?: boolean; app?: string; envFilesProperty?: string } = {}) {
  const files = (a.files ?? [""]).map((contents, i) => {
    const file = path.join(tmp, `recart-${i}.env`);
    writeFileSync(file, contents);
    return `${file} (ignore_errors=no)`;
  });
  if (a.missingFile) files.push(`${path.join(tmp, "missing.env")} (ignore_errors=no)`);
  const result = spawnSync("bash", [path.join(root, "deploy/validate-service.sh"), "installed", "2026-10-11 00:00:00"], {
    encoding: "utf8", timeout: 10_000,
    env: { ...process.env, PATH: `${bin}:${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      VALIDATOR_TEST_APP: a.app ?? app, VALIDATOR_TEST_STOP: a.stop ?? "45s",
      VALIDATOR_TEST_UNIT_ENV: a.unitEnv ?? "LOG_PRIORITY_PREFIX=true", VALIDATOR_TEST_ENV_FILES: files.join(" "),
      VALIDATOR_TEST_ENV_FILES_PROPERTY: a.envFilesProperty ?? "EnvironmentFile" },
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("installed service shutdown validation", () => {
  it("accepts the default 25 second shutdown bound under the service's 45 second timeout", () => {
    const bound = shutdownPlan(loadConfig({})).hardMs / 1000;
    const r = installed();
    expect(bound).toBe(25); expect(r.status, r.output).toBe(0);
    expect(r.output).toContain(`app's ${bound} s shutdown bound`);
  });

  it("also accepts the modern plural EnvironmentFiles property name", () => {
    const r = installed({ files: ["SHUTDOWN_LANGUAGE_GRACE_SECONDS=60\n"], stop: "83s", envFilesProperty: "EnvironmentFiles" });
    expect(r.status, r.output).toBe(0); expect(r.output).toContain("app's 73 s shutdown bound");
  });

  it("fails closed on an unexpected environment-file property prefix", () => {
    const r = installed({ files: ["SHUTDOWN_LANGUAGE_GRACE_SECONDS=60\n"], stop: "83s", envFilesProperty: "UnrelatedEnvironmentFile" });
    expect(r.status, r.output).toBe(1); expect(r.output).toContain("could not validate the app's shutdown bound");
  });

  it("rejects a 60 second language grace with the default stop timeout using the actual 73 second bound", () => {
    const cfg = loadConfig({ SHUTDOWN_LANGUAGE_GRACE_SECONDS: "60" });
    const r = installed({ files: ["SHUTDOWN_LANGUAGE_GRACE_SECONDS=60\n"] });
    expect(shutdownPlan(cfg).hardMs).toBe(73_000); expect(r.status, r.output).toBe(1);
    expect(r.output).toContain("45s is too short for the app's 73 s shutdown bound");
  });

  it("accepts the exact 10 second stop margin and rejects one millisecond less", () => {
    const files = ["SHUTDOWN_LANGUAGE_GRACE_SECONDS=60\n"];
    expect(installed({ files, stop: "1min 23s" }).status).toBe(0);
    const tooShort = installed({ files, stop: "1min 22s 999ms" });
    expect(tooShort.status, tooShort.output).toBe(1);
  });

  for (const quote of ['"', "'"]) {
    it(`reads ${quote}-quoted shutdown settings without evaluating the file`, () => {
      const r = installed({ files: [`SHUTDOWN_LANGUAGE_GRACE_SECONDS=${quote}60${quote}\nPAYPAL_CLIENT_SECRET=DO_NOT_PRINT_OR_EXECUTE_$(false)\n`], stop: "83s" });
      expect(r.status, r.output).toBe(0); expect(r.output).toContain("app's 73 s shutdown bound");
      expect(r.output).not.toContain("DO_NOT_PRINT_OR_EXECUTE");
    });
  }

  it("honours unit settings and EnvironmentFile overrides in their effective order", () => {
    const unitEnv = 'LOG_PRIORITY_PREFIX=true "SHUTDOWN_LANGUAGE_GRACE_SECONDS=60"';
    expect(installed({ unitEnv }).status).toBe(1);
    const r = installed({ unitEnv, files: ["SHUTDOWN_LANGUAGE_GRACE_SECONDS=60\n", "SHUTDOWN_LANGUAGE_GRACE_SECONDS='1'\n"] });
    expect(r.status, r.output).toBe(0); expect(r.output).toContain("app's 25 s shutdown bound");
  });

  it("uses the actual plan's minimum values and millisecond rounding", () => {
    const settings = { SHUTDOWN_DRAIN_SECONDS: "0.1", SHUTDOWN_JOB_GRACE_SECONDS: "0.1004", SHUTDOWN_LANGUAGE_GRACE_SECONDS: "0" };
    const bound = shutdownPlan(loadConfig(settings)).hardMs / 1000;
    const files = [Object.entries(settings).map(([key, value]) => `${key}=${value}`).join("\n")];
    expect(bound).toBe(13.1);
    const exact = installed({ files, stop: "23s 100ms" });
    expect(exact.status, exact.output).toBe(0); expect(exact.output).toContain(`app's ${bound} s shutdown bound`);
    expect(installed({ files, stop: "23s 99ms" }).status).toBe(1);
  });

  for (const [key, value] of [["SHUTDOWN_LANGUAGE_GRACE_SECONDS", "61"], ["SHUTDOWN_LANGUAGE_GRACE_SECONDS", "-1"], ["SHUTDOWN_JOB_GRACE_SECONDS", "0"], ["SHUTDOWN_DRAIN_SECONDS", '"bad-secret-value"']] as const) {
    it(`fails closed on invalid ${key}=${value}`, () => {
      const r = installed({ files: [`${key}=${value}\nPAYPAL_CLIENT_SECRET=never-leak-this\n`], stop: "120s" });
      expect(r.status, r.output).toBe(1); expect(r.output).toContain("could not validate the app's shutdown bound");
      expect(r.output).not.toContain("bad-secret-value"); expect(r.output).not.toContain("never-leak-this");
    });
  }

  it("fails closed when a required EnvironmentFile or compiled app is missing", () => {
    for (const options of [{ missingFile: true }, { app: path.join(tmp, "missing-app") }]) {
      const r = installed(options);
      expect(r.status, r.output).toBe(1); expect(r.output).toContain("could not validate the app's shutdown bound");
    }
  });

  it("never prints unrelated unit environment values when a service check fails", () => {
    const r = installed({ unitEnv: 'PAYPAL_CLIENT_SECRET="never-leak-this secret"' });
    expect(r.status, r.output).toBe(1); expect(r.output).toContain("Environment lacks LOG_PRIORITY_PREFIX=true");
    expect(r.output).not.toContain("never-leak-this");
  });
});
