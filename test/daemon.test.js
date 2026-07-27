'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const daemon = require('../src/daemon');
const store = require('../src/store');
const paths = require('../src/paths');
const { makeHome, cleanup, createChecker, probeChecker } = require('./helpers');

test('isDue: never-run is due, within interval is not, elapsed is due', () => {
  const meta = { interval: 60 };
  assert.strictEqual(daemon.isDue({ lastRunAt: null }, meta, 1000), true);
  assert.strictEqual(daemon.isDue({ lastRunAt: 1000 }, meta, 1000 + 30 * 1000), false);
  assert.strictEqual(daemon.isDue({ lastRunAt: 1000 }, meta, 1000 + 60 * 1000), true);
});

test('isDue: a hand-edited sub-minute interval is treated as the 60s floor', () => {
  const meta = { interval: 5 }; // hand-edited meta.json, below the floor
  // 5s would make it due at +5s; the floor keeps it not-due until +60s.
  assert.strictEqual(daemon.isDue({ lastRunAt: 1000 }, meta, 1000 + 5 * 1000), false);
  assert.strictEqual(daemon.isDue({ lastRunAt: 1000 }, meta, 1000 + 60 * 1000), true);
});

test('runDue runs only due checkers', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const dueId = createChecker(probeChecker(probe), { interval: 1 });
    const notDueId = createChecker(probeChecker(probe), { interval: 3600 });
    // Mark notDueId as just-run so it is not due; dueId has no runtime yet.
    store.writeRuntime(notDueId, { lastRunAt: 10_000, lastFiredAt: null, lastState: null });

    const results = daemon.runDue({ now: 11_000, notifyFn: () => ({ ok: true, route: 'notify' }) });
    const ranIds = results.map((r) => r.id);
    assert.ok(ranIds.includes(dueId), 'due checker ran');
    assert.ok(!ranIds.includes(notDueId), 'not-due checker skipped');
  } finally {
    cleanup(home);
  }
});

test('transition relay: fires once on transition, dispatches notify, dedupes', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const notifyLog = path.join(home, 'notify.log');
    process.env.WATCHTELL_NOTIFY_CMD = `printf '%s|%s|%s\\n' "$WATCHTELL_ROUTE" "$WATCHTELL_TITLE" "$WATCHTELL_MESSAGE" >> ${notifyLog}`;

    const id = createChecker(probeChecker(probe), { interval: 1, request: 'probe trips' });

    // Runs are spaced >60s apart so each clears the runtime interval floor.
    // #1 baseline (probe absent -> ok): silent, no notification.
    let res = daemon.runDue({ now: 1_000_000 });
    assert.strictEqual(res.find((r) => r.id === id).fired, false);
    assert.ok(!fs.existsSync(notifyLog), 'no notification on baseline run');

    // Flip probe to ALARM, run again -> transition fires + notifies.
    fs.writeFileSync(probe, 'ALARM\n');
    res = daemon.runDue({ now: 1_070_000 });
    const fired = res.find((r) => r.id === id);
    assert.strictEqual(fired.fired, true);
    assert.match(fired.output, /entered ALARM/);
    const log1 = fs.readFileSync(notifyLog, 'utf8').trim().split('\n');
    assert.strictEqual(log1.length, 1, 'exactly one notification dispatched');
    assert.match(log1[0], /^notify\|watchtell: probe trips\|probe entered ALARM state$/);
    assert.ok(store.readRuntime(id).lastFiredAt, 'lastFiredAt recorded');

    // #3 probe still ALARM: checker stays silent (dedupe) -> no new notification.
    res = daemon.runDue({ now: 1_140_000 });
    assert.strictEqual(res.find((r) => r.id === id).fired, false);
    const log2 = fs.readFileSync(notifyLog, 'utf8').trim().split('\n');
    assert.strictEqual(log2.length, 1, 'no re-alarm while condition persists');
  } finally {
    delete process.env.WATCHTELL_NOTIFY_CMD;
    cleanup(home);
  }
});

