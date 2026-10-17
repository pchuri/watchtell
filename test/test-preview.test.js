'use strict';

// `watchtell test` is a read-only preview: it must never consume a real checker
// transition (production state sidecar), touch the runtime record (lastRunAt /
// pending), or deliver anything. These tests drive cmdTest + runDue with
// synthetic probe checkers and an injected notifier — no real notifications.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cli = require('../src/cli');
const daemon = require('../src/daemon');
const store = require('../src/store');
const paths = require('../src/paths');
const { makeHome, cleanup, createChecker, probeChecker } = require('./helpers');

// Capture stdout/stderr/exitCode of a synchronous CLI command.
function capture(fn) {
  const out = [];
  const err = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  const savedExit = process.exitCode;
  process.exitCode = undefined;
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  let exitCode;
  try {
    fn();
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    exitCode = process.exitCode;
    process.exitCode = savedExit;
  }
  return { stdout: out.join(''), stderr: err.join(''), exitCode };
}

// Point os.tmpdir() at a dedicated empty dir so temp cleanup is observable.
function withTmpRoot(home, fn) {
  const root = path.join(home, 'preview-tmp');
  fs.mkdirSync(root, { recursive: true });
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = root;
  try {
    return fn(root);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function snapshot(id) {
  return {
    state: readOrNull(paths.statePath(id)),
    runtime: readOrNull(paths.runtimePath(id)),
  };
}

test('test previews an ALARM transition without consuming it; the daemon later delivers it exactly once', () => {
  const home = makeHome();
  try {
    withTmpRoot(home, (tmpRoot) => {
      const probe = path.join(home, 'probe.txt');
      const id = createChecker(probeChecker(probe), { interval: 1, request: 'probe trips' });
      const delivered = [];
      const notifyFn = (route, title, message) => (delivered.push(message), { ok: true, route: 'notify' });

      // Baseline ok.
      daemon.runDue({ now: 1_000_000, notifyFn });
      assert.strictEqual(fs.readFileSync(paths.statePath(id), 'utf8'), 'ok\n');
      const before = snapshot(id);

      fs.writeFileSync(probe, 'ALARM\n');

      const first = capture(() => cli.cmdTest(id));
      assert.strictEqual(first.exitCode, undefined, first.stderr);
      assert.match(first.stdout, /TRANSITION: probe entered ALARM state/);
      assert.match(first.stdout, /preview only/);
      assert.deepStrictEqual(snapshot(id), before, 'state sidecar and runtime record untouched');
      assert.deepStrictEqual(fs.readdirSync(tmpRoot), [], 'temporary preview dir removed');

      // A repeated preview still sees the same unconsumed transition.
      const second = capture(() => cli.cmdTest(id));
      assert.match(second.stdout, /TRANSITION: probe entered ALARM state/);
      assert.deepStrictEqual(snapshot(id), before);
      assert.deepStrictEqual(delivered, [], 'test never delivers');

      // The daemon's next due run detects and delivers the transition once.
      const res = daemon.runDue({ now: 1_070_000, notifyFn }).find((r) => r.id === id);
      assert.strictEqual(res.fired, true);
      assert.deepStrictEqual(delivered, ['probe entered ALARM state']);

      daemon.runDue({ now: 1_140_000, notifyFn });
      assert.deepStrictEqual(delivered, ['probe entered ALARM state'], 'no re-alarm afterwards');

      // After delivery the preview is steady-state silent and reports the real state.
      const third = capture(() => cli.cmdTest(id));
      assert.match(third.stdout, /silent \(no transition\)\. state=alarm/);
    });
  } finally {
    cleanup(home);
  }
});

test('control: without test, the daemon delivers the same transition exactly once', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), { interval: 1, request: 'probe trips' });
    const delivered = [];
    const notifyFn = (route, title, message) => (delivered.push(message), { ok: true, route: 'notify' });

    daemon.runDue({ now: 1_000_000, notifyFn });
    fs.writeFileSync(probe, 'ALARM\n');
    const res = daemon.runDue({ now: 1_070_000, notifyFn }).find((r) => r.id === id);
    assert.strictEqual(res.fired, true);
    daemon.runDue({ now: 1_140_000, notifyFn });
    assert.deepStrictEqual(delivered, ['probe entered ALARM state']);
  } finally {
    cleanup(home);
  }
});

test('test leaves runtime lastRunAt and a queued pending alarm byte-for-byte unchanged', () => {
  const home = makeHome();
  try {
    withTmpRoot(home, (tmpRoot) => {
      const probe = path.join(home, 'probe.txt');
      const id = createChecker(probeChecker(probe), { interval: 1, request: 'probe trips' });
      fs.writeFileSync(paths.statePath(id), 'ok\n');
      store.writeRuntime(id, {
        lastRunAt: 1_000_000,
        lastFiredAt: null,
        lastState: 'ok',
        lastOutput: 'owed alarm',
        lastError: 'notification dispatch failed',
        pending: { output: 'owed alarm', route: 'notify', request: 'probe trips', attempts: 1, queuedAt: 1_000_000 },
      });
      fs.writeFileSync(probe, 'ALARM\n');
      const before = snapshot(id);

      const out = capture(() => cli.cmdTest(id));
      assert.match(out.stdout, /TRANSITION: probe entered ALARM state/);
      assert.deepStrictEqual(snapshot(id), before);
      assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);
    });
  } finally {
    cleanup(home);
  }
});

