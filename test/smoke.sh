#!/usr/bin/env bash
# End-to-end happy-path smoke for watchtell, using a FIXTURE compiler (no live
# LLM) and a mock notifier (no real Notification Center — sandboxes/CI have no
# GUI session). Proves: add -> keep+bind -> list -> test transition -> daemon
# start/status/stop -> notification dispatch on transition -> rm cleanup.
#
# Run: bash test/smoke.sh   (from the repo root)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/bin/watchtell.js"
FIXTURE="$ROOT/test/fixtures/fake-compiler.sh"

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/watchtell-smoke.XXXXXX")"
PROBE="$HOME_DIR/probe.txt"
NOTIFY_LOG="$HOME_DIR/notify.log"
trap 'node "$BIN" daemon stop >/dev/null 2>&1 || true; rm -rf "$HOME_DIR"' EXIT

export WATCHTELL_HOME="$HOME_DIR"
export WATCHTELL_COMPILER_CMD="bash $FIXTURE"
export WATCHTELL_TEST_PROBE="$PROBE"
# Mock osascript: record dispatched notifications to a file.
export WATCHTELL_NOTIFY_CMD="printf '%s|%s\n' \"\$WATCHTELL_ROUTE\" \"\$WATCHTELL_MESSAGE\" >> $NOTIFY_LOG"
export FAKE_INTERVAL=1
export WATCHTELL_POLL=500

say() { printf '\n=== %s ===\n' "$1"; }

say "add (fixture compiler, --yes)"
node "$BIN" add "alert me when the probe trips" --yes
ID="$(node "$BIN" list | awk 'NR==2 {print $1}')"
[ -n "$ID" ] || { echo "FAIL: no checker id after add"; exit 1; }
echo "checker id: $ID"

say "list"
node "$BIN" list

say "test with no transition (silent baseline already recorded)"
node "$BIN" test "$ID"

say "flip probe -> ALARM, then test => transition line"
printf 'ALARM\n' > "$PROBE"
OUT="$(node "$BIN" test "$ID")"
echo "$OUT"
echo "$OUT" | grep -q "TRANSITION" || { echo "FAIL: expected a transition"; exit 1; }

say "reset probe so the daemon observes ok->alarm itself"
rm -f "$PROBE"
node "$BIN" test "$ID"

say "daemon start --detach; status"
node "$BIN" daemon start --detach
sleep 1
node "$BIN" daemon status | grep -q running || { echo "FAIL: daemon not running"; exit 1; }

say "trip the probe; wait for the daemon to fire a notification"
printf 'ALARM\n' > "$PROBE"
node -e 'const store = require(process.argv[1]); const { MIN_INTERVAL_SECONDS } = require(process.argv[2]); const id = process.argv[3]; const runtime = store.readRuntime(id); runtime.lastRunAt = Date.now() - MIN_INTERVAL_SECONDS * 1000; store.writeRuntime(id, runtime);' "$ROOT/src/store" "$ROOT/src/compile" "$ID"
for _ in $(seq 1 20); do
  [ -s "$NOTIFY_LOG" ] && break
  sleep 0.5
done
[ -s "$NOTIFY_LOG" ] || { echo "FAIL: daemon never dispatched a notification"; exit 1; }
echo "notification dispatched:"; cat "$NOTIFY_LOG"
grep -q "entered ALARM" "$NOTIFY_LOG" || { echo "FAIL: wrong notification body"; exit 1; }

say "daemon stop; status"
node "$BIN" daemon stop
node "$BIN" daemon status | grep -q "not running" || { echo "FAIL: daemon still running"; exit 1; }

say "rm + list empty"
node "$BIN" rm "$ID"
node "$BIN" list | grep -q "No checkers" || { echo "FAIL: checker not removed"; exit 1; }

printf '\nSMOKE OK\n'
