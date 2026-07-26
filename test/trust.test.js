'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const paths = require('../src/paths');
const trust = require('../src/trust');
const run = require('../src/run');
const { makeHome, cleanup, createChecker } = require('./helpers');

const OK_SCRIPT = '#!/usr/bin/env bash\nexit 0\n';

test('a freshly bound checker verifies', () => {
  const home = makeHome();
  try {
    const id = createChecker(OK_SCRIPT);
    assert.ok(trust.verify(id).ok);
  } finally {
    cleanup(home);
  }
});

test('a tampered script is refused (hash mismatch)', () => {
  const home = makeHome();
  try {
    const id = createChecker(OK_SCRIPT);
    // Tamper: append a byte AFTER Keep bound the hash.
    fs.appendFileSync(paths.scriptPath(id), '# injected\n');
    const v = trust.verify(id);
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /hash mismatch/);
    const res = run.runChecker(id);
    assert.strictEqual(res.refused, true, 'runChecker refuses tampered bytes');
  } finally {
    cleanup(home);
  }
});

test('a checker with no trust record is refused', () => {
  const home = makeHome();
  try {
    const id = createChecker(OK_SCRIPT);
    fs.rmSync(paths.trustPath(id));
    const v = trust.verify(id);
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /trust record is absent/);
    assert.strictEqual(run.runChecker(id).refused, true);
  } finally {
    cleanup(home);
  }
});

test('a malformed trust record is refused', () => {
  const home = makeHome();
  try {
    const id = createChecker(OK_SCRIPT);
    fs.writeFileSync(paths.trustPath(id), 'garbage\nnothex\n');
    const v = trust.verify(id);
    assert.strictEqual(v.ok, false);
    assert.match(v.reason, /malformed/);
  } finally {
    cleanup(home);
  }
});
