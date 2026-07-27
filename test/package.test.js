'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readPkg() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
}

test('package.json ships bin, src, and skills so a global install works', () => {
  const pkg = readPkg();
  const files = pkg.files || [];
  for (const entry of ['bin/', 'src/', 'skills/', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(entry), `package.json "files" must include ${entry}`);
  }
});

test('package.json exposes the watchtell bin and requires node >=20', () => {
  const pkg = readPkg();
  assert.strictEqual(pkg.bin && pkg.bin.watchtell, 'bin/watchtell.js');
  assert.ok(pkg.engines && /(>=\s*20|\^?20|20)/.test(pkg.engines.node), 'engines.node must require node 20+');
});

test('the shipped bin, skill, and LICENSE exist on disk', () => {
  for (const rel of ['bin/watchtell.js', 'skills/watchtell/SKILL.md', 'LICENSE']) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} must exist`);
  }
});
