#!/usr/bin/env bash
# Validate the ReCart service against this host's systemd and prove where its logs go. Run as root on the host:
#   validate-service.sh verify <unit-file>   before installing: systemd-analyze verify reports nothing about this file
#   validate-service.sh installed <since>    after install and daemon-reload (<since>: local time just before the reload):
#                                            effective settings, no parse warnings logged since, stop timeout vs the
#                                            app's shutdown bound
#   validate-service.sh running              after the restart: the current process's startup line is in the journal;
#                                            a SIGUSR2 log check puts a stdout line at info and a stderr line at err
#                                            into the journal and into rsyslog's /var/log/messages
# Prints PASS/FAIL lines and exits 1 if anything failed.
set -u
UNIT=recart
fails=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }
finish() {
  echo "systemd $(systemctl --version | head -1 | awk '{print $2}') on $(hostname): $([ "$fails" -eq 0 ] && echo "all checks passed" || echo "$fails check(s) failed")"
  [ "$fails" -eq 0 ]
  exit $?
}

case "${1:-}" in
verify)
  f="${2:?usage: verify <unit-file>}"
  out=$(systemd-analyze verify "$f" 2>&1)
  mine=$(printf '%s\n' "$out" | grep -F "$f" || true)
  if [ -z "$mine" ]; then pass "systemd-analyze verify reports nothing about $f"; else fail "systemd-analyze verify: $mine"; fi
  others=$(printf '%s\n' "$out" | grep -vF "$f" | grep -c . || true)
  [ "$others" -gt 0 ] && echo "note: $others warning line(s) about other units on this host (not checked)"
  if grep -E '^Standard(Output|Error)=(append|file|truncate|fd):' "$f" >/dev/null; then fail "unit uses an output target this systemd may not support"; else pass "no file-style output targets in the unit"; fi
  ;;
installed)
  since="${2:?usage: installed <since>}"
  show() { systemctl show "$UNIT" -p "$1" | cut -d= -f2-; }
  [ "$(show StandardOutput)" = journal ] && pass "StandardOutput=journal" || fail "StandardOutput=$(show StandardOutput)"
  [ "$(show StandardError)" = journal ] && pass "StandardError=journal" || fail "StandardError=$(show StandardError)"
  [ "$(show SyslogIdentifier)" = recart ] && pass "SyslogIdentifier=recart" || fail "SyslogIdentifier=$(show SyslogIdentifier)"
  [ "$(show KillSignal)" = 15 ] && pass "KillSignal=SIGTERM" || fail "KillSignal=$(show KillSignal)"
  show Environment | tr ' ' '\n' | grep -qx "LOG_PRIORITY_PREFIX=true" && pass "Environment has LOG_PRIORITY_PREFIX=true" || fail "Environment lacks LOG_PRIORITY_PREFIX=true"
  [ "$(show FragmentPath)" = "/etc/systemd/system/$UNIT.service" ] && pass "unit loaded from $(show FragmentPath)" || fail "FragmentPath=$(show FragmentPath)"
  [ -z "$(show DropInPaths)" ] && pass "no drop-in overrides" || fail "drop-ins: $(show DropInPaths)"
  warnings=$(journalctl -u "$UNIT" --since "$since" --no-pager -o cat 2>/dev/null | grep -E "Failed to parse|Unknown lvalue|Invalid|ignoring" || true)
  [ -z "$warnings" ] && pass "no unit parse warnings logged since $since" || fail "parse warnings since $since: $warnings"
  mine=$(systemd-analyze verify "/etc/systemd/system/$UNIT.service" 2>&1 | grep -F "/etc/systemd/system/$UNIT.service" || true)
  [ -z "$mine" ] && pass "systemd-analyze verify reports nothing about the installed unit" || fail "installed unit: $mine"
  # Use the installed app's own configuration and shutdownPlan, so this check cannot drift from its deadline.
  # Read only shutdown settings; never source an EnvironmentFile or print the unit's other environment values.
  app=$(show WorkingDirectory)
  node_bin=$(show ExecStart | sed -n 's/.*{ path=\([^ ;]*\) ;.*/\1/p')
  [ -n "$node_bin" ] || node_bin=$(command -v node || true)
  if hard=$("$node_bin" --input-type=module - "$app" "$UNIT" <<'NODE'
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [app, unit] = process.argv.slice(2);
const keys = new Set(['SHUTDOWN_DRAIN_SECONDS', 'SHUTDOWN_JOB_GRACE_SECONDS', 'SHUTDOWN_LANGUAGE_GRACE_SECONDS']);
const values = {};
const property = (key) => {
  const raw = execFileSync('systemctl', ['show', unit, '-p', key], { encoding: 'utf8' });
  // systemd 219 returns EnvironmentFile= for a request for EnvironmentFiles; newer versions use the plural name.
  const names = key === 'EnvironmentFiles' ? ['EnvironmentFiles', 'EnvironmentFile'] : [key];
  const name = names.find((name) => raw.startsWith(name + '='));
  if (!name) throw new Error('missing effective setting');
  return raw.slice(name.length + 1).trim();
};
// systemctl quotes assignments containing spaces. Tokenize without evaluating or expanding any of their contents.
function words(text) {
  const out = []; let word = '', quote = null, escaped = false;
  for (const ch of text) {
    if (escaped) { word += ch; escaped = false; }
    else if (ch === '\\' && quote !== "'") escaped = true;
    else if (quote) { if (ch === quote) quote = null; else word += ch; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) { if (word) { out.push(word); word = ''; } }
    else word += ch;
  }
  if (quote || escaped) throw new Error('invalid effective environment');
  if (word) out.push(word);
  return out;
}
try {
  if (!app || !path.isAbsolute(app)) throw new Error('invalid effective WorkingDirectory');
  for (const assignment of words(property('Environment'))) {
    const i = assignment.indexOf('=');
    if (keys.has(assignment.slice(0, i))) values[assignment.slice(0, i)] = assignment.slice(i + 1);
  }
  // EnvironmentFiles override Environment, in their effective order (systemd 219 show format).
  const files = property('EnvironmentFiles');
  const entries = [...files.matchAll(/(?:^|\s)(\S+) \(ignore_errors=(yes|no)\)/g)];
  if (files && (!entries.length || files.replace(/(?:^|\s)(\S+) \(ignore_errors=(yes|no)\)/g, '').trim())) throw new Error('invalid effective EnvironmentFiles');
  for (const [, file, optional] of entries) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch (e) { if (optional === 'yes' && e.code === 'ENOENT') continue; throw e; }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=(.*)$/.exec(line);
      if (!m || !keys.has(m[1])) continue;
      let value = m[2].trim();
      if (value.startsWith('"') || value.startsWith("'")) {
        if (value.length < 2 || value.at(-1) !== value[0]) throw new Error('invalid quoted shutdown setting');
        value = value.slice(1, -1);
      }
      values[m[1]] = value;
    }
  }
  const { loadConfig } = await import(pathToFileURL(path.join(app, 'dist/server/server/config.js')).href);
  const { shutdownPlan } = await import(pathToFileURL(path.join(app, 'dist/server/server/shutdown.js')).href);
  const hard = shutdownPlan(loadConfig(values)).hardMs / 1000;
  if (!Number.isFinite(hard) || hard < 0) throw new Error('invalid shutdown bound');
  console.log(hard);
} catch {
  console.error('Could not calculate shutdown bound from the installed app and effective shutdown settings.');
  process.exitCode = 1;
}
NODE
  ); then
    stop=$(show TimeoutStopUSec)
    stop_s=$(printf '%s' "$stop" | awk '{ s = 0; n = split($0, p, " "); for (i = 1; i <= n; i++) { v = p[i]; if (v ~ /min$/) { sub(/min$/, "", v); s += v * 60 } else if (v ~ /ms$/) { sub(/ms$/, "", v); s += v / 1000 } else if (v ~ /s$/) { sub(/s$/, "", v); s += v } } print s }')
    awk -v s="$stop_s" -v h="$hard" 'BEGIN { exit !(s >= h + 10) }' && pass "TimeoutStopSec $stop leaves room for the app's ${hard} s shutdown bound" || fail "TimeoutStopSec $stop is too short for the app's ${hard} s shutdown bound"
  else
    fail "could not validate the app's shutdown bound"
  fi
  [ -e /var/log/recart.log ] && fail "/var/log/recart.log still exists (nothing writes it)" || pass "no stale /var/log/recart.log"
  ;;
