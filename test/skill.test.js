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
  const lines = m[1].split('\n');
  const entries = lines
    .filter((line) => line && !/^\s/.test(line))
    .map((line) => {
      const entry = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      assert.ok(entry, `invalid top-level frontmatter line: ${line}`);
      return { key: entry[1], value: entry[2] };
    });

  assert.deepStrictEqual(
    entries.map(({ key }) => key).sort(),
    ['description', 'name'],
    'frontmatter must contain only name and description'
  );

  const name = entries.find(({ key }) => key === 'name').value.trim();
  const descriptionIndex = lines.findIndex((line) => /^description:\s*/.test(line));
  const descriptionHeader = lines[descriptionIndex].replace(/^description:\s*/, '').trim();
  const descriptionLines = /^(?:>|\|)[-+]?$/.test(descriptionHeader)
    ? []
    : [descriptionHeader];

  for (
    let i = descriptionIndex + 1;
    i < lines.length && (lines[i] === '' || /^\s/.test(lines[i]));
    i += 1
  ) {
    descriptionLines.push(lines[i].trim());
  }

  return { name, description: descriptionLines.join(' ').trim() };
}

test('SKILL.md exists', () => {
  assert.ok(fs.existsSync(SKILL_PATH), 'skills/watchtell/SKILL.md must exist');
});

test('frontmatter has a name and a non-empty description within the 1536-char cap', () => {
  const text = readSkill();
  const { name, description } = parseFrontmatter(text);

  assert.strictEqual(name, 'watchtell', "frontmatter name must be 'watchtell'");
  assert.ok(description.length > 0, 'description must be non-empty');
  assert.ok(
    description.length <= 1536,
    `description must be within 1536 chars (was ${description.length})`
  );
});

test('frontmatter description includes content after blank lines', () => {
  const { description } = parseFrontmatter(
    '---\nname: watchtell\ndescription: >-\n  before\n\n  after\n---\n'
  );

  assert.strictEqual(description, 'before  after');
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

test('webhook guidance requires a relay for service-specific schemas', () => {
  const text = readSkill();
  assert.match(text, /endpoint\s+that accepts arbitrary JSON/);
  assert.match(text, /Slack and Discord incoming webhooks reject that schema/);
  assert.match(text, /require `text` and `content`, respectively/);
  assert.match(text, /user-run relay/);
});
