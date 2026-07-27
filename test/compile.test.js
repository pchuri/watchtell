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
const CONFUSABLE_COMPILER = path.join(FIXTURES, 'confusable-compiler.sh');

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

test('parseDuration accepts seconds and simple duration forms', () => {
  assert.strictEqual(compile.parseDuration('600'), 600);
  assert.strictEqual(compile.parseDuration('5m'), 300);
  assert.strictEqual(compile.parseDuration('1h'), 3600);
  assert.strictEqual(compile.parseDuration('90s'), 90);
  // Below the floor is still a VALID duration — parseDuration does not clamp.
  assert.strictEqual(compile.parseDuration('30'), 30);
});

test('parseDuration rejects invalid and unsafe durations', () => {
  for (const bad of [
    'abc',
    '0',
    '-5',
    '',
    '  ',
    '5x',
    '1.5m',
    '5 m',
    '9'.repeat(400),
  ]) {
    assert.throws(
      () => compile.parseDuration(bad),
      compile.CompileError,
      `expected ${JSON.stringify(bad)} to throw`
    );
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

// ---- ASCII-confusable lint -------------------------------------------------

test('lintConfusables rejects the real-incident U+FF5C in a jq expression', () => {
  // The exact broken line from issue #13: fullwidth vertical bar instead of `|`.
  const script = '#!/usr/bin/env bash\njq -r \'" #" + (.number｜tostring)\'\n';
  const findings = compile.lintConfusables(script);
  assert.strictEqual(findings.length, 1);
  assert.strictEqual(findings[0].line, 2);
  assert.strictEqual(findings[0].codepoint, 'U+FF5C');
  assert.strictEqual(findings[0].ascii, '|');
  assert.strictEqual(findings[0].char, '｜');
});

test('lintConfusables rejects fullwidth parens/quotes/space, curly quotes, em dash, NBSP', () => {
  const cases = [
    ['（', 'U+FF08', '('], // FULLWIDTH LEFT PARENTHESIS
    ['）', 'U+FF09', ')'], // FULLWIDTH RIGHT PARENTHESIS
    ['＂', 'U+FF02', '"'], // FULLWIDTH QUOTATION MARK
    ['＇', 'U+FF07', "'"], // FULLWIDTH APOSTROPHE
    ['＝', 'U+FF1D', '='], // FULLWIDTH EQUALS SIGN
    ['　', 'U+3000', ' '], // IDEOGRAPHIC SPACE
    ['‘', 'U+2018', "'"], // LEFT SINGLE QUOTATION MARK
    ['’', 'U+2019', "'"], // RIGHT SINGLE QUOTATION MARK
    ['“', 'U+201C', '"'], // LEFT DOUBLE QUOTATION MARK
    ['”', 'U+201D', '"'], // RIGHT DOUBLE QUOTATION MARK
    ['–', 'U+2013', '-'], // EN DASH
    ['—', 'U+2014', '-'], // EM DASH
    ['−', 'U+2212', '-'], // MINUS SIGN
    [' ', 'U+00A0', ' '], // NO-BREAK SPACE
  ];
  for (const [ch, cp, ascii] of cases) {
    const findings = compile.lintConfusables(`#!/bin/bash\necho ${ch}\n`);
    assert.strictEqual(findings.length, 1, `expected one finding for ${cp}`);
    assert.strictEqual(findings[0].codepoint, cp);
    assert.strictEqual(findings[0].ascii, ascii);
  }
});

test('lintConfusables ACCEPTS legitimate Korean in grep and printf (real acgcamp shape)', () => {
  // Modeled on the real acgcamp checker: Korean in a grep pattern and a Korean
  // alarm message. These MUST pass — the lint is not a non-ASCII ban.
  const script = [
    '#!/usr/bin/env bash',
    'set -u',
    "if curl -s https://example.invalid | grep -q '권한이 없습니다'; then",
    "  printf '접근 권한이 없습니다\\n'",
    'fi',
    '',
  ].join('\n');
  assert.deepStrictEqual(compile.lintConfusables(script), []);
});

test('formatConfusables names the line number and codepoint', () => {
  const findings = compile.lintConfusables('#!/bin/bash\njq \'.a｜b\'\n');
  const msg = compile.formatConfusables(findings);
  assert.match(msg, /line 2/);
  assert.match(msg, /U\+FF5C/);
  assert.match(msg, /resembles ASCII '\|'/);
});

test('compile retries once then fails when the compiler emits confusables', () => {
  withFlakyEnv({}, (counter) => {
    const command = {
      file: 'sh',
      args: [
        '-c',
        `n=$(cat "$FLAKY_COUNTER" 2>/dev/null || echo 0); echo $((n+1)) > "$FLAKY_COUNTER"; bash ${CONFUSABLE_COMPILER}`,
      ],
      label: 'confusable',
    };
    assert.throws(
      () => compile.compile('watch issues', { command, timeoutMs: 5000 }),
      /ASCII-confusable characters[\s\S]*U\+FF5C/
    );
    // Two attempts: initial + one retry, matching the timeout retry budget.
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

test('add --interval wins over the compiler-inferred interval', () => {
  const home = makeHome();
  try {
    const r = spawnSync(
      process.execPath,
      [BIN, 'add', 'alert me when the probe trips', '--yes', '--interval', '10m'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          WATCHTELL_HOME: home,
          WATCHTELL_COMPILER_CMD: `bash ${FAKE_COMPILER}`,
          FAKE_INTERVAL: '300',
          FAKE_ROUTE: 'notify',
        },
      }
    );
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /meta: interval=600s/);
    const dir = paths.checkersDir();
    const id = fs
      .readdirSync(dir)
      .find((f) => f.endsWith('.meta.json'))
      .slice(0, -'.meta.json'.length);
    const meta = JSON.parse(fs.readFileSync(paths.metaPath(id), 'utf8'));
    assert.strictEqual(meta.interval, 600);
  } finally {
    cleanup(home);
  }
});

test('add --interval below the floor clamps to 60s with a notice', () => {
  const home = makeHome();
  try {
    const r = spawnSync(
      process.execPath,
      [BIN, 'add', 'alert me', '--yes', '--interval', '30'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          WATCHTELL_HOME: home,
          WATCHTELL_COMPILER_CMD: `bash ${FAKE_COMPILER}`,
          FAKE_INTERVAL: '300',
        },
      }
    );
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /interval 30s is below the 60s minimum; using 60s/);
    assert.match(r.stdout, /meta: interval=60s/);
  } finally {
    cleanup(home);
  }
});

test('add without --interval preserves the compiled interval', () => {
  const home = makeHome();
  try {
    const r = spawnSync(process.execPath, [BIN, 'add', 'alert me', '--yes'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WATCHTELL_HOME: home,
        WATCHTELL_COMPILER_CMD: `bash ${FAKE_COMPILER}`,
        FAKE_INTERVAL: '300',
      },
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /meta: interval=300s/);
  } finally {
    cleanup(home);
  }
});

test('add rejects an invalid --interval before compiling', () => {
  const home = makeHome();
  try {
    const r = spawnSync(
      process.execPath,
      [BIN, 'add', 'alert me', '--yes', '--interval', 'abc'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          WATCHTELL_HOME: home,
          // A compiler that would fail loudly if invoked — proves fail-fast.
          WATCHTELL_COMPILER_CMD: 'echo should-not-run >&2; exit 9',
        },
      }
    );
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /invalid --interval 'abc'/);
    assert.doesNotMatch(r.stderr, /should-not-run/);
    // Nothing was persisted.
    assert.strictEqual(fs.readdirSync(paths.checkersDir()).length, 0);
  } finally {
    cleanup(home);
  }
});

test('add fails on a confusable checker without keeping it or binding trust', () => {
  const home = makeHome();
  try {
    const r = spawnSync(process.execPath, [BIN, 'add', 'alert on new issues', '--yes'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WATCHTELL_HOME: home,
        WATCHTELL_COMPILER_CMD: `bash ${CONFUSABLE_COMPILER}`,
      },
    });
    assert.strictEqual(r.status, 1, r.stdout);
    assert.match(r.stderr, /ASCII-confusable characters/);
    assert.match(r.stderr, /U\+FF5C/);
    // Nothing persisted: no meta, no script, no trust record.
    assert.strictEqual(fs.readdirSync(paths.checkersDir()).length, 0);
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