test('runDue enforces the per-run timeout (no fire on timeout)', () => {
  const home = makeHome();
  const saved = process.env.WATCHTELL_TIMEOUT_MS;
  try {
    process.env.WATCHTELL_TIMEOUT_MS = '400';
    const slow = '#!/usr/bin/env bash\nsleep 5\necho too-late\n';
    const id = createChecker(slow, { interval: 1 });
    let notified = 0;
    const res = daemon.runDue({ now: 2_000_000, notifyFn: () => (notified++, { ok: true }) });
    const r = res.find((x) => x.id === id);
    assert.strictEqual(r.fired, false);
    assert.strictEqual(r.timedOut, true);
    assert.strictEqual(notified, 0, 'a timed-out checker never notifies');
  } finally {
    if (saved === undefined) delete process.env.WATCHTELL_TIMEOUT_MS;
    else process.env.WATCHTELL_TIMEOUT_MS = saved;
    cleanup(home);
  }
});

test('timeout kills foreground checker child processes', async () => {
  const home = makeHome();
  const saved = process.env.WATCHTELL_TIMEOUT_MS;
  let childPid;
  try {
    process.env.WATCHTELL_TIMEOUT_MS = '100';
    const pidFile = path.join(home, 'child.pid');
    const id = createChecker(
      `#!/usr/bin/env bash\nbash -c 'printf "%s\\n" "$$" > "${pidFile}"; sleep 5'\n`,
      { interval: 1 }
    );
    const result = daemon.runDue({ now: 2_500_000 }).find((entry) => entry.id === id);
    childPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.strictEqual(result.timedOut, true);
    assert.strictEqual(await waitForExit(childPid, 500), true);
  } finally {
    if (childPid && isProcessAlive(childPid)) process.kill(childPid, 'SIGKILL');
    if (saved === undefined) delete process.env.WATCHTELL_TIMEOUT_MS;
    else process.env.WATCHTELL_TIMEOUT_MS = saved;
    cleanup(home);
  }
});

test('runDue refuses a tampered checker instead of running it', () => {
  const home = makeHome();
  try {
    const id = createChecker('#!/usr/bin/env bash\necho hi\n', { interval: 1 });
    fs.appendFileSync(paths.scriptPath(id), '# tamper\n');
    const res = daemon.runDue({ now: 3_000_000, notifyFn: () => ({ ok: true }) });
    const r = res.find((x) => x.id === id);
    assert.strictEqual(r.refused, true);
    assert.match(r.reason, /hash mismatch/);
  } finally {
    cleanup(home);
  }
});

test('checker errors stay silent and preserve the previous state', () => {
  const home = makeHome();
  try {
    const id = createChecker(
      '#!/usr/bin/env bash\nprintf \'changed\\n\' > "$WATCHTELL_STATE"\nprintf \'false alarm\\n\'\nexit 1\n',
      { interval: 1 }
    );
    fs.writeFileSync(paths.statePath(id), 'previous\n');
    let notified = 0;
    const result = daemon.runDue({
      now: 4_000_000,
      notifyFn: () => (notified++, { ok: true }),
    }).find((entry) => entry.id === id);
    assert.strictEqual(result.fired, false);
    assert.match(result.error, /status 1/);
    assert.strictEqual(notified, 0);
    assert.strictEqual(fs.readFileSync(paths.statePath(id), 'utf8'), 'previous\n');
    assert.match(store.readRuntime(id).lastError, /status 1/);
  } finally {
    cleanup(home);
  }
});

test('failed notification dispatch is not recorded as fired', () => {
  const home = makeHome();
  try {
    const id = createChecker('#!/usr/bin/env bash\nprintf \'alarm\\n\'\n', { interval: 1 });
    const result = daemon.runDue({
      now: 5_000_000,
      notifyFn: () => ({ ok: false, route: 'notify' }),
    }).find((entry) => entry.id === id);
    const runtime = store.readRuntime(id);
    assert.strictEqual(result.fired, false);
    assert.strictEqual(runtime.lastFiredAt, null);
    assert.strictEqual(runtime.lastError, 'notification dispatch failed');
  } finally {
    cleanup(home);
  }
});

