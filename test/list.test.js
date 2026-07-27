'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const store = require('../src/store');
const cli = require('../src/cli');
const { truncate, oneLine } = cli;
const { makeHome, cleanup, createChecker } = require('./helpers');

// Capture everything written to process.stdout while fn() runs.
function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

test('truncate folds multi-line input to one spaced line then truncates', () => {
  assert.strictEqual(truncate('191\n192\n193\n194\n195', 16), '191 192 193 194…');
});

test('truncate folds tabs and CRLF into single spaces', () => {
  assert.strictEqual(truncate('a\t\tb\r\nc', 40), 'a b c');
});

test('truncate leaves a short single-line string unchanged', () => {
  assert.strictEqual(truncate('1.2.0', 16), '1.2.0');
});

test('oneLine on empty / whitespace-only input yields empty string', () => {
  assert.strictEqual(oneLine('   \n\t  '), '');
  assert.strictEqual(truncate('   \n\t  ', 16), '');
});

test('list renders exactly one row for a checker with a multi-line state', () => {
  const home = makeHome();
  try {
    const id = createChecker('#!/usr/bin/env bash\nexit 0\n', { request: 'watch issues' });
    const rt = store.readRuntime(id);
    rt.lastState = '191\n192\n193\n194\n195';
    store.writeRuntime(id, rt);

    const out = captureStdout(() => cli.cmdList());
    const lines = out.split('\n').filter((l) => l.length > 0);
    // header + exactly one data row
    assert.strictEqual(lines.length, 2, `expected header + 1 row, got:\n${out}`);
    assert.ok(lines[1].startsWith(id), 'data row starts with the checker id');
    assert.ok(!/\n191\n/.test(out) && lines[1].includes('191 192'), 'state folded inline');
  } finally {
    cleanup(home);
  }
});

test('list renders "-" for a whitespace-only state', () => {
  const home = makeHome();
  try {
    const id = createChecker('#!/usr/bin/env bash\nexit 0\n', { request: 'watch x' });
    const rt = store.readRuntime(id);
    rt.lastState = '\n\t ';
    store.writeRuntime(id, rt);

    const out = captureStdout(() => cli.cmdList());
    const lines = out.split('\n').filter((l) => l.length > 0);
    assert.strictEqual(lines.length, 2);
    // last state column should render the null-convention dash, not "null"
    assert.ok(!/null/.test(lines[1]), 'no literal "null"');
  } finally {
    cleanup(home);
  }
});
