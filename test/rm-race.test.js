'use strict';

// rm-vs-running-checker race (v0.2). rm writes a tombstone before deleting a
// checker's sidecars; the daemon re-checks that tombstone around every run/write
// and reaps it, so an rm that overlaps a tick converges to "checker fully gone,
// nothing resurrected, no orphan retries, no error spam". These simulate the
// interleavings deterministically through the existing runDue seams — no sleeps.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const daemon = require('../src/daemon');
const store = require('../src/store');
const paths = require('../src/paths');
const { makeHome, cleanup, createChecker, probeChecker } = require('./helpers');

// Every file an id can own, tombstone included.
function allFiles(id) {
  return [
    paths.scriptPath(id),
    paths.trustPath(id),
    paths.metaPath(id),
    paths.statePath(id),
    paths.runtimePath(id),
    paths.tombstonePath(id),
  ];
}

function assertFullyGone(id) {
  for (const p of allFiles(id)) {
    assert.ok(!fs.existsSync(p), `${path.basename(p)} is gone`);
  }
  assert.strictEqual(store.exists(id), false);
  assert.deepStrictEqual(store.listIds(), []);
  assert.deepStrictEqual(store.listTombstones(), []);
}

test('rm lands mid-tick (during delivery): daemon does not resurrect any file', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), { interval: 1 });
    // Baseline run records "ok"; no transition, no alarm. (Ticks are 70s apart to
    // clear the daemon's 60s poll floor so the second run is due.)
    daemon.runDue({ now: 1_000_000, notifyFn: () => ({ ok: true, route: 'notify' }) });
    fs.writeFileSync(probe, 'ALARM\n');

    // The next tick sees the transition and tries to deliver. rm lands exactly
    // during dispatch: the checker has already run and written its state sidecar,
    // and the daemon is about to persist runtime — the tightest window.
    const logs = [];
    const res = daemon.runDue({
      now: 1_070_000,
      logFn: (m) => logs.push(m),
      notifyFn: () => {
        store.remove(id); // rm interleaves here
        return { ok: true, route: 'notify' };
      },
    }).find((r) => r.id === id);

    assert.strictEqual(res.removed, true, 'tick reports the id as removed, not fired');
    assertFullyGone(id);
    assert.ok(!logs.some((l) => /ERROR|REFUSED/.test(l)), 'no error spam');
  } finally {
    cleanup(home);
  }
});

test('rm lands while the checker is mid-run: post-run guard reaps it with no ERROR spam', () => {
  const home = makeHome();
  try {
    // A checker that removes itself mid-run (writes the tombstone, deletes its own
    // sidecars) and then errors — exactly the rm-during-run interleaving. Trust was
    // verified before it ran, so it is not REFUSED; without the daemon's post-run
    // tombstone check the errored run would log a bogus ERROR and rewrite runtime.
    const selfRemoving = `#!/usr/bin/env bash
set -u
base="\${0%.check.sh}"
: > "\${base}.removed"
rm -f "$0" "\${base}.check-trust" "\${base}.meta.json" "\${base}.runtime.json" "\${WATCHTELL_STATE:-}"
echo "boom" >&2
exit 1
`;
    const id = createChecker(selfRemoving, { interval: 1 });

    const logs = [];
    const res = daemon.runDue({
      now: 1_000_000,
      logFn: (m) => logs.push(m),
      notifyFn: () => ({ ok: true, route: 'notify' }),
    }).find((r) => r.id === id);

    assert.strictEqual(res.removed, true, 'the mid-run rm is reported as a removal');
    assertFullyGone(id);
    assert.ok(!logs.some((l) => /REFUSED|ERROR/.test(l)), 'no bogus REFUSED/ERROR for a removed checker');
  } finally {
    cleanup(home);
  }
});

