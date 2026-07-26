'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const notify = require('../src/notify');

const FAKE_TN = path.join(__dirname, 'fixtures', 'fake-terminal-notifier.sh');

// --- extractOpenUrl: pure ---------------------------------------------------

test('extractOpenUrl picks the first URL', () => {
  assert.strictEqual(
    notify.extractOpenUrl('see https://example.com/x then http://other.com'),
    'https://example.com/x'
  );
});

test('extractOpenUrl trims trailing punctuation', () => {
  assert.strictEqual(
    notify.extractOpenUrl('release at https://github.com/pchuri/watchtell.'),
    'https://github.com/pchuri/watchtell'
  );
  assert.strictEqual(
    notify.extractOpenUrl('(see https://example.com/path)'),
    'https://example.com/path'
  );
  assert.strictEqual(
    notify.extractOpenUrl('done: https://example.com/a,'),
    'https://example.com/a'
  );
});

test('extractOpenUrl returns null when no URL is present', () => {
  assert.strictEqual(notify.extractOpenUrl('probe entered ALARM state'), null);
  assert.strictEqual(notify.extractOpenUrl('ftp://not-http.com'), null);
  assert.strictEqual(notify.extractOpenUrl(''), null);
});

// --- buildTerminalNotifierArgs: pure ----------------------------------------

test('buildTerminalNotifierArgs includes -open when the message has a URL', () => {
  const args = notify.buildTerminalNotifierArgs({
    title: 'watchtell: release',
    message: 'new release https://example.com/x is out',
  });
  assert.deepStrictEqual(args, [
    '-title', 'watchtell: release',
    '-message', 'new release https://example.com/x is out',
    '-open', 'https://example.com/x',
  ]);
  // args is a real array of discrete values, never a shell string.
  assert.ok(Array.isArray(args));
  assert.ok(!args.some((a) => a.includes("' ")), 'no shell quoting artifacts');
});

test('buildTerminalNotifierArgs omits -open when the message has no URL', () => {
  const args = notify.buildTerminalNotifierArgs({
    title: 'watchtell: probe',
    message: 'probe entered ALARM state',
  });
  assert.deepStrictEqual(args, [
    '-title', 'watchtell: probe',
    '-message', 'probe entered ALARM state',
  ]);
  assert.ok(!args.includes('-open'));
});

// --- dispatch: terminal-notifier present ------------------------------------

test('dispatch uses terminal-notifier with an args array (URL -> -open)', () => {
  const argvFile = tmpFile();
  process.env.FAKE_TN_ARGV = argvFile;
  try {
    const res = notify.dispatch(
      'notify',
      'watchtell: release',
      'new release https://example.com/x is out',
      { terminalNotifierPath: FAKE_TN }
    );
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.route, 'notify');
    assert.strictEqual(res.requestedRoute, 'notify');
    const argv = fs.readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
    assert.deepStrictEqual(argv, [
      '-title', 'watchtell: release',
      '-message', 'new release https://example.com/x is out',
      '-open', 'https://example.com/x',
    ]);
  } finally {
    delete process.env.FAKE_TN_ARGV;
    fs.rmSync(argvFile, { force: true });
  }
});

test('dispatch via terminal-notifier omits -open when no URL', () => {
  const argvFile = tmpFile();
  process.env.FAKE_TN_ARGV = argvFile;
  try {
    const res = notify.dispatch(
      'notify',
      'watchtell: probe',
      'probe entered ALARM state',
      { terminalNotifierPath: FAKE_TN }
    );
    assert.strictEqual(res.ok, true);
    const argv = fs.readFileSync(argvFile, 'utf8').split('\n').filter(Boolean);
    assert.ok(!argv.includes('-open'), 'no -open flag when message has no URL');
    assert.deepStrictEqual(argv, [
      '-title', 'watchtell: probe',
      '-message', 'probe entered ALARM state',
    ]);
  } finally {
    delete process.env.FAKE_TN_ARGV;
    fs.rmSync(argvFile, { force: true });
  }
});

// --- dispatch: fallback + override ------------------------------------------

test('dispatch falls back to osascript when terminal-notifier is absent', () => {
  // terminalNotifierPath: null forces the fallback branch. osascript is invoked;
  // ok reflects its exit status (typically non-zero in a headless test env, but
  // the assertion here is that we did NOT go through terminal-notifier).
  const argvFile = tmpFile();
  process.env.FAKE_TN_ARGV = argvFile;
  try {
    const res = notify.dispatch('notify', 'title', 'msg https://example.com', {
      terminalNotifierPath: null,
    });
    assert.strictEqual(res.route, 'notify');
    assert.strictEqual(res.requestedRoute, 'notify');
    assert.ok(!fs.existsSync(argvFile), 'fake terminal-notifier was not invoked');
  } finally {
    delete process.env.FAKE_TN_ARGV;
    fs.rmSync(argvFile, { force: true });
  }
});

test('WATCHTELL_NOTIFY_CMD override wins over terminal-notifier', () => {
  const log = tmpFile();
  process.env.WATCHTELL_NOTIFY_CMD =
    `printf '%s|%s|%s\\n' "$WATCHTELL_ROUTE" "$WATCHTELL_TITLE" "$WATCHTELL_MESSAGE" >> ${log}`;
  const argvFile = tmpFile();
  process.env.FAKE_TN_ARGV = argvFile;
  try {
    const res = notify.dispatch('notify', 'watchtell: t', 'body https://example.com', {
      terminalNotifierPath: FAKE_TN,
    });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(
      fs.readFileSync(log, 'utf8').trim(),
      'notify|watchtell: t|body https://example.com'
    );
    assert.ok(!fs.existsSync(argvFile), 'override wins; terminal-notifier untouched');
  } finally {
    delete process.env.WATCHTELL_NOTIFY_CMD;
    delete process.env.FAKE_TN_ARGV;
    fs.rmSync(log, { force: true });
    fs.rmSync(argvFile, { force: true });
  }
});

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchtell-notify-')), 'f');
}
