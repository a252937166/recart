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
ENV_FILE=/opt/recart/recart.env
fails=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; fails=$((fails + 1)); }
finish() {
  echo "systemd $(systemctl --version | head -1 | awk '{print $2}') on $(hostname): $([ "$fails" -eq 0 ] && echo "all checks passed" || echo "$fails check(s) failed")"
  [ "$fails" -eq 0 ]
  exit $?
}
envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-; }

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
  show Environment | tr ' ' '\n' | grep -qx "LOG_PRIORITY_PREFIX=true" && pass "Environment has LOG_PRIORITY_PREFIX=true" || fail "Environment: $(show Environment)"
  [ "$(show FragmentPath)" = "/etc/systemd/system/$UNIT.service" ] && pass "unit loaded from $(show FragmentPath)" || fail "FragmentPath=$(show FragmentPath)"
  [ -z "$(show DropInPaths)" ] && pass "no drop-in overrides" || fail "drop-ins: $(show DropInPaths)"
  warnings=$(journalctl -u "$UNIT" --since "$since" --no-pager -o cat 2>/dev/null | grep -E "Failed to parse|Unknown lvalue|Invalid|ignoring" || true)
  [ -z "$warnings" ] && pass "no unit parse warnings logged since $since" || fail "parse warnings since $since: $warnings"
  mine=$(systemd-analyze verify "/etc/systemd/system/$UNIT.service" 2>&1 | grep -F "/etc/systemd/system/$UNIT.service" || true)
  [ -z "$mine" ] && pass "systemd-analyze verify reports nothing about the installed unit" || fail "installed unit: $mine"
  # The app's own exit deadline (see src/server/shutdown.ts) must fall well inside the stop timeout.
  drain=$(envval SHUTDOWN_DRAIN_SECONDS); grace=$(envval SHUTDOWN_JOB_GRACE_SECONDS)
  hard=$(awk -v d="${drain:-15}" -v g="${grace:-10}" 'BEGIN { a = d + 2; b = g + 5; m = (a > b ? a : b); print m + 5 + 3 }')
  stop=$(show TimeoutStopUSec)
  stop_s=$(printf '%s' "$stop" | awk '{ s = 0; n = split($0, p, " "); for (i = 1; i <= n; i++) { v = p[i]; if (v ~ /min$/) { sub(/min$/, "", v); s += v * 60 } else if (v ~ /ms$/) { sub(/ms$/, "", v); s += v / 1000 } else if (v ~ /s$/) { sub(/s$/, "", v); s += v } } print s }')
  awk -v s="$stop_s" -v h="$hard" 'BEGIN { exit !(s >= h + 10) }' && pass "TimeoutStopSec $stop leaves room for the app's ${hard} s shutdown bound" || fail "TimeoutStopSec $stop is too short for the app's ${hard} s shutdown bound"
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
