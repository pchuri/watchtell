'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const compile = require('../src/compile');
const paths = require('../src/paths');
const trust = require('../src/trust');
const { makeHome, cleanup, FAKE_COMPILER } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'watchtell.js');

test('parse extracts meta and script from the delimiter block', () => {
  const raw = [
    'noise before',
    '<<<META>>>',
    'interval=60',
    'route=slack',
    '<<<SCRIPT>>>',
    '#!/usr/bin/env bash',
    'echo hi',
    '<<<END>>>',
    'noise after',
  ].join('\n');
  const { meta, script } = compile.parse(raw);
  assert.strictEqual(meta.interval, 60);
  assert.strictEqual(meta.route, 'slack');
  assert.match(script, /^#!\/usr\/bin\/env bash\n/);
  assert.match(script, /echo hi/);
});

test('parse defaults interval/route when meta is sparse', () => {
  const raw = '<<<META>>>\n\n<<<SCRIPT>>>\n#!/bin/bash\ntrue\n<<<END>>>';
  const { meta } = compile.parse(raw);
  assert.strictEqual(meta.interval, 300);
  assert.strictEqual(meta.route, 'notify');
});

test('parse throws on a missing block', () => {
  assert.throws(() => compile.parse('no delimiters here'), compile.CompileError);
});

test('parse throws when script lacks a shebang', () => {
  const raw = '<<<META>>>\ninterval=30\n<<<SCRIPT>>>\necho no shebang\n<<<END>>>';
  assert.throws(() => compile.parse(raw), /shebang/);
});

test('resolveCommand errors clearly when no agent CLI is available', () => {
  const saved = { ...process.env };
  delete process.env.WATCHTELL_COMPILER_CMD;
  // Force which() to find nothing by emptying PATH.
  process.env.PATH = '';
  try {
    assert.throws(() => compile.resolveCommand(), /Install `claude` or `codex`/);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.WATCHTELL_COMPILER_CMD) process.env.WATCHTELL_COMPILER_CMD = saved.WATCHTELL_COMPILER_CMD;
  }
});

test('add (with fixture compiler) compiles, keeps, hash-binds, and runs immediate test', () => {
  const home = makeHome();
  try {
    const r = spawnSync(process.execPath, [BIN, 'add', 'alert me when the probe trips', '--yes'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WATCHTELL_HOME: home,
        WATCHTELL_COMPILER_CMD: `bash ${FAKE_COMPILER}`,
        FAKE_INTERVAL: '5',
        FAKE_ROUTE: 'notify',
      },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /Generated checker/);
    assert.match(r.stdout, /Kept as [0-9a-f]{6}/);
    assert.match(r.stdout, /immediate test/);

    // Exactly one checker persisted, with meta parsed and trust bound.
    const dir = paths.checkersDir();
    const metas = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
    assert.strictEqual(metas.length, 1);
    const id = metas[0].slice(0, -'.meta.json'.length);
    const meta = JSON.parse(fs.readFileSync(paths.metaPath(id), 'utf8'));
    assert.strictEqual(meta.interval, 5);
    assert.strictEqual(meta.route, 'notify');
    assert.strictEqual(meta.request, 'alert me when the probe trips');
    assert.ok(fs.existsSync(paths.scriptPath(id)));
    assert.ok(trust.verify(id).ok, 'kept checker verifies against its trust record');
  } finally {
    cleanup(home);
  }
});

test('add reports an unsupported route as using notify', () => {
  const home = makeHome();
  try {
    const r = spawnSync(process.execPath, [BIN, 'add', 'ping slack when X', '--yes'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WATCHTELL_HOME: home,
        WATCHTELL_COMPILER_CMD: `bash ${FAKE_COMPILER}`,
        FAKE_ROUTE: 'slack',
      },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /route 'slack' not yet supported, using notify/);
  } finally {
    cleanup(home);
  }
});
