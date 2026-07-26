'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const launchd = require('../src/launchd');

test('buildPlist produces well-formed XML with the required keys and values', () => {
  const xml = launchd.buildPlist({
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/watchtell/bin/watchtell.js',
    logPath: '/Users/me/.watchtell/daemon.log',
    watchtellHome: null,
  });

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /<!DOCTYPE plist PUBLIC/);
  assert.match(xml, /<key>Label<\/key>\s*<string>com\.watchtell\.daemon<\/string>/);

  // ProgramArguments: node + script + daemon start --foreground, in order.
  const argsBlock = xml.match(/<array>([\s\S]*?)<\/array>/)[1];
  const strings = [...argsBlock.matchAll(/<string>(.*?)<\/string>/g)].map((m) => m[1]);
  assert.deepStrictEqual(strings, [
    '/usr/local/bin/node',
    '/opt/watchtell/bin/watchtell.js',
    'daemon',
    'start',
    '--foreground',
  ]);

  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>StandardOutPath<\/key>\s*<string>\/Users\/me\/\.watchtell\/daemon\.log<\/string>/);
  assert.match(xml, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/me\/\.watchtell\/daemon\.log<\/string>/);

  // No home override -> no EnvironmentVariables / WorkingDirectory block.
  assert.doesNotMatch(xml, /EnvironmentVariables/);
  assert.doesNotMatch(xml, /WorkingDirectory/);
});

test('buildPlist includes WATCHTELL_HOME and WorkingDirectory when a home override is set', () => {
  const xml = launchd.buildPlist({
    nodePath: '/usr/bin/node',
    scriptPath: '/bin/watchtell.js',
    logPath: '/tmp/home/daemon.log',
    watchtellHome: '/tmp/home',
  });
  assert.match(
    xml,
    /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>WATCHTELL_HOME<\/key>\s*<string>\/tmp\/home<\/string>\s*<\/dict>/
  );
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/tmp\/home<\/string>/);
});

test('buildPlist XML-escapes special characters in paths (no XML injection)', () => {
  const xml = launchd.buildPlist({
    nodePath: '/usr/bin/node',
    scriptPath: '/opt/a & b/<x>/"q"/watchtell.js',
    logPath: "/tmp/o'brien/daemon.log",
    watchtellHome: '/tmp/a&b',
  });
  assert.match(xml, /<string>\/opt\/a &amp; b\/&lt;x&gt;\/&quot;q&quot;\/watchtell\.js<\/string>/);
  assert.match(xml, /<string>\/tmp\/o&apos;brien\/daemon\.log<\/string>/);
  assert.match(xml, /<string>\/tmp\/a&amp;b<\/string>/);
  // Raw, unescaped metacharacters must not leak into the document.
  assert.ok(!xml.includes('a & b'), 'ampersand escaped');
  assert.ok(!xml.includes('<x>'), 'angle brackets escaped');
});

test('platform guard: install/uninstall are macOS-only and do not touch launchctl or the filesystem', () => {
  let launchctlCalls = 0;
  const spy = () => (launchctlCalls++, { status: 0, stdout: '', stderr: '' });
  const tmp = path.join(os.tmpdir(), 'watchtell-should-not-exist.plist');

  const ins = launchd.install({ platform: 'linux', plistPath: tmp, launchctlFn: spy });
  assert.strictEqual(ins.unsupported, true);
  assert.strictEqual(ins.message, launchd.UNSUPPORTED_MESSAGE);
  assert.match(ins.message, /macOS-only/);

  const uni = launchd.uninstall({ platform: 'linux', plistPath: tmp, launchctlFn: spy });
  assert.strictEqual(uni.unsupported, true);
  assert.strictEqual(uni.message, launchd.UNSUPPORTED_MESSAGE);

  assert.strictEqual(launchctlCalls, 0, 'launchctl never invoked on non-darwin');
  assert.strictEqual(fs.existsSync(tmp), false, 'no plist written on non-darwin');
});

test('install writes the plist and bootstraps it; uninstall removes it (isolated, launchctl mocked)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtell-launchd-'));
  const file = path.join(dir, 'com.watchtell.daemon.plist');
  const calls = [];
  const spy = (args) => (calls.push(args), { status: 0, stdout: '', stderr: '' });
  try {
    const res = launchd.install({ platform: 'darwin', plistPath: file, launchctlFn: spy });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.plistPath, file);
    assert.strictEqual(res.loaded, true);
    assert.ok(fs.existsSync(file), 'plist written');
    const xml = fs.readFileSync(file, 'utf8');
    assert.match(xml, /<key>Label<\/key>\s*<string>com\.watchtell\.daemon<\/string>/);
    assert.match(xml, /--foreground/);
    // bootout (cleanup) then bootstrap (load).
    assert.deepStrictEqual(calls.map((c) => c[0]), ['bootout', 'bootstrap']);
    assert.ok(calls.every((c) => c[2] === file), 'launchctl targets the plist path');

    const uni = launchd.uninstall({ platform: 'darwin', plistPath: file, launchctlFn: spy });
    assert.strictEqual(uni.ok, true);
    assert.strictEqual(uni.existed, true);
    assert.strictEqual(fs.existsSync(file), false, 'plist removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstall is idempotent when the plist is absent (no launchctl call, success)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtell-launchd-'));
  const file = path.join(dir, 'com.watchtell.daemon.plist');
  let launchctlCalls = 0;
  const spy = () => (launchctlCalls++, { status: 0, stdout: '', stderr: '' });
  try {
    const uni = launchd.uninstall({ platform: 'darwin', plistPath: file, launchctlFn: spy });
    assert.strictEqual(uni.ok, true);
    assert.strictEqual(uni.existed, false);
    assert.strictEqual(launchctlCalls, 0, 'no launchctl call when nothing to unload');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveInstallSpec picks up the WATCHTELL_HOME override and absolute paths', () => {
  const saved = process.env.WATCHTELL_HOME;
  try {
    process.env.WATCHTELL_HOME = '/tmp/custom-home';
    const spec = launchd.resolveInstallSpec();
    assert.strictEqual(spec.nodePath, process.execPath);
    assert.ok(path.isAbsolute(spec.scriptPath));
    assert.match(spec.scriptPath, /bin\/watchtell\.js$/);
    assert.strictEqual(spec.watchtellHome, '/tmp/custom-home');
    assert.strictEqual(spec.logPath, path.join('/tmp/custom-home', 'daemon.log'));
  } finally {
    if (saved === undefined) delete process.env.WATCHTELL_HOME;
    else process.env.WATCHTELL_HOME = saved;
  }
});
