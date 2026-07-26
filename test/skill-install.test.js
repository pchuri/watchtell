'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const skillInstall = require('../src/skill-install');
const { skillInstallSummary } = require('../src/cli');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watchtell-skill-'));
}

// A stand-in source dir so tests never depend on the real clone layout.
function tmpSource(root) {
  const src = path.join(root, 'clone', 'skills', 'watchtell');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '# skill');
  return src;
}

test('skillSourceDir resolves to this clone\'s skills/watchtell and exists', () => {
  const src = skillInstall.skillSourceDir();
  assert.ok(path.isAbsolute(src));
  assert.match(src, /skills\/watchtell$/);
  assert.ok(fs.existsSync(path.join(src, 'SKILL.md')), 'points at the real skill');
});

test('fresh install creates correct symlinks for both agents by default', () => {
  const root = tmpHome();
  const source = tmpSource(root);
  const homeDir = path.join(root, 'home');
  try {
    const results = skillInstall.install({ homeDir, source });
    assert.deepStrictEqual(results.map((r) => r.key).sort(), ['claude', 'codex']);
    for (const r of results) {
      assert.strictEqual(r.status, 'installed');
      const st = fs.lstatSync(r.linkPath);
      assert.ok(st.isSymbolicLink(), 'a symlink was created');
      assert.strictEqual(fs.readlinkSync(r.linkPath), source, 'points at the source');
    }
    assert.strictEqual(
      results.find((r) => r.key === 'claude').linkPath,
      path.join(homeDir, '.claude', 'skills', 'watchtell')
    );
    assert.strictEqual(
      results.find((r) => r.key === 'codex').linkPath,
      path.join(homeDir, '.codex', 'skills', 'watchtell')
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('re-install is idempotent (already installed, same link)', () => {
  const root = tmpHome();
  const source = tmpSource(root);
  const homeDir = path.join(root, 'home');
  try {
    skillInstall.install({ homeDir, source });
    const again = skillInstall.install({ homeDir, source });
    for (const r of again) {
      assert.strictEqual(r.status, 'already-installed');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a real directory at the target is skipped, never overwritten', () => {
  const root = tmpHome();
  const source = tmpSource(root);
  const homeDir = path.join(root, 'home');
  const target = path.join(homeDir, '.claude', 'skills', 'watchtell');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'keep.txt'), 'precious');
  try {
    const results = skillInstall.install({ homeDir, source, keys: ['claude'] });
    assert.strictEqual(results[0].status, 'skipped');
    assert.match(results[0].message, /real directory/);
    assert.match(results[0].message, /backup/i);
    assert.doesNotMatch(results[0].message, /rm -rf/);
    // Untouched: still a real dir with its file.
    assert.ok(fs.lstatSync(target).isDirectory());
    assert.strictEqual(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'precious');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a foreign symlink at the target is skipped, not overwritten', () => {
  const root = tmpHome();
  const source = tmpSource(root);
  const other = path.join(root, 'somewhere-else');
  fs.mkdirSync(other, { recursive: true });
  const homeDir = path.join(root, 'home');
  const target = path.join(homeDir, '.codex', 'skills', 'watchtell');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(other, target);
  try {
    const results = skillInstall.install({ homeDir, source, keys: ['codex'] });
    assert.strictEqual(results[0].status, 'skipped');
    assert.match(results[0].message, /different symlink/);
    assert.strictEqual(fs.readlinkSync(target), other, 'foreign link preserved');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uninstall removes only our symlink and is idempotent when absent', () => {
  const root = tmpHome();
  const source = tmpSource(root);
  const homeDir = path.join(root, 'home');
  try {
    skillInstall.install({ homeDir, source });
    const removed = skillInstall.uninstall({ homeDir, source });
    for (const r of removed) {
      assert.strictEqual(r.status, 'removed');
      assert.ok(!fs.existsSync(r.linkPath));
    }
    const again = skillInstall.uninstall({ homeDir, source });
    for (const r of again) {
      assert.strictEqual(r.status, 'absent');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical path identity is shared by install, status, and uninstall', () => {
  const root = tmpHome();
  const source = tmpSource(root);
  const sourceAliasRoot = path.join(root, 'clone-alias');
  const sourceAlias = path.join(sourceAliasRoot, 'skills', 'watchtell');
  const homeDir = path.join(root, 'home');
  const target = path.join(homeDir, '.claude', 'skills', 'watchtell');
  fs.symlinkSync(path.join(root, 'clone'), sourceAliasRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(source, target);

  try {
    const installed = skillInstall.install({ homeDir, source: sourceAlias, keys: ['claude'] });
    assert.strictEqual(installed[0].status, 'already-installed');

    const currentStatus = skillInstall.status({ homeDir, source: sourceAlias, keys: ['claude'] });
    assert.strictEqual(currentStatus[0].status, 'installed');

    const uninstalled = skillInstall.uninstall({
      homeDir,
      source: sourceAlias,
      keys: ['claude'],
    });
    assert.strictEqual(uninstalled[0].status, 'removed');
    assert.ok(!fs.existsSync(target));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uninstall refuses a real directory and a foreign symlink (without --force)', () => {
  const root = tmpHome();
  const source = tmpSource(root);
  const other = path.join(root, 'elsewhere');
  fs.mkdirSync(other, { recursive: true });
  const homeDir = path.join(root, 'home');

  const realTarget = path.join(homeDir, '.claude', 'skills', 'watchtell');
  fs.mkdirSync(realTarget, { recursive: true });
  const foreignTarget = path.join(homeDir, '.codex', 'skills', 'watchtell');
  fs.mkdirSync(path.dirname(foreignTarget), { recursive: true });
  fs.symlinkSync(other, foreignTarget);

  try {
    const results = skillInstall.uninstall({ homeDir, source });
    const claude = results.find((r) => r.key === 'claude');
    const codex = results.find((r) => r.key === 'codex');
    assert.strictEqual(claude.status, 'skipped');
    assert.ok(fs.lstatSync(realTarget).isDirectory(), 'real dir untouched');
    assert.strictEqual(codex.status, 'skipped');
    assert.strictEqual(fs.readlinkSync(foreignTarget), other, 'foreign link untouched');

    // --force removes any watchtell symlink, but still never a real dir.
    const forced = skillInstall.uninstall({ homeDir, source, force: true });
    assert.strictEqual(forced.find((r) => r.key === 'codex').status, 'removed');
    assert.ok(!fs.existsSync(foreignTarget));
    assert.strictEqual(forced.find((r) => r.key === 'claude').status, 'skipped');
    assert.ok(fs.lstatSync(realTarget).isDirectory(), 'real dir still untouched under --force');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('status reports installed, foreign, real path, and not-installed accurately', () => {
  const root = tmpHome();
  const source = tmpSource(root);
  const other = path.join(root, 'other-clone');
  fs.mkdirSync(other, { recursive: true });
  const homeDir = path.join(root, 'home');
  try {
    // claude: our symlink; codex: not installed
    skillInstall.install({ homeDir, source, keys: ['claude'] });
    let results = skillInstall.status({ homeDir, source });
    assert.strictEqual(results.find((r) => r.key === 'claude').status, 'installed');
    assert.strictEqual(results.find((r) => r.key === 'claude').points, source);
    assert.strictEqual(results.find((r) => r.key === 'codex').status, 'not-installed');

    // codex: foreign symlink
    const codexTarget = path.join(homeDir, '.codex', 'skills', 'watchtell');
    fs.mkdirSync(path.dirname(codexTarget), { recursive: true });
    fs.symlinkSync(other, codexTarget);
    results = skillInstall.status({ homeDir, source });
    assert.strictEqual(results.find((r) => r.key === 'codex').status, 'installed-other');
    assert.strictEqual(results.find((r) => r.key === 'codex').points, other);

    // codex: real path (replace the link)
    fs.rmSync(codexTarget);
    fs.mkdirSync(codexTarget);
    results = skillInstall.status({ homeDir, source });
    assert.strictEqual(results.find((r) => r.key === 'codex').status, 'real-path');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('status propagates filesystem errors other than missing paths', () => {
  const root = tmpHome();
  const source = tmpSource(root);
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.claude'), 'not a directory');
  try {
    assert.throws(
      () => skillInstall.status({ homeDir, source, keys: ['claude'] }),
      (error) => error.code === 'ENOTDIR'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install summary prints executable fallback commands for selected targets', () => {
  const source = '/clone/skills/watchtell';
  const claude = {
    status: 'installed',
    linkPath: '/home/test/.claude/skills/watchtell',
  };
  const codex = {
    status: 'skipped',
    linkPath: '/home/test/.codex/skills/watchtell',
  };
  const both = skillInstallSummary([claude, codex], source);
  assert.match(both, /Symlinked from/);
  assert.match(both, /mkdir -p "\/home\/test\/\.claude\/skills"/);
  assert.match(both, /ln -s "\/clone\/skills\/watchtell" "\/home\/test\/\.claude\/skills\/watchtell"/);
  assert.match(both, /mkdir -p "\/home\/test\/\.codex\/skills"/);
  assert.match(both, /ln -s "\/clone\/skills\/watchtell" "\/home\/test\/\.codex\/skills\/watchtell"/);

  const codexOnly = skillInstallSummary([codex], source);
  assert.doesNotMatch(codexOnly, /Symlinked from/);
  assert.doesNotMatch(codexOnly, /\.claude/);
  assert.match(codexOnly, /\.codex/);
});

test('--claude / --codex limiting selects only the requested agent', () => {
  const root = tmpHome();
  const source = tmpSource(root);
  const homeDir = path.join(root, 'home');
  try {
    const claudeOnly = skillInstall.install({ homeDir, source, keys: ['claude'] });
    assert.deepStrictEqual(claudeOnly.map((r) => r.key), ['claude']);
    assert.ok(fs.existsSync(path.join(homeDir, '.claude', 'skills', 'watchtell')));
    assert.ok(!fs.existsSync(path.join(homeDir, '.codex', 'skills', 'watchtell')));

    const codexOnly = skillInstall.install({ homeDir, source, keys: ['codex'] });
    assert.deepStrictEqual(codexOnly.map((r) => r.key), ['codex']);
    assert.ok(fs.existsSync(path.join(homeDir, '.codex', 'skills', 'watchtell')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
