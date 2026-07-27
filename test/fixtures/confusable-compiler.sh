#!/usr/bin/env bash
# Test fixture: stands in for `claude -p` but emits a BROKEN checker whose jq
# expression contains U+FF5C FULLWIDTH VERTICAL LINE (`｜`) instead of ASCII `|`
# — the real 2026-07-27 incident. Deterministic, so every attempt reproduces it,
# exercising the add-time confusable lint's retry-then-fail path.
set -u
cat >/dev/null   # consume the prompt

cat <<'META'
<<<META>>>
interval=300
route=notify
<<<SCRIPT>>>
#!/usr/bin/env bash
set -u
STATE_FILE="${WATCHTELL_STATE:-${0}.state}"
n=$(curl -s https://example.invalid/issues | jq -r '.[0] | " #" + (.number｜tostring)' 2>/dev/null)
printf '%s\n' "$n" > "$STATE_FILE"
exit 0
<<<END>>>
META
