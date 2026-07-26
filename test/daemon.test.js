'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const daemon = require('../src/daemon');
const store = require('../src/store');
const paths = require('../src/paths');
const { makeHome, cleanup, createChecker, probeChecker } = require('./helpers');

test('isDue: never-run is due, within interval is not, elapsed is due', () => {
  const meta = { interval: 60 };
  assert.strictEqual(daemon.isDue({ lastRunAt: null }, meta, 1000), true);
  assert.strictEqual(daemon.isDue({ lastRunAt: 1000 }, meta, 1000 + 30 * 1000), false);
  assert.strictEqual(daemon.isDue({ lastRunAt: 1000 }, meta, 1000 + 60 * 1000), true);
});

test('runDue runs only due checkers', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const dueId = createChecker(probeChecker(probe), { interval: 1 });
    const notDueId = createChecker(probeChecker(probe), { interval: 3600 });
    // Mark notDueId as just-run so it is not due; dueId has no runtime yet.
    store.writeRuntime(notDueId, { lastRunAt: 10_000, lastFiredAt: null, lastState: null });

    const results = daemon.runDue({ now: 11_000, notifyFn: () => ({ ok: true, route: 'notify' }) });
    const ranIds = results.map((r) => r.id);
    assert.ok(ranIds.includes(dueId), 'due checker ran');
    assert.ok(!ranIds.includes(notDueId), 'not-due checker skipped');
  } finally {
    cleanup(home);
  }
});

test('transition relay: fires once on transition, dispatches notify, dedupes', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const notifyLog = path.join(home, 'notify.log');
    process.env.WATCHTELL_NOTIFY_CMD = `printf '%s|%s|%s\\n' "$WATCHTELL_ROUTE" "$WATCHTELL_TITLE" "$WATCHTELL_MESSAGE" >> ${notifyLog}`;

    const id = createChecker(probeChecker(probe), { interval: 1, request: 'probe trips' });

    // #1 baseline (probe absent -> ok): silent, no notification.
    let res = daemon.runDue({ now: 1_000_000 });
    assert.strictEqual(res.find((r) => r.id === id).fired, false);
    assert.ok(!fs.existsSync(notifyLog), 'no notification on baseline run');

    // Flip probe to ALARM, run again -> transition fires + notifies.
    fs.writeFileSync(probe, 'ALARM\n');
    res = daemon.runDue({ now: 1_005_000 });
    const fired = res.find((r) => r.id === id);
    assert.strictEqual(fired.fired, true);
    assert.match(fired.output, /entered ALARM/);
    const log1 = fs.readFileSync(notifyLog, 'utf8').trim().split('\n');
    assert.strictEqual(log1.length, 1, 'exactly one notification dispatched');
    assert.match(log1[0], /^notify\|watchtell: probe trips\|probe entered ALARM state$/);
    assert.ok(store.readRuntime(id).lastFiredAt, 'lastFiredAt recorded');

    // #3 probe still ALARM: checker stays silent (dedupe) -> no new notification.
    res = daemon.runDue({ now: 1_010_000 });
    assert.strictEqual(res.find((r) => r.id === id).fired, false);
    const log2 = fs.readFileSync(notifyLog, 'utf8').trim().split('\n');
    assert.strictEqual(log2.length, 1, 'no re-alarm while condition persists');
  } finally {
    delete process.env.WATCHTELL_NOTIFY_CMD;
    cleanup(home);
  }
});

test('runDue enforces the per-run timeout (no fire on timeout)', () => {
  const home = makeHome();
  const saved = process.env.WATCHTELL_TIMEOUT_MS;
  try {
    process.env.WATCHTELL_TIMEOUT_MS = '400';
    const slow = '#!/usr/bin/env bash\nsleep 5\necho too-late\n';
    const id = createChecker(slow, { interval: 1 });
    let notified = 0;
    const res = daemon.runDue({ now: 2_000_000, notifyFn: () => (notified++, { ok: true }) });
    const r = res.find((x) => x.id === id);
    assert.strictEqual(r.fired, false);
    assert.strictEqual(r.timedOut, true);
    assert.strictEqual(notified, 0, 'a timed-out checker never notifies');
  } finally {
    if (saved === undefined) delete process.env.WATCHTELL_TIMEOUT_MS;
    else process.env.WATCHTELL_TIMEOUT_MS = saved;
    cleanup(home);
  }
});

test('runDue refuses a tampered checker instead of running it', () => {
  const home = makeHome();
  try {
    const id = createChecker('#!/usr/bin/env bash\necho hi\n', { interval: 1 });
    fs.appendFileSync(paths.scriptPath(id), '# tamper\n');
    const res = daemon.runDue({ now: 3_000_000, notifyFn: () => ({ ok: true }) });
    const r = res.find((x) => x.id === id);
    assert.strictEqual(r.refused, true);
    assert.match(r.reason, /hash mismatch/);
  } finally {
    cleanup(home);
  }
});