test('undelivered transition is queued and retried until it succeeds (exactly once)', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), { interval: 1, request: 'probe trips' });
    const logs = [];
    const logFn = (m) => logs.push(m);

    // Baseline: probe absent -> silent.
    daemon.runDue({ now: 1_000_000, notifyFn: () => ({ ok: true, route: 'notify' }), logFn });

    // First dispatch fails, every later one succeeds.
    let calls = 0;
    const notifyFn = () => (++calls, { ok: calls > 1, route: 'notify' });

    fs.writeFileSync(probe, 'ALARM\n');
    let res = daemon.runDue({ now: 1_070_000, notifyFn, logFn }).find((r) => r.id === id);
    assert.strictEqual(res.fired, false, 'first dispatch failed -> not fired');
    assert.ok(store.readRuntime(id).pending, 'owed alarm queued after failure');
    assert.strictEqual(store.readRuntime(id).lastFiredAt, null);
    assert.ok(logs.some((l) => /^NOTIFY-FAILED .* \(attempt 1\/5\)/.test(l)), 'failure logged');

    // Next tick: not due (interval floored to 60s), but the queued alarm is retried.
    res = daemon.runDue({ now: 1_075_000, notifyFn, logFn }).find((r) => r.id === id);
    assert.strictEqual(res.fired, true, 'retry delivered the owed alarm');
    assert.match(res.output, /entered ALARM/);
    assert.strictEqual(calls, 2, 'delivered exactly once (one fail + one success)');
    assert.ok(!store.readRuntime(id).pending, 'pending cleared after delivery');
    assert.ok(store.readRuntime(id).lastFiredAt, 'lastFiredAt recorded');
    assert.strictEqual(logs.filter((l) => l.startsWith('FIRED')).length, 1, 'fired logged once');
  } finally {
    cleanup(home);
  }
});

test('a persistently undeliverable alarm is bounded then given up (logged)', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), { interval: 1, request: 'probe trips' });
    const logs = [];
    const logFn = (m) => logs.push(m);

    daemon.runDue({ now: 1_000_000, notifyFn: () => ({ ok: true }), logFn }); // baseline

    let calls = 0;
    const notifyFn = () => (++calls, { ok: false, route: 'notify' });

    fs.writeFileSync(probe, 'ALARM\n');
    let now = 1_070_000;
    daemon.runDue({ now, notifyFn, logFn }); // attempt 1 (fires transition, fails)
    for (let i = 0; i < 4; i++) {
      now += 5_000;
      daemon.runDue({ now, notifyFn, logFn }); // retries -> attempts 2..5
    }

    assert.strictEqual(calls, 5, 'bounded at MAX_DELIVERY_ATTEMPTS dispatch attempts');
    assert.ok(!store.readRuntime(id).pending, 'pending cleared after give-up');
    assert.match(store.readRuntime(id).lastError, /after 5 attempts/);
    assert.ok(logs.some((l) => /^NOTIFY-GIVEUP .* after 5 attempts/.test(l)), 'give-up logged');

    // No further dispatch attempts once given up (checker not yet due again).
    now += 5_000;
    daemon.runDue({ now, notifyFn, logFn });
    assert.strictEqual(calls, 5, 'no retries after give-up');
  } finally {
    cleanup(home);
  }
});

test('a newer transition supersedes an older undelivered alarm (newest wins)', () => {
  const home = makeHome();
  try {
    const probe = path.join(home, 'probe.txt');
    const id = createChecker(probeChecker(probe), { interval: 1, request: 'probe trips' });
    const logs = [];
    const logFn = (m) => logs.push(m);

    // Only the ALARM alarm fails to deliver; the recovery delivers fine.
    const delivered = [];
    const notifyFn = (route, title, message) => {
      if (/ALARM/.test(message)) return { ok: false, route: 'notify' };
      delivered.push(message);
      return { ok: true, route: 'notify' };
    };

    daemon.runDue({ now: 1_000_000, notifyFn, logFn }); // baseline (ok)

    fs.writeFileSync(probe, 'ALARM\n');
    daemon.runDue({ now: 1_070_000, notifyFn, logFn }); // transition -> ALARM, dispatch fails
    assert.ok(store.readRuntime(id).pending, 'ALARM alarm queued');

    fs.rmSync(probe); // condition recovers before the queued alarm ever delivers
    const res = daemon.runDue({ now: 1_140_000, notifyFn, logFn }).find((r) => r.id === id);

    assert.deepStrictEqual(delivered, ['probe recovered'], 'newest transition delivered');
    assert.strictEqual(res.fired, true);
    assert.ok(!store.readRuntime(id).pending, 'stale ALARM alarm dropped, not re-fired');
    assert.ok(logs.some((l) => /^NOTIFY-SUPERSEDED/.test(l)), 'supersede logged');
  } finally {
    cleanup(home);
  }
});

