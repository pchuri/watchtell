'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const store = require('../src/store');
const paths = require('../src/paths');
const daemon = require('../src/daemon');
const { makeHome, cleanup, createChecker, probeChecker } = require('./helpers');

test('rm deletes checker, trust record, meta, state, and runtime sidecars', () => {
  const home = makeHome();
  try {
    const probe = `${home}/probe.txt`;
    const id = createChecker(probeChecker(probe), { interval: 1 });
    // Run once so a state sidecar and runtime record exist.
    daemon.runDue({ now: 1_000, notifyFn: () => ({ ok: true }) });

    const sidecars = [
      paths.scriptPath(id),
      paths.trustPath(id),
      paths.metaPath(id),
      paths.statePath(id),
      paths.runtimePath(id),
    ];
    assert.ok(sidecars.some((p) => fs.existsSync(p)), 'sidecars exist before rm');

    const removed = store.remove(id);
    assert.strictEqual(removed, true);
    for (const p of sidecars) {
      assert.ok(!fs.existsSync(p), `${p} removed`);
    }
    assert.strictEqual(store.exists(id), false);
    assert.deepStrictEqual(store.listIds(), []);
  } finally {
    cleanup(home);
  }
});

test('remove reports false when nothing existed', () => {
  const home = makeHome();
  try {
    assert.strictEqual(store.remove('nope99'), false);
  } finally {
    cleanup(home);
  }
});
