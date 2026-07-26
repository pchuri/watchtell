#!/usr/bin/env bash
# Test fixture: stands in for `claude -p`. Reads the compile prompt on stdin
# (and ignores it) and emits a deterministic checker in the spike's
# <<<META>>>/<<<SCRIPT>>>/<<<END>>> format.
#
# Knobs via env:
#   FAKE_INTERVAL   interval= value (default 1)
#   FAKE_ROUTE      route= value    (default notify)
#
# The emitted checker watches a probe file (env WATCHTELL_TEST_PROBE): it alarms
# on the transition into a line containing ALARM and recovers out of it, using
# the $WATCHTELL_STATE sidecar — so tests can drive transitions with no network.
set -u
cat >/dev/null   # consume the prompt

INTERVAL="${FAKE_INTERVAL:-1}"
ROUTE="${FAKE_ROUTE:-notify}"

cat <<META
<<<META>>>
interval=${INTERVAL}
route=${ROUTE}
<<<SCRIPT>>>
#!/usr/bin/env bash
set -u
STATE_FILE="\${WATCHTELL_STATE:-\${0}.state}"
PROBE="\${WATCHTELL_TEST_PROBE:-/tmp/watchtell-test-probe}"
cur="ok"
if [ -f "\$PROBE" ] && grep -q ALARM "\$PROBE" 2>/dev/null; then cur="alarm"; fi
prev=""
[ -f "\$STATE_FILE" ] && prev=\$(cat "\$STATE_FILE" 2>/dev/null)
if [ -z "\$prev" ]; then printf '%s\n' "\$cur" > "\$STATE_FILE"; exit 0; fi
if [ "\$cur" != "\$prev" ]; then
  printf '%s\n' "\$cur" > "\$STATE_FILE"
  if [ "\$cur" = "alarm" ]; then printf 'probe entered ALARM state\n'; else printf 'probe recovered to ok\n'; fi
fi
exit 0
<<<END>>>
META