test('a checker that writes its state sidecar after rm is swept clean on the next tick', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), { interval: 1 });
    daemon.runDue({ now: 1_000, notifyFn: () => ({ ok: true }) });

    store.remove(id); // rm: tombstone + delete sidecars
    // An orphaned checker process writes its state sidecar back after rm.
    fs.writeFileSync(paths.statePath(id), 'alarm\n');
    assert.ok(fs.existsSync(paths.statePath(id)), 'resurrected state exists pre-sweep');

    const logs = [];
    daemon.runDue({ now: 2_000, logFn: (m) => logs.push(m), notifyFn: () => ({ ok: true }) });

    assertFullyGone(id);
    // Reclaiming a resurrected file is worth exactly one informative line.
    const reclaimed = logs.filter((l) => l.startsWith(`REMOVED ${id}`));
    assert.strictEqual(reclaimed.length, 1, 'one informative line for the reclaimed file');
  } finally {
    cleanup(home);
  }
});

test('rm of a checker with a pending undelivered alarm removes the pending record and never retries', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), { interval: 1 });
    // Baseline, then a failing dispatch queues a pending alarm on the runtime record.
    daemon.runDue({ now: 1_000_000, notifyFn: () => ({ ok: true }) });
    fs.writeFileSync(probe, 'ALARM\n');
    daemon.runDue({ now: 1_070_000, notifyFn: () => ({ ok: false, route: 'notify' }) });
    assert.ok(store.readRuntime(id).pending, 'pending alarm owed before rm');

    store.remove(id); // rm while an alarm is still owed

    let deliveries = 0;
    const logs = [];
    daemon.runDue({
      now: 1_140_000,
      logFn: (m) => logs.push(m),
      notifyFn: () => (deliveries++, { ok: true, route: 'notify' }),
    });

    assert.strictEqual(deliveries, 0, 'no retry attempted for the removed checker');
    assertFullyGone(id);
    assert.ok(!logs.some((l) => /NOTIFY|ERROR|REFUSED/.test(l)), 'no orphan-retry log spam');
  } finally {
    cleanup(home);
  }
});

test('a partially-deleted checker (rm crashed mid-delete) converges to clean without spam', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), { interval: 1 });
    daemon.runDue({ now: 1_000, notifyFn: () => ({ ok: true }) });

    // Simulate rm dying after the tombstone + a couple of deletes: script/trust gone,
    // meta/state/runtime still on disk. The tombstone is what guarantees cleanup.
    fs.writeFileSync(paths.tombstonePath(id), '');
    fs.rmSync(paths.scriptPath(id), { force: true });
    fs.rmSync(paths.trustPath(id), { force: true });

    const logs = [];
    daemon.runDue({ now: 2_000, logFn: (m) => logs.push(m), notifyFn: () => ({ ok: true }) });

    assertFullyGone(id);
    assert.ok(!logs.some((l) => /REFUSED|ERROR/.test(l)), 'partial state produces no error spam');
  } finally {
    cleanup(home);
  }
});

test('normal rm with an idle daemon: tick reaps the tombstone silently, nothing recreated', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), { interval: 3600 });
    daemon.runDue({ now: 1_000, notifyFn: () => ({ ok: true }) });

    store.remove(id);
    const logs = [];
    const res = daemon.runDue({ now: 2_000, logFn: (m) => logs.push(m), notifyFn: () => ({ ok: true }) });

    assert.deepStrictEqual(res, [], 'idle tick has nothing to run');
    assertFullyGone(id);
    assert.strictEqual(logs.length, 0, 'a bare tombstone is reaped without any log line');
  } finally {
    cleanup(home);
  }
});

test('rm with no daemon: sidecars gone, id never recycled onto the stale tombstone', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), { interval: 60 });

    assert.strictEqual(store.remove(id), true, 'rm returns without a running daemon');
    assert.strictEqual(store.exists(id), false);
    assert.deepStrictEqual(store.listIds(), []);
    // The tombstone lingers until a daemon reaps it; meanwhile newId must not hand
    // the same id out again (which a later sweep would then delete).
    assert.ok(store.isRemoved(id), 'tombstone persists with no daemon to reap it');
    for (let i = 0; i < 200; i++) {
      assert.notStrictEqual(store.newId(), id, 'never recycle a tombstoned id');
    }
  } finally {
    cleanup(home);
  }
});
