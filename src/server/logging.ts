import { format } from "node:util";
import { fingerprint } from "./build-info.js";

fingerprint(import.meta.url, "logging.js");

/**
 * When stdout and stderr go to the systemd journal (LOG_PRIORITY_PREFIX=true in the unit), each line written by
 * console.error carries the <3> (err) prefix and each console.warn line <4> (warning). journald (SyslogLevelPrefix=yes,
 * the default) turns the prefix into the entry's priority and strips it, so `journalctl -u recart -p err` lists the
 * application's errors. Multi-line messages, such as stack traces, are prefixed line by line.
 */
export function prefixLines(prefix: string, args: unknown[]): string {
  return format(...args).split("\n").map((l) => prefix + l).join("\n");
}
export function installJournalPriorities() {
  const error = console.error.bind(console), warn = console.warn.bind(console);
  console.error = (...args: unknown[]) => error(prefixLines("<3>", args));
  console.warn = (...args: unknown[]) => warn(prefixLines("<4>", args));
}

/** SIGUSR2: write one marked line to stdout and one to stderr, so a deployment check can see both reach the log destination. */
export function installLogCheck() {
  process.on("SIGUSR2", () => {
    const id = `${new Date().toISOString()} pid ${process.pid}`;
    console.log(`[recart] log check: stdout line ${id}`);
    console.error(`[recart] log check: stderr line ${id}`);
  });
}
