'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const webhook = require('../src/webhook');
const notify = require('../src/notify');
const daemon = require('../src/daemon');
const store = require('../src/store');
const { makeHome, cleanup, createChecker, probeChecker } = require('./helpers');

const drain = () => new Promise((res) => setImmediate(res));

// --- validateUrl: pure ------------------------------------------------------

test('validateUrl accepts http and https and normalizes', () => {
  assert.strictEqual(webhook.validateUrl('http://example.com/hook'), 'http://example.com/hook');
  assert.strictEqual(
    webhook.validateUrl('https://hooks.slack.com/services/T/B/xxx'),
    'https://hooks.slack.com/services/T/B/xxx'
  );
  // surrounding whitespace is trimmed
  assert.strictEqual(webhook.validateUrl('  https://example.com/x  '), 'https://example.com/x');
});

test('validateUrl rejects non-http(s), garbage, and empty', () => {
  assert.throws(() => webhook.validateUrl('ftp://example.com/x'), /must be http or https/);
  assert.throws(() => webhook.validateUrl('not a url'), /invalid webhook URL/);
  assert.throws(() => webhook.validateUrl(''), /empty/);
  assert.throws(() => webhook.validateUrl('   '), /empty/);
  assert.throws(() => webhook.validateUrl(null), /empty/);
  assert.throws(() => webhook.validateUrl('file:///etc/passwd'), /must be http or https/);
});

// --- redactUrl: pure --------------------------------------------------------

test('redactUrl keeps scheme+host and drops the (secret-bearing) path', () => {
  assert.strictEqual(
    webhook.redactUrl('https://hooks.slack.com/services/T000/B000/SECRET'),
    'https://hooks.slack.com'
  );
  assert.strictEqual(webhook.redactUrl('http://example.com:8080/a/b?tok=1'), 'http://example.com:8080');
  assert.strictEqual(webhook.redactUrl('garbage'), '<redacted>');
});

// --- buildPayload: pure -----------------------------------------------------

test('buildPayload produces the exact stable schema', () => {
  const p = webhook.buildPayload({
    id: 'abc123',
    request: 'watch the thing',
    message: 'thing entered ALARM state',
    firedAt: '2026-07-28T00:00:00.000Z',
  });
  assert.deepStrictEqual(p, {
    id: 'abc123',
    request: 'watch the thing',
    message: 'thing entered ALARM state',
    firedAt: '2026-07-28T00:00:00.000Z',
  });
  assert.deepStrictEqual(Object.keys(p), ['id', 'request', 'message', 'firedAt']);
});

// --- deliver: against a local ephemeral http server -------------------------

// webhook.deliver runs the POST in a spawnSync child, which BLOCKS this thread's
// event loop for the duration. An in-process http server would therefore deadlock
// (it could never answer the child). So we host the test server in a worker thread
// with its own event loop: it keeps serving while the main thread is blocked, and
// posts each received request back for inspection after deliver returns.
const SERVER_WORKER = `
  const http = require('http');
  const { parentPort, workerData } = require('worker_threads');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      parentPort.postMessage({
        request: { method: req.method, contentType: req.headers['content-type'], body },
      });
      const respond = () => { res.writeHead(workerData.status); res.end('x'); };
      if (workerData.delayMs) setTimeout(respond, workerData.delayMs);
      else respond();
    });
  });
  server.listen(0, '127.0.0.1', () => {
    parentPort.postMessage({ port: server.address().port });
  });
  parentPort.on('message', (m) => {
    if (m === 'close') server.close(() => process.exit(0));
  });
`;

function startServer({ status = 200, delayMs = 0 } = {}) {
  const received = [];
  const worker = new Worker(SERVER_WORKER, { eval: true, workerData: { status, delayMs } });
  return new Promise((resolve) => {
    worker.on('message', (m) => {
      if (m.request) received.push(m.request);
      if (m.port != null) {
        resolve({
          url: `http://127.0.0.1:${m.port}/hook`,
          received,
          close: () =>
            new Promise((r) => {
              worker.once('exit', r);
              worker.postMessage('close');
            }),
        });
      }
    });
  });
}

test('deliver: 2xx succeeds and sends the exact JSON payload as application/json', async () => {
  const srv = await startServer({ status: 200 });
  try {
    const payload = webhook.buildPayload({
      id: 'id01', request: 'req', message: 'msg', firedAt: '2026-07-28T00:00:00.000Z',
    });
    const r = webhook.deliver(srv.url, payload);
    assert.strictEqual(r.ok, true);
    // deliver blocked this thread; let the worker's queued request message drain.
    await drain();
    assert.strictEqual(srv.received.length, 1);
    assert.strictEqual(srv.received[0].method, 'POST');
    assert.match(srv.received[0].contentType, /application\/json/);
    assert.deepStrictEqual(JSON.parse(srv.received[0].body), payload);
  } finally {
    await srv.close();
  }
});