test('a pending alarm retries with unreadable metadata', () => {
  const home = makeHome();
  try {
    const id = createChecker('#!/usr/bin/env bash\nexit 0\n', { request: 'original request' });
    store.writeRuntime(id, {
      lastRunAt: 1_000_000,
      lastFiredAt: null,
      lastState: null,
      lastOutput: 'owed alarm',
      pending: {
        output: 'owed alarm',
        route: 'notify',
        request: 'original request',
        attempts: 1,
        queuedAt: 1_000_000,
      },
    });
    fs.writeFileSync(paths.metaPath(id), '{invalid json\n');
    const deliveries = [];

    const result = daemon.runDue({
      now: 1_005_000,
      notifyFn: (...args) => (deliveries.push(args), { ok: true, route: 'notify' }),
    }).find((entry) => entry.id === id);

    assert.strictEqual(result.fired, true);
    assert.strictEqual(result.retried, true);
    assert.deepStrictEqual(deliveries, [['notify', 'watchtell: original request', 'owed alarm']]);
    assert.ok(!store.readRuntime(id).pending);
  } finally {
    cleanup(home);
  }
});

test('a pending alarm retries when a due checker refuses or errors', () => {
  const scenarios = [
    {
      script: '#!/usr/bin/env bash\nexit 0\n',
      mutate: (id) => fs.appendFileSync(paths.scriptPath(id), '# tampered\n'),
      assertFailure: (result) => assert.strictEqual(result.refused, true),
    },
    {
      script: '#!/usr/bin/env bash\nexit 1\n',
      mutate: () => {},
      assertFailure: (result) => assert.match(result.error, /status 1/),
    },
  ];

  for (const scenario of scenarios) {
    const home = makeHome();
    try {
      const id = createChecker(scenario.script, { request: 'original request' });
      store.writeRuntime(id, {
        lastRunAt: null,
        lastFiredAt: null,
        lastState: null,
        lastOutput: 'owed alarm',
        pending: {
          output: 'owed alarm',
          route: 'notify',
          request: 'original request',
          attempts: 1,
          queuedAt: 1_000_000,
        },
      });
      scenario.mutate(id);
      let deliveries = 0;

      const result = daemon.runDue({
        now: 1_005_000,
        notifyFn: () => (deliveries++, { ok: true, route: 'notify' }),
      }).find((entry) => entry.id === id);

      scenario.assertFailure(result);
      assert.strictEqual(result.fired, true);
      assert.strictEqual(result.retried, true);
      assert.strictEqual(deliveries, 1);
      assert.ok(!store.readRuntime(id).pending);
    } finally {
      cleanup(home);
    }
  }
});

test('detached start confirms ownership and stop waits for exit', () => {
  const home = makeHome();
  try {
    const pid = daemon.startDetached();
    assert.deepStrictEqual(daemon.status(), {
      running: true,
      pid,
      stale: false,
      record: JSON.parse(fs.readFileSync(paths.pidPath(), 'utf8')),
    });
    assert.throws(() => daemon.startDetached(), /already running/);
    assert.strictEqual(daemon.stop().stopped, true);
    assert.strictEqual(daemon.status().running, false);
  } finally {
    const st = daemon.status();
    if (st.running) daemon.stop();
    cleanup(home);
  }
});

test('stop force-kills an owned daemon after the grace period', async () => {
  const home = makeHome();
  try {
    const marker = path.join(home, 'checker-started');
    createChecker(`#!/usr/bin/env bash\nprintf started > "${marker}"\nsleep 1\n`, { interval: 1 });
    daemon.startDetached();
    const deadline = Date.now() + 1000;
    while (!fs.existsSync(marker) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(fs.existsSync(marker));
    const result = daemon.stop({ graceMs: 50 });
    assert.strictEqual(result.stopped, true);
    assert.strictEqual(result.forced, true);
    assert.strictEqual(daemon.status().running, false);
  } finally {
    const st = daemon.status();
    if (st.running) daemon.stop({ graceMs: 50 });
    cleanup(home);
  }
});

test('a mismatched process identity is never treated as the daemon', () => {
  const home = makeHome();
  try {
    fs.writeFileSync(paths.pidPath(), `${JSON.stringify({ pid: process.pid, token: 'reused' })}\n`);
    const st = daemon.status();
    assert.strictEqual(st.running, false);
    assert.strictEqual(st.stale, false);
    assert.strictEqual(st.foreign, true);
    assert.strictEqual(daemon.stop().stopped, false);
    assert.ok(fs.existsSync(paths.pidPath()));
  } finally {
    cleanup(home);
  }
});

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !isProcessAlive(pid);
}
