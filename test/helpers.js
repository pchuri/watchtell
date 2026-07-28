'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../src/paths');
const store = require('../src/store');
const trust = require('../src/trust');

const FIXTURES = path.join(__dirname, 'fixtures');
const FAKE_COMPILER = path.join(FIXTURES, 'fake-compiler.sh');

// Fresh isolated WATCHTELL_HOME for a test; returns the dir (already set on env).
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtell-test-'));
  process.env.WATCHTELL_HOME = dir;
  store.ensureHome();
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Create a kept, hash-bound checker directly (bypassing the LLM) for run/daemon tests.
function createChecker(scriptBytes, meta = {}) {
  const id = store.newId();
  fs.writeFileSync(paths.scriptPath(id), scriptBytes, { mode: 0o700 });
  store.writeMeta(id, {
    id,
    request: meta.request || 'test checker',
    interval: meta.interval || 1,
    route: meta.route || 'notify',
    ...(meta.webhookUrl ? { webhookUrl: meta.webhookUrl } : {}),
    agent: 'fixture',
    createdAt: meta.createdAt || new Date().toISOString(),
  });
  trust.bind(id);
  return id;
}

// A checker that alarms on transition into ALARM, driven by a probe file.
function probeChecker(probeFile) {
  return `#!/usr/bin/env bash
set -u
STATE_FILE="\${WATCHTELL_STATE:-\${0}.state}"
PROBE="${probeFile}"
cur="ok"
if [ -f "$PROBE" ] && grep -q ALARM "$PROBE" 2>/dev/null; then cur="alarm"; fi
prev=""
[ -f "$STATE_FILE" ] && prev=$(cat "$STATE_FILE" 2>/dev/null)
if [ -z "$prev" ]; then printf '%s\\n' "$cur" > "$STATE_FILE"; exit 0; fi
if [ "$cur" != "$prev" ]; then
  printf '%s\\n' "$cur" > "$STATE_FILE"
  if [ "$cur" = "alarm" ]; then printf 'probe entered ALARM state\\n'; else printf 'probe recovered\\n'; fi
fi
exit 0
`;
}

module.exports = { FIXTURES, FAKE_COMPILER, makeHome, cleanup, createChecker, probeChecker };
