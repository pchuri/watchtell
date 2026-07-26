#!/usr/bin/env bash
# Test fixture: simulates a compiler that is SLOW on its first invocation
# (long enough to trip spawnSync's timeout) and FAST on subsequent ones, so a
# retry lands. Attempt count is tracked in the file named by $FLAKY_COUNTER.
#
# Knobs via env:
#   FLAKY_COUNTER   path to a counter file (required)
#   FLAKY_SLEEP     seconds to sleep on the first attempt (default 30)
set -u
cat >/dev/null   # consume the prompt

COUNTER="${FLAKY_COUNTER:?FLAKY_COUNTER must be set}"
n=0
[ -f "$COUNTER" ] && n=$(cat "$COUNTER" 2>/dev/null)
n=$((n + 1))
printf '%s' "$n" > "$COUNTER"

if [ "$n" -eq 1 ]; then
  sleep "${FLAKY_SLEEP:-30}"   # first attempt: hang past the timeout
fi

cat <<META
<<<META>>>
interval=5
route=notify
<<<SCRIPT>>>
#!/usr/bin/env bash
true
<<<END>>>
META