test('test runs the verified bytes from an isolated temp dir, not the checkers dir', () => {
  const home = makeHome();
  try {
    withTmpRoot(home, (tmpRoot) => {
      const id = createChecker(
        '#!/usr/bin/env bash\nprintf \'%s|%s\\n\' "$0" "$WATCHTELL_STATE"\n'
      );
      const out = capture(() => cli.cmdTest(id));
      const line = out.stdout.match(/TRANSITION: (.*)\n/)[1];
      const [script, state] = line.split('|');
      const realRoot = fs.realpathSync(tmpRoot);
      for (const p of [script, state]) {
        assert.ok(
          p.startsWith(tmpRoot + path.sep) || p.startsWith(realRoot + path.sep),
          `${p} is inside the temp root`
        );
      }
      assert.ok(!script.startsWith(paths.checkersDir()));
      assert.strictEqual(readOrNull(paths.statePath(id)), null, 'no production state created');
      assert.strictEqual(readOrNull(paths.runtimePath(id)), null, 'no runtime record created');
      assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);
    });
  } finally {
    cleanup(home);
  }
});

test('test cleans up its temp dir and keeps production state on checker errors', () => {
  const home = makeHome();
  try {
    withTmpRoot(home, (tmpRoot) => {
      const id = createChecker(
        '#!/usr/bin/env bash\nprintf \'changed\\n\' > "$WATCHTELL_STATE"\nprintf \'false alarm\\n\'\nexit 1\n'
      );
      fs.writeFileSync(paths.statePath(id), 'previous\n');
      const out = capture(() => cli.cmdTest(id));
      assert.match(out.stdout, /checker error: .*status 1.* \(no alarm\)/);
      assert.doesNotMatch(out.stdout, /TRANSITION/);
      assert.strictEqual(fs.readFileSync(paths.statePath(id), 'utf8'), 'previous\n');
      assert.strictEqual(readOrNull(paths.runtimePath(id)), null);
      assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);
    });
  } finally {
    cleanup(home);
  }
});

test('test cleans up its temp dir on timeouts', () => {
  const home = makeHome();
  const saved = process.env.WATCHTELL_TIMEOUT_MS;
  try {
    process.env.WATCHTELL_TIMEOUT_MS = '200';
    withTmpRoot(home, (tmpRoot) => {
      const id = createChecker(
        '#!/usr/bin/env bash\nprintf \'changed\\n\' > "$WATCHTELL_STATE"\nsleep 5\necho too-late\n'
      );
      fs.writeFileSync(paths.statePath(id), 'previous\n');
      const out = capture(() => cli.cmdTest(id));
      assert.match(out.stdout, /timed out after .* \(no alarm\)/);
      assert.strictEqual(fs.readFileSync(paths.statePath(id), 'utf8'), 'previous\n');
      assert.strictEqual(readOrNull(paths.runtimePath(id)), null);
      assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);
    });
  } finally {
    if (saved === undefined) delete process.env.WATCHTELL_TIMEOUT_MS;
    else process.env.WATCHTELL_TIMEOUT_MS = saved;
    cleanup(home);
  }
});

test('test refuses a tampered checker and leaves no temp dir or runtime behind', () => {
  const home = makeHome();
  try {
    withTmpRoot(home, (tmpRoot) => {
      const marker = path.join(home, 'ran');
      const id = createChecker(`#!/usr/bin/env bash\n: > "${marker}"\n`);
      fs.appendFileSync(paths.scriptPath(id), '# tampered\n');
      const out = capture(() => cli.cmdTest(id));
      assert.strictEqual(out.exitCode, 1);
      assert.match(out.stderr, /refusing to run [0-9a-f]{6}: script hash mismatch/);
      assert.ok(!fs.existsSync(marker), 'tampered bytes never executed');
      assert.strictEqual(readOrNull(paths.runtimePath(id)), null);
      assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);
    });
  } finally {
    cleanup(home);
  }
});

test('test reports a checker removed mid-preview without resurrecting any file', () => {
  const home = makeHome();
  try {
    withTmpRoot(home, (tmpRoot) => {
      const id = createChecker(
        '#!/usr/bin/env bash\n' +
          'for f in "$WATCHTELL_HOME"/checkers/*.meta.json; do\n' +
          '  : > "${f%.meta.json}.removed"\n' +
          'done\n' +
          'printf \'late alarm\\n\'\n'
      );
      const out = capture(() => cli.cmdTest(id));
      assert.strictEqual(out.exitCode, 1);
      assert.match(out.stderr, /was removed during the test/);
      assert.strictEqual(readOrNull(paths.runtimePath(id)), null);
      assert.strictEqual(readOrNull(paths.statePath(id)), null);
      assert.deepStrictEqual(fs.readdirSync(tmpRoot), []);

      // A tombstoned id is no longer testable at all.
      const again = capture(() => cli.cmdTest(id));
      assert.strictEqual(again.exitCode, 1);
      assert.match(again.stderr, /no checker with id/);
    });
  } finally {
    cleanup(home);
  }
});

test('test prints ordinary Unicode transition output unchanged', () => {
  const home = makeHome();
  try {
    withTmpRoot(home, () => {
      const id = createChecker("#!/usr/bin/env bash\nprintf '알림: 상태 변경 ✅ — 완료\\n'\n");
      const out = capture(() => cli.cmdTest(id));
      assert.match(out.stdout, /TRANSITION: 알림: 상태 변경 ✅ — 완료\n/);
    });
  } finally {
    cleanup(home);
  }
});