test('deliver: non-2xx (500) is a failed dispatch', async () => {
  const srv = await startServer({ status: 500 });
  try {
    const r = webhook.deliver(srv.url, { id: 'x' });
    assert.strictEqual(r.ok, false);
  } finally {
    await srv.close();
  }
});

test('deliver: connection refused is a failed dispatch', async () => {
  // Bind then immediately close to obtain a port that nothing listens on.
  const srv = await startServer({ status: 200 });
  const deadUrl = srv.url;
  await srv.close();
  const r = webhook.deliver(deadUrl, { id: 'x' });
  assert.strictEqual(r.ok, false);
});

test('deliver: a slow endpoint past the timeout is a failed dispatch', async () => {
  const srv = await startServer({ status: 200, delayMs: 2000 });
  try {
    const r = webhook.deliver(srv.url, { id: 'x' }, { timeoutMs: 200 });
    assert.strictEqual(r.ok, false);
  } finally {
    await srv.close();
  }
});

// --- dispatch: local fallback note on webhook failure -----------------------

test('notify.dispatch fires a local fallback note when the webhook fails', () => {
  const home = makeHome();
  const log = path.join(home, 'note.log');
  process.env.WATCHTELL_NOTIFY_CMD =
    `printf '%s|%s\\n' "$WATCHTELL_TITLE" "$WATCHTELL_MESSAGE" >> ${log}`;
  try {
    // A dead URL (nothing listening) guarantees a failed dispatch.
    const disp = notify.dispatch('webhook', 'watchtell: t', 'thing fired', {
      id: 'abc123',
      request: 't',
      webhookUrl: 'http://127.0.0.1:1/hook',
      firedAt: '2026-07-28T00:00:00.000Z',
      webhookTimeoutMs: 300,
    });
    assert.strictEqual(disp.ok, false);
    assert.strictEqual(disp.route, 'webhook');
    const noted = fs.readFileSync(log, 'utf8').trim();
    assert.match(noted, /webhook delivery failed for abc123/);
  } finally {
    delete process.env.WATCHTELL_NOTIFY_CMD;
    cleanup(home);
  }
});

test('notify.dispatch webhook success sends no local fallback note', async () => {
  const home = makeHome();
  const srv = await startServer({ status: 200 });
  const log = path.join(home, 'note.log');
  process.env.WATCHTELL_NOTIFY_CMD = `printf x >> ${log}`;
  try {
    const disp = notify.dispatch('webhook', 'watchtell: t', 'thing fired', {
      id: 'abc123', request: 't', webhookUrl: srv.url, firedAt: '2026-07-28T00:00:00.000Z',
    });
    assert.strictEqual(disp.ok, true);
    await drain();
    assert.ok(!fs.existsSync(log), 'no local note on success');
    assert.strictEqual(srv.received.length, 1);
  } finally {
    delete process.env.WATCHTELL_NOTIFY_CMD;
    await srv.close();
    cleanup(home);
  }
});

// --- daemon dispatch through the real notify.dispatch webhook backend -------

test('daemon: a transition on a webhook checker POSTs the alarm and clears the queue', async () => {
  const home = makeHome();
  const srv = await startServer({ status: 200 });
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), {
      interval: 1, request: 'probe trips', route: 'webhook', webhookUrl: srv.url,
    });

    // Baseline (probe absent): silent, no POST.
    daemon.runDue({ now: 1_000_000 });
    await drain();
    assert.strictEqual(srv.received.length, 0, 'no POST on baseline');

    // Flip to ALARM: transition -> webhook POST.
    fs.writeFileSync(probe, 'ALARM\n');
    const res = daemon.runDue({ now: 1_070_000 }).find((r) => r.id === id);
    await drain();
    assert.strictEqual(res.fired, true);
    assert.strictEqual(res.dispatch.route, 'webhook');
    assert.strictEqual(srv.received.length, 1, 'exactly one POST');
    const payload = JSON.parse(srv.received[0].body);
    assert.deepStrictEqual(Object.keys(payload), ['id', 'request', 'message', 'firedAt']);
    assert.strictEqual(payload.id, id);
    assert.strictEqual(payload.request, 'probe trips');
    assert.strictEqual(payload.message, 'probe entered ALARM state');
    assert.strictEqual(payload.firedAt, new Date(1_070_000).toISOString());
    assert.ok(!store.readRuntime(id).pending, 'queue cleared on 2xx');
    assert.ok(store.readRuntime(id).lastFiredAt, 'lastFiredAt recorded');
  } finally {
    await srv.close();
    cleanup(home);
  }
});

