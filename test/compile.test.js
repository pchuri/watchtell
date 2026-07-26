'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const compile = require('../src/compile');
const paths = require('../src/paths');
const trust = require('../src/trust');
const { makeHome, cleanup, FAKE_COMPILER, FIXTURES } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'watchtell.js');
const FLAKY_COMPILER = path.join(FIXTURES, 'flaky-timeout-compiler.sh');

// Run body with a fresh counter file and env knobs for the flaky/counting
// fixtures, restoring the previous env afterwards.
function withFlakyEnv(env, body) {
  const saved = {};
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtell-flaky-')), 'n');
  const full = { FLAKY_COUNTER: counter, ...env };
  for (const k of Object.keys(full)) {
    saved[k] = process.env[k];
    process.env[k] = full[k];
  }
  try {
    return body(counter);
  } finally {
    for (const k of Object.keys(full)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(path.dirname(counter), { recursive: true, force: true });
  }
}

test('COMPILE_PROMPT rule 5 does not induce tool-specific timeout flags', () => {
  // The runtime (src/run.js) enforces a hard 30s SIGKILL timeout, so the
  // compiler must not tell the model to reach for tool-specific timeout flags
  // (root fix for the earlier auth-curl `--max-time` passthrough workaround).
  assert.doesNotMatch(compile.COMPILE_PROMPT, /--max-time/);
  assert.doesNotMatch(compile.COMPILE_PROMPT, /use curl/i);
  // The fail-safe half must stay intact.
  assert.match(compile.COMPILE_PROMPT, /stay silent and keep the previous state/);
});

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

test('parse clamps a sub-minute interval to the 60s floor with a notice', () => {
  const raw = '<<<META>>>\ninterval=30\n<<<SCRIPT>>>\n#!/bin/bash\ntrue\n<<<END>>>';
  const parsed = compile.parse(raw);
  assert.strictEqual(parsed.meta.interval, 60);
  assert.match(parsed.intervalNotice, /30s is below the 60s minimum; using 60s/);
});

test('parse leaves interval at or above the floor unchanged (no notice)', () => {
  for (const n of [60, 300]) {
    const raw = `<<<META>>>\ninterval=${n}\n<<<SCRIPT>>>\n#!/bin/bash\ntrue\n<<<END>>>`;
    const parsed = compile.parse(raw);
    assert.strictEqual(parsed.meta.interval, n);
    assert.strictEqual(parsed.intervalNotice, null);
  }
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

test('resolveTimeoutMs: opts.timeoutMs wins, env parsed as seconds, invalid -> default', () => {
  const saved = process.env.WATCHTELL_COMPILE_TIMEOUT;
  try {
    // Default when unset.
    delete process.env.WATCHTELL_COMPILE_TIMEOUT;
    assert.strictEqual(compile.resolveTimeoutMs(), compile.DEFAULT_COMPILE_TIMEOUT_MS);
    assert.strictEqual(compile.DEFAULT_COMPILE_TIMEOUT_MS, 600000);

    // Valid seconds -> ms.
    process.env.WATCHTELL_COMPILE_TIMEOUT = '300';
    assert.strictEqual(compile.resolveTimeoutMs(), 300000);

    // opts.timeoutMs takes precedence over the env var.
    assert.strictEqual(compile.resolveTimeoutMs({ timeoutMs: 1234 }), 1234);

    // Invalid / non-positive values fall back to the default.
    for (const bad of [
      '',
      '  ',
      'abc',
      '0',
      '-5',
      'NaN',
      '0.0001',
      '0.5',
      '10000000000000',
      String(Number.MAX_VALUE),
    ]) {
      process.env.WATCHTELL_COMPILE_TIMEOUT = bad;
      assert.strictEqual(
        compile.resolveTimeoutMs(),
        compile.DEFAULT_COMPILE_TIMEOUT_MS,
        `bad value ${JSON.stringify(bad)} should fall back to default`
      );
    }
  } finally {
    if (saved === undefined) delete process.env.WATCHTELL_COMPILE_TIMEOUT;
    else process.env.WATCHTELL_COMPILE_TIMEOUT = saved;
  }
});

test('compile retries once on a timeout and succeeds on the second attempt', () => {
  withFlakyEnv({ FLAKY_SLEEP: '3' }, (counter) => {
    const command = { file: 'bash', args: [FLAKY_COMPILER], label: 'flaky' };
    const out = compile.compile('watch the thing', { command, timeoutMs: 500 });
    // Fixture emits interval=5, which the registration floor clamps to 60.
    assert.strictEqual(out.meta.interval, 60);
    assert.match(out.script, /^#!\/usr\/bin\/env bash/);
    // Two invocations: the timed-out first, then the fast retry.
    assert.strictEqual(fs.readFileSync(counter, 'utf8'), '2');
  });
});

test('compile does NOT retry a non-timeout error (surfaces immediately)', () => {
  withFlakyEnv({}, (counter) => {
    const command = {
      file: 'sh',
      args: ['-c', `n=$(cat "$FLAKY_COUNTER" 2>/dev/null || echo 0); echo $((n+1)) > "$FLAKY_COUNTER"; echo boom >&2; exit 3`],
      label: 'boom',
    };
    assert.throws(
      () => compile.compile('watch', { command, timeoutMs: 500 }),
      /exited 3.*boom/s
    );
    // Called exactly once — no retry on a non-transient error.
    assert.strictEqual(fs.readFileSync(counter, 'utf8').trim(), '1');
  });
});

test('compile fails after 2 attempts when every attempt times out', () => {
  withFlakyEnv({}, (counter) => {
    const command = {
      file: 'sh',
      args: ['-c', `n=$(cat "$FLAKY_COUNTER" 2>/dev/null || echo 0); echo $((n+1)) > "$FLAKY_COUNTER"; sleep 5`],
      label: 'slow',
    };
    assert.throws(
      () => compile.compile('watch', { command, timeoutMs: 400 }),
      /timed out after 2 attempts/
    );
    // Both attempts were made.
    assert.strictEqual(fs.readFileSync(counter, 'utf8').trim(), '2');
  });
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
    // FAKE_INTERVAL=5 is below the floor: the registration clamp prints a
    // notice and the kept checker records 60s.
    assert.match(r.stdout, /interval 5s is below the 60s minimum; using 60s/);

    // Exactly one checker persisted, with meta parsed and trust bound.
    const dir = paths.checkersDir();
    const metas = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
    assert.strictEqual(metas.length, 1);
    const id = metas[0].slice(0, -'.meta.json'.length);
    const meta = JSON.parse(fs.readFileSync(paths.metaPath(id), 'utf8'));
    assert.strictEqual(meta.interval, 60);
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
