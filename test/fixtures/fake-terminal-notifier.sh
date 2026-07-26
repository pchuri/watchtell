#!/usr/bin/env bash
# Test double for terminal-notifier: records each received argv element (one per
# line) to the file named by FAKE_TN_ARGV so tests can assert exact arguments,
# then exits 0. Proves no shell-string construction reaches the notifier.
set -u
: >"${FAKE_TN_ARGV}"
for arg in "$@"; do
  printf '%s\n' "$arg" >>"${FAKE_TN_ARGV}"
done
exit 0