running)
  pid=$(systemctl show -p MainPID "$UNIT" | cut -d= -f2)
  [ "$(systemctl is-active "$UNIT")" = active ] && [ "${pid:-0}" -gt 0 ] && pass "$UNIT active, MainPID $pid, started $(ps -o lstart= -p "$pid")" || fail "$UNIT not active"
  line=$(journalctl _PID="$pid" --no-pager -o cat 2>/dev/null | grep -m1 "listening on" || true)
  [ -n "$line" ] && pass "startup line of PID $pid in the journal: $line" || fail "no startup line for PID $pid in the journal"
  journalctl _PID="$pid" --no-pager -o verbose 2>/dev/null | grep -qm1 "SYSLOG_IDENTIFIER=recart" && pass "journal entries carry SYSLOG_IDENTIFIER=recart" || fail "journal entries lack SYSLOG_IDENTIFIER=recart"
  since=$(date '+%Y-%m-%d %H:%M:%S')
  sleep 1
  kill -USR2 "$pid"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    grep -q "log check: stderr line .* pid $pid" /var/log/messages && break
  done
  j=$(journalctl _PID="$pid" --since "$since" --no-pager -o cat 2>/dev/null)
  jerr=$(journalctl _PID="$pid" --since "$since" -p err --no-pager -o cat 2>/dev/null)
  printf '%s\n' "$j" | grep -q "log check: stdout line .* pid $pid" && pass "stdout line reached the journal" || fail "stdout line missing from the journal"
  printf '%s\n' "$jerr" | grep -q "log check: stderr line .* pid $pid" && pass "stderr line reached the journal at priority err" || fail "stderr line missing from the journal at priority err"
  printf '%s\n' "$jerr" | grep -q "log check: stdout line" && fail "stdout line was filed at priority err" || pass "stdout line filed below err"
  printf '%s\n' "$j" | grep -qE '^<[0-7]>' && fail "a priority prefix is visible in the journal" || pass "priority prefixes stripped by journald"
  grep -q "recart: \[recart\] log check: stdout line .* pid $pid" /var/log/messages && pass "stdout line copied to /var/log/messages" || fail "stdout line missing from /var/log/messages"
  grep -q "recart: \[recart\] log check: stderr line .* pid $pid" /var/log/messages && pass "stderr line copied to /var/log/messages" || fail "stderr line missing from /var/log/messages"
  ;;
*)
  sed -n '2,12p' "$0"; exit 2 ;;
esac
finish