test('daemon: a non-2xx webhook queues a retry, then a later 2xx delivers exactly once', async () => {
  const home = makeHome();
  const bad = await startServer({ status: 500 });
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), {
      interval: 1, request: 'probe trips', route: 'webhook', webhookUrl: bad.url,
    });
    const logs = [];
    const logFn = (m) => logs.push(m);

    daemon.runDue({ now: 1_000_000, logFn }); // baseline

    // Transition, but the endpoint 500s -> not fired, alarm queued.
    fs.writeFileSync(probe, 'ALARM\n');
    let res = daemon.runDue({ now: 1_070_000, logFn }).find((r) => r.id === id);
    await drain();
    assert.strictEqual(res.fired, false, '500 is a failed dispatch');
    assert.ok(store.readRuntime(id).pending, 'owed alarm queued after 500');
    assert.strictEqual(store.readRuntime(id).pending.webhookUrl, bad.url, 'URL carried on the queue');
    assert.ok(logs.some((l) => /^NOTIFY-FAILED .* \(attempt 1\/5\)/.test(l)));

    // Point the checker at a healthy endpoint and retry: delivered.
    const good = await startServer({ status: 200 });
    try {
      const meta = store.readMeta(id);
      meta.webhookUrl = good.url;
      store.writeMeta(id, meta);
      // Rewrite the queued URL too (the daemon carries it on pending).
      const rt = store.readRuntime(id);
      rt.pending.webhookUrl = good.url;
      store.writeRuntime(id, rt);

      res = daemon.runDue({ now: 1_075_000, logFn }).find((r) => r.id === id);
      await drain();
      assert.strictEqual(res.fired, true, 'retry delivered the owed alarm');
      assert.strictEqual(good.received.length, 1, 'delivered exactly once');
      assert.ok(!store.readRuntime(id).pending, 'queue cleared after delivery');
    } finally {
      await good.close();
    }
  } finally {
    await bad.close();
    cleanup(home);
  }
});

test('daemon: a persistently failing webhook is given up after MAX attempts', async () => {
  const home = makeHome();
  const bad = await startServer({ status: 500 });
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), {
      interval: 1, request: 'probe trips', route: 'webhook', webhookUrl: bad.url,
    });
    const logs = [];
    const logFn = (m) => logs.push(m);

    daemon.runDue({ now: 1_000_000, logFn }); // baseline
    fs.writeFileSync(probe, 'ALARM\n');
    let now = 1_070_000;
    daemon.runDue({ now, logFn }); // attempt 1
    for (let i = 0; i < 4; i++) {
      now += 5_000;
      daemon.runDue({ now, logFn }); // attempts 2..5
    }
    await drain();
    assert.strictEqual(bad.received.length, 5, 'bounded at MAX_DELIVERY_ATTEMPTS POSTs');
    assert.ok(!store.readRuntime(id).pending, 'queue cleared after give-up');
    assert.match(store.readRuntime(id).lastError, /after 5 attempts/);
    assert.ok(logs.some((l) => /^NOTIFY-GIVEUP .* after 5 attempts/.test(l)));
  } finally {
    await bad.close();
    cleanup(home);
  }
});

test('daemon: a newer transition supersedes an undelivered webhook alarm', async () => {
  const home = makeHome();
  // First endpoint 500s (ALARM never delivers); a second healthy endpoint takes
  // the superseding recovery. We swap meta.webhookUrl to the good one before recovery.
  const bad = await startServer({ status: 500 });
  const good = await startServer({ status: 200 });
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), {
      interval: 1, request: 'probe trips', route: 'webhook', webhookUrl: bad.url,
    });
    const logs = [];
    const logFn = (m) => logs.push(m);

    daemon.runDue({ now: 1_000_000, logFn }); // baseline
    fs.writeFileSync(probe, 'ALARM\n');
    daemon.runDue({ now: 1_070_000, logFn }); // ALARM -> 500, queued
    await drain();
    assert.ok(store.readRuntime(id).pending, 'ALARM alarm queued');

    // Recover; point at the healthy endpoint so the newest alarm delivers.
    fs.rmSync(probe);
    const meta = store.readMeta(id);
    meta.webhookUrl = good.url;
    store.writeMeta(id, meta);
    const res = daemon.runDue({ now: 1_140_000, logFn }).find((r) => r.id === id);
    await drain();
    assert.strictEqual(res.fired, true);
    assert.strictEqual(good.received.length, 1, 'only the newest alarm delivered');
    assert.strictEqual(JSON.parse(good.received[0].body).message, 'probe recovered');
    assert.ok(!store.readRuntime(id).pending, 'stale ALARM alarm dropped');
    assert.ok(logs.some((l) => /^NOTIFY-SUPERSEDED/.test(l)));
  } finally {
    await bad.close();
    await good.close();
    cleanup(home);
  }
});
