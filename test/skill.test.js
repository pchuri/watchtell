'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SKILL_PATH = path.join(__dirname, '..', 'skills', 'watchtell', 'SKILL.md');

function readSkill() {
  return fs.readFileSync(SKILL_PATH, 'utf8');
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, 'SKILL.md must start with a YAML frontmatter block');
  const body = m[1];
  const name = body.match(/^name:\s*(.+)$/m);
  // description may be a YAML block scalar (`>-`) spanning indented lines.
  const desc = body.match(/^description:\s*(>[-+]?|\|[-+]?)?\s*\n?([\s\S]*)$/m);
  return { name: name && name[1].trim(), descRaw: desc && desc[2] };
}

test('SKILL.md exists', () => {
  assert.ok(fs.existsSync(SKILL_PATH), 'skills/watchtell/SKILL.md must exist');
});

test('frontmatter has a name and a non-empty description within the 1536-char cap', () => {
  const text = readSkill();
  const { name, descRaw } = parseFrontmatter(text);

  assert.strictEqual(name, 'watchtell', "frontmatter name must be 'watchtell'");

  assert.ok(descRaw, 'frontmatter must have a description');
  // Collapse the block scalar's indentation + line breaks into the effective text.
  const description = descRaw
    .split('\n')
    .map((l) => l.trim())
    .join(' ')
    .trim();
  assert.ok(description.length > 0, 'description must be non-empty');
  assert.ok(
    description.length <= 1536,
    `description must be within 1536 chars (was ${description.length})`
  );
});

test('body mentions the real watchtell command names', () => {
  const text = readSkill();
  for (const cmd of ['add', 'list', 'test', 'rm', 'daemon']) {
    assert.ok(
      new RegExp(`watchtell ${cmd}\\b`).test(text),
      `SKILL.md must reference 'watchtell ${cmd}'`
    );
  }
});
