'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const launchd = require('../src/launchd');
const daemon = require('../src/daemon');
const cli = require('../src/cli');

test('buildPlist produces well-formed XML with the required keys and values', () => {
  const xml = launchd.buildPlist({
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/watchtell/bin/watchtell.js',
    logPath: '/Users/me/.watchtell/daemon.log',
    watchtellHome: null,
    environmentPath: '/opt/homebrew/bin:/usr/bin:/bin',
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

  assert.match(
    xml,
    /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>\s*<\/dict>/
  );
  assert.doesNotMatch(xml, /WorkingDirectory/);
  assert.doesNotMatch(xml, /WATCHTELL_HOME/);
});

test('buildPlist includes WATCHTELL_HOME and WorkingDirectory when a home override is set', () => {
  const xml = launchd.buildPlist({
    nodePath: '/usr/bin/node',
    scriptPath: '/bin/watchtell.js',
    logPath: '/tmp/home/daemon.log',
    watchtellHome: '/tmp/home',
    environmentPath: '/custom/bin:/usr/bin',
  });
  assert.match(
    xml,
    /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>\s*<string>\/custom\/bin:\/usr\/bin<\/string>\s*<key>WATCHTELL_HOME<\/key>\s*<string>\/tmp\/home<\/string>\s*<\/dict>/
  );
  assert.match(xml, /<key>WorkingDirectory<\/key>\s*<string>\/tmp\/home<\/string>/);
});

test('buildPlist XML-escapes special characters in paths (no XML injection)', () => {
  const xml = launchd.buildPlist({
    nodePath: '/usr/bin/node',
    scriptPath: '/opt/a & b/<x>/"q"/watchtell.js',
    logPath: "/tmp/o'brien/daemon.log",
    watchtellHome: '/tmp/a&b',
    environmentPath: '/opt/a&b/bin:/usr/bin',
  });
  assert.match(xml, /<string>\/opt\/a &amp; b\/&lt;x&gt;\/&quot;q&quot;\/watchtell\.js<\/string>/);
  assert.match(xml, /<string>\/tmp\/o&apos;brien\/daemon\.log<\/string>/);
  assert.match(xml, /<string>\/tmp\/a&amp;b<\/string>/);
  assert.match(xml, /<string>\/opt\/a&amp;b\/bin:\/usr\/bin<\/string>/);
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
  const savedHome = process.env.WATCHTELL_HOME;
  try {
    const home = path.join(dir, 'runtime');
    process.env.WATCHTELL_HOME = home;
    const res = launchd.install({ platform: 'darwin', plistPath: file, launchctlFn: spy });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.plistPath, file);
    assert.strictEqual(res.loaded, true);
    assert.ok(fs.existsSync(file), 'plist written');
    assert.ok(fs.existsSync(home), 'runtime home created');
    const xml = fs.readFileSync(file, 'utf8');
    assert.match(xml, /<key>Label<\/key>\s*<string>com\.watchtell\.daemon<\/string>/);
    assert.match(xml, /--foreground/);
    // bootout (cleanup) then bootstrap (load).
    assert.deepStrictEqual(calls.map((c) => c[0]), ['bootout', 'bootstrap']);
    assert.ok(calls.every((c) => c[2] === file), 'launchctl targets the plist path');

    calls.length = 0;
    const uni = launchd.uninstall({ platform: 'darwin', plistPath: file, launchctlFn: spy });
    assert.strictEqual(uni.ok, true);
    assert.strictEqual(uni.existed, true);
    assert.strictEqual(fs.existsSync(file), false, 'plist removed');
    assert.deepStrictEqual(calls, [['bootout', `gui/${process.getuid()}/${launchd.LABEL}`]]);
  } finally {
    if (savedHome === undefined) delete process.env.WATCHTELL_HOME;
    else process.env.WATCHTELL_HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install reports bootstrap failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtell-launchd-'));
  const file = path.join(dir, 'com.watchtell.daemon.plist');
  const savedHome = process.env.WATCHTELL_HOME;
  const spy = (args) =>
    args[0] === 'bootstrap'
      ? { status: 5, stdout: '', stderr: 'bootstrap denied' }
      : { status: 0, stdout: '', stderr: '' };
  try {
    process.env.WATCHTELL_HOME = path.join(dir, 'runtime');
    const result = launchd.install({ platform: 'darwin', plistPath: file, launchctlFn: spy });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.loaded, false);
    assert.match(result.message, /launchctl bootstrap failed: bootstrap denied/);
    assert.strictEqual(fs.existsSync(file), false);
  } finally {
    if (savedHome === undefined) delete process.env.WATCHTELL_HOME;
    else process.env.WATCHTELL_HOME = savedHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstall is idempotent when the plist and service are absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtell-launchd-'));
  const file = path.join(dir, 'com.watchtell.daemon.plist');
  const calls = [];
  const spy = (args) => (calls.push(args), { status: 3, stdout: '', stderr: 'service not found' });
  try {
    const uni = launchd.uninstall({ platform: 'darwin', plistPath: file, launchctlFn: spy });
    assert.strictEqual(uni.ok, true);
    assert.strictEqual(uni.existed, false);
    assert.deepStrictEqual(calls.map((args) => args[0]), ['bootout', 'print']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('uninstall keeps the plist when launchctl cannot unload a loaded service', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtell-launchd-'));
  const file = path.join(dir, 'com.watchtell.daemon.plist');
  fs.writeFileSync(file, 'plist');
  const spy = (args) =>
    args[0] === 'print'
      ? { status: 0, stdout: 'loaded', stderr: '' }
      : { status: 5, stdout: '', stderr: 'operation not permitted' };
  try {
    const result = launchd.uninstall({ platform: 'darwin', plistPath: file, launchctlFn: spy });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.loaded, true);
    assert.match(result.message, /launchctl bootout failed: operation not permitted/);
    assert.strictEqual(fs.existsSync(file), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveInstallSpec picks up the WATCHTELL_HOME override and absolute paths', () => {
  const saved = process.env.WATCHTELL_HOME;
  const savedPath = process.env.PATH;
  try {
    process.env.WATCHTELL_HOME = '/tmp/custom-home';
    process.env.PATH = '/custom/bin:/usr/bin';
    const spec = launchd.resolveInstallSpec();
    assert.strictEqual(spec.nodePath, process.execPath);
    assert.ok(path.isAbsolute(spec.scriptPath));
    assert.match(spec.scriptPath, /bin\/watchtell\.js$/);
    assert.strictEqual(spec.watchtellHome, '/tmp/custom-home');
    assert.strictEqual(spec.homePath, '/tmp/custom-home');
    assert.strictEqual(spec.logPath, path.join('/tmp/custom-home', 'daemon.log'));
    assert.strictEqual(spec.environmentPath, '/custom/bin:/usr/bin');
  } finally {
    if (saved === undefined) delete process.env.WATCHTELL_HOME;
    else process.env.WATCHTELL_HOME = saved;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});

test('resolveInstallSpec makes a relative WATCHTELL_HOME absolute', () => {
  const saved = process.env.WATCHTELL_HOME;
  try {
    process.env.WATCHTELL_HOME = 'relative-watchtell-home';
    const expectedHome = path.resolve('relative-watchtell-home');
    const spec = launchd.resolveInstallSpec();
    assert.strictEqual(spec.watchtellHome, expectedHome);
    assert.strictEqual(spec.homePath, expectedHome);
    assert.strictEqual(spec.logPath, path.join(expectedHome, 'daemon.log'));
  } finally {
    if (saved === undefined) delete process.env.WATCHTELL_HOME;
    else process.env.WATCHTELL_HOME = saved;
  }
});

test('daemon install stops before writing a LaunchAgent when the detached daemon survives', () => {
  const original = {
    isSupportedPlatform: launchd.isSupportedPlatform,
    install: launchd.install,
    status: daemon.status,
    stop: daemon.stop,
    stderrWrite: process.stderr.write,
    exitCode: process.exitCode,
  };
  let installCalled = false;
  let stderr = '';
  try {
    launchd.isSupportedPlatform = () => true;
    launchd.install = () => (installCalled = true, { ok: true });
    daemon.status = () => ({ running: true, pid: 42, stale: false });
    daemon.stop = () => ({ stopped: false, running: true, pid: 42 });
    process.stderr.write = (value) => (stderr += value, true);
    process.exitCode = undefined;

    cli.cmdDaemon('install', {});

    assert.strictEqual(installCalled, false);
    assert.strictEqual(process.exitCode, 1);
    assert.match(stderr, /daemon did not stop \(pid 42\); LaunchAgent not installed/);
  } finally {
    launchd.isSupportedPlatform = original.isSupportedPlatform;
    launchd.install = original.install;
    daemon.status = original.status;
    daemon.stop = original.stop;
    process.stderr.write = original.stderrWrite;
    process.exitCode = original.exitCode;
  }
});

test('daemon install and uninstall surface launchctl failures', () => {
  const original = {
    isSupportedPlatform: launchd.isSupportedPlatform,
    install: launchd.install,
    uninstall: launchd.uninstall,
    status: daemon.status,
    stderrWrite: process.stderr.write,
    exitCode: process.exitCode,
  };
  let stderr = '';
  try {
    launchd.isSupportedPlatform = () => true;
    daemon.status = () => ({ running: false, pid: null, stale: false });
    launchd.install = () => ({ ok: false, message: 'bootstrap failed' });
    launchd.uninstall = () => ({ ok: false, message: 'bootout failed' });
    process.stderr.write = (value) => (stderr += value, true);
    process.exitCode = undefined;

    cli.cmdDaemon('install', {});
    cli.cmdDaemon('uninstall', {});

    assert.strictEqual(process.exitCode, 1);
    assert.match(stderr, /watchtell: bootstrap failed/);
    assert.match(stderr, /watchtell: bootout failed/);
  } finally {
    launchd.isSupportedPlatform = original.isSupportedPlatform;
    launchd.install = original.install;
    launchd.uninstall = original.uninstall;
    daemon.status = original.status;
    process.stderr.write = original.stderrWrite;
    process.exitCode = original.exitCode;
  }
});
