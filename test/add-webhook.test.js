'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cli = require('../src/cli');
const store = require('../src/store');
const { makeHome, cleanup, FAKE_COMPILER } = require('./helpers');

// Capture stdout across an async body and return the collected string.
async function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (chunk) => (chunks.push(String(chunk)), true);
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

const SLACK_URL = 'https://hooks.slack.com/services/T000/B000/SECRETPART';

test('add --webhook stores route=webhook + URL in meta and redacts the URL in output', async () => {
  const home = makeHome();
  process.env.WATCHTELL_COMPILER_CMD = FAKE_COMPILER;
  try {
    const out = await captureStdout(() =>
      cli.cmdAdd('ping me when CI goes red', { yes: true, webhook: SLACK_URL })
    );

    const ids = store.listIds();
    assert.strictEqual(ids.length, 1, 'exactly one checker kept');
    const meta = store.readMeta(ids[0]);
    assert.strictEqual(meta.route, 'webhook');
    assert.strictEqual(meta.webhookUrl, SLACK_URL);

    // Output announces the webhook route and the redacted host, never the secret path.
    assert.match(out, /route=webhook/);
    assert.match(out, /webhook: https:\/\/hooks\.slack\.com \(path redacted\)/);
    assert.ok(!out.includes('SECRETPART'), 'secret path never printed');
    assert.ok(!out.includes('not yet supported'), 'no "unsupported route" note for webhook');
  } finally {
    delete process.env.WATCHTELL_COMPILER_CMD;
    cleanup(home);
  }
});

test('add rejects an invalid --webhook URL before compiling (no checker, no compile)', async () => {
  const home = makeHome();
  const marker = path.join(home, 'compiler-ran');
  // If the compiler runs, it touches the marker; a fast-fail must not.
  process.env.WATCHTELL_COMPILER_CMD = `touch ${marker}; ${FAKE_COMPILER}`;
  const savedExit = process.exitCode;
  try {
    process.exitCode = 0;
    const errs = [];
    const invalidUrl = 'ftp://nope/SECRETPART';
    const origErr = process.stderr.write;
    process.stderr.write = (c) => (errs.push(String(c)), true);
    try {
      await cli.cmdAdd('ping me when CI goes red', { yes: true, webhook: invalidUrl });
    } finally {
      process.stderr.write = origErr;
    }
    assert.strictEqual(process.exitCode, 1, 'add failed');
    assert.match(errs.join(''), /http or https/);
    assert.ok(!errs.join('').includes(invalidUrl), 'invalid URL is not printed');
    assert.strictEqual(store.listIds().length, 0, 'no checker written');
    assert.ok(!fs.existsSync(marker), 'compiler was never invoked');
  } finally {
    process.exitCode = savedExit;
    delete process.env.WATCHTELL_COMPILER_CMD;
    cleanup(home);
  }
});

test('compiler-emitted webhook route without --webhook falls back to notify presentation', async () => {
  const home = makeHome();
  process.env.WATCHTELL_COMPILER_CMD = FAKE_COMPILER;
  process.env.FAKE_ROUTE = 'webhook';
  try {
    const out = await captureStdout(() =>
      cli.cmdAdd('ping me when CI goes red', { yes: true })
    );
    const meta = store.readMeta(store.listIds()[0]);
    assert.strictEqual(meta.route, 'webhook');
    assert.strictEqual(meta.webhookUrl, undefined);
    assert.match(out, /route 'webhook' not yet supported, using notify/);
    assert.doesNotMatch(out, /^  webhook:/m);
  } finally {
    delete process.env.FAKE_ROUTE;
    delete process.env.WATCHTELL_COMPILER_CMD;
    cleanup(home);
  }
});

test('list shows route=webhook and never the webhook URL', async () => {
  const home = makeHome();
  process.env.WATCHTELL_COMPILER_CMD = FAKE_COMPILER;
  try {
    await captureStdout(() =>
      cli.cmdAdd('ping me when CI goes red', { yes: true, webhook: SLACK_URL })
    );
    const out = await captureStdout(() => cli.cmdList());
    assert.match(out, /\bwebhook\b/, 'route column shows webhook');
    assert.ok(!out.includes('hooks.slack.com'), 'URL host not printed in list');
    assert.ok(!out.includes('SECRETPART'), 'URL path not printed in list');
  } finally {
    delete process.env.WATCHTELL_COMPILER_CMD;
    cleanup(home);
  }
});
