'use strict';

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const paths = require('./paths');
const store = require('./store');
const run = require('./run');
const notify = require('./notify');
const { MIN_INTERVAL_SECONDS } = require('./compile');

const DEFAULT_POLL_MS = 15000; // how often the loop wakes to look for due checkers
const START_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = run.HARD_TIMEOUT_MS + 5000;
const KILL_TIMEOUT_MS = 5000;

// A transition whose alarm could not be delivered is queued on the
// checker's runtime record and retried on every subsequent tick, up to this many
// total attempts (the first dispatch is attempt 1). After the bound is reached the
// alarm is given up on and logged, so it is neither silently lost nor retried
// forever.
const MAX_DELIVERY_ATTEMPTS = 5;

// A checker is due when it has never run, or its interval has elapsed since the
// last run. interval comes from compile-time meta (seconds).
function isDue(runtime, meta, now) {
  if (!runtime || runtime.lastRunAt == null) return true;
  // Defense in depth: honor the hard floor even for hand-edited meta.json
  // (the trust hash covers only the script bytes, not the meta).
  const interval = Math.max(meta.interval || 300, MIN_INTERVAL_SECONDS);
  const intervalMs = interval * 1000;
  return now - runtime.lastRunAt >= intervalMs;
}

// Current contents of the checker's state sidecar (what it last observed).
function readState(id) {
  const file = paths.statePath(id);
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Attempt to deliver one alarm line, mutating `updated` in place and logging the
// outcome. A checker fires on a state TRANSITION that the checker records into its
// own sidecar *before* the daemon runs — so if we simply dropped a failed dispatch
// the transition would already be consumed and the alarm lost silently. Instead,
// on failure we persist the owed alarm to `updated.pending` and retry it on later
// ticks, up to MAX_DELIVERY_ATTEMPTS, then give up loudly.
//
// `attempts` is the count of prior (failed) attempts for this alarm; `queuedAt` is
// when it was first owed. Returns the result entry for runDue's list.
function attemptDelivery({ id, output, route, request, webhookUrl, attempts, queuedAt, now, notifyFn, logFn, updated }) {
  const attempt = attempts + 1;
  // firedAt is the transition time (when the alarm was first owed), kept stable
  // across retries by deriving it from queuedAt rather than the dispatch time.
  const firedAt = new Date(queuedAt).toISOString();
  const disp = notifyFn(route, `watchtell: ${request}`, output, { id, request, webhookUrl, firedAt });
  updated.lastOutput = output;

  if (disp && disp.ok) {
    delete updated.pending;
    updated.lastError = null;
    updated.lastFiredAt = now;
    logFn(`FIRED ${id} [${disp && disp.route}]: ${output}`);
    return { id, fired: true, output, dispatch: disp };
  }

  logFn(`NOTIFY-FAILED ${id} (attempt ${attempt}/${MAX_DELIVERY_ATTEMPTS}): ${output}`);
  if (attempt >= MAX_DELIVERY_ATTEMPTS) {
    delete updated.pending;
    updated.lastError = `notification dispatch failed after ${attempt} attempts`;
    logFn(`NOTIFY-GIVEUP ${id} after ${attempt} attempts: ${output}`);
    return { id, fired: false, output, dispatch: disp, gaveUp: true };
  }
  // Preserve the owed alarm for the next tick.
  updated.pending = { output, route, request, webhookUrl, attempts: attempt, queuedAt };
  updated.lastError = 'notification dispatch failed';
  return { id, fired: false, output, dispatch: disp };
}

// Persist a checker's runtime, but never resurrect a removed checker. `rm` writes a
// tombstone before deleting the sidecars, so we re-check it immediately before AND
// after the write: if the id was removed, drop the (possibly just-written) files and
// reap the tombstone instead. This closes the rm-vs-running-checker race — whichever
// of rm and the daemon acts last, the id converges to fully gone. Returns false when
// the write was suppressed because the checker had been removed.
function commitRuntime(id, updated) {
  if (store.isRemoved(id)) {
    store.finalizeRemoval(id);
    return false;
  }
  store.writeRuntime(id, updated);
  if (store.isRemoved(id)) {
    store.finalizeRemoval(id);
    return false;
  }
  return true;
}

// Reap tombstones left by `rm`, cleaning up anything a still-running checker or an
// overlapping tick revived. Logs a single line per id only when files actually had
// to be reclaimed, so a plain rm produces no spam.
function sweepRemoved(logFn) {
  for (const id of store.listTombstones()) {
    if (store.finalizeRemoval(id)) {
      logFn(`REMOVED ${id}: reclaimed files after rm`);
    }
  }
}

// Run every DUE checker once, and on every tick retry any alarm still owed from a
// prior failed dispatch. Transition dedupe lives inside each checker (its state
// sidecar); the daemon relays a non-empty line to the notifier and records
// last-fired. Trust is re-verified per run inside runChecker.
//
// Ordering / dedupe contract:
//   - A fresh transition this tick SUPERSEDES any queued-but-undelivered alarm
//     (newest wins): the current state is the truth, and delivering a stale alarm
//     plus a fresh one would be noise. The queued alarm is dropped (logged) and the
//     new one gets a fresh attempt budget.
//   - Otherwise a queued alarm is retried this tick even if the checker is not due,
//     so transient notifier failures clear quickly without waiting a full interval.
//   - A successful dispatch clears `pending`, so the daemon does not dispatch that
//     alarm again. Webhook receivers may still observe a duplicate after an
//     ambiguous failure and can deduplicate with the stable id/firedAt pair.
//
// Pure enough to unit-test: pass `now` and an optional `notifyFn`/`logFn`.
function runDue(opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const notifyFn = opts.notifyFn || notify.dispatch;
  const logFn = opts.logFn || (() => {});
  const results = [];

  // Reap any checker `rm` removed before we touch live checkers this tick.
  sweepRemoved(logFn);

  for (const id of store.listIds()) {
    // rm may have tombstoned this id after listIds snapshotted it. Don't run or
    // rewrite a removed checker; reap it and move on (no REFUSED/ERROR spam).
    if (store.isRemoved(id)) {
      store.finalizeRemoval(id);
      results.push({ id, removed: true });
      continue;
    }
    const runtime = store.readRuntime(id);
    let meta;
    try {
      meta = store.readMeta(id);
    } catch {
      if (!runtime.pending) continue;
      const updated = { ...runtime };
      const p = updated.pending;
      const r = attemptDelivery({
        id, output: p.output, route: p.route, request: p.request, webhookUrl: p.webhookUrl,
        attempts: p.attempts, queuedAt: p.queuedAt, now, notifyFn, logFn, updated,
      });
      if (!commitRuntime(id, updated)) {
        results.push({ id, removed: true });
        continue;
      }
      results.push({ ...r, retried: true });
      continue;
    }
    const due = isDue(runtime, meta, now);
    // Nothing to do: not due and no alarm owed.
    if (!due && !runtime.pending) continue;

    const updated = { ...runtime };
    let res = null;
    let checkerFailure = null;
    if (due) {
      res = run.runChecker(id);
      updated.lastRunAt = now;

      // rm may have removed the checker while it ran, so runChecker refuses on the
      // now-missing script. That's the race, not a fault: reap it silently instead
      // of logging a bogus REFUSED/ERROR for a checker the user deleted.
      if (store.isRemoved(id)) {
        store.finalizeRemoval(id);
        results.push({ id, removed: true });
        continue;
      }

      if (res.refused) {
        updated.lastError = res.reason;
        logFn(`REFUSED ${id}: ${res.reason}`);
        checkerFailure = { id, refused: true, reason: res.reason };
      } else {
        updated.lastState = readState(id);

        if (res.error) {
          updated.lastError = res.error;
          logFn(`ERROR ${id}: ${res.error}`);
          checkerFailure = { id, fired: false, timedOut: res.timedOut, error: res.error };
        }
      }
    }

    if (res && !res.refused && !res.error && res.output) {
      // Fresh transition supersedes any queued alarm (newest wins).
      if (updated.pending) {
        logFn(`NOTIFY-SUPERSEDED ${id}: newer transition replaces queued alarm`);
      }
      const r = attemptDelivery({
        id, output: res.output, route: meta.route, request: meta.request, webhookUrl: meta.webhookUrl,
        attempts: 0, queuedAt: now, now, notifyFn, logFn, updated,
      });
      if (!commitRuntime(id, updated)) {
        results.push({ id, removed: true });
        continue;
      }
      results.push(r);
      continue;
    }

    if (updated.pending) {
      // No fresh transition, but an alarm is still owed: retry it this tick.
      const p = updated.pending;
      const r = attemptDelivery({
        id, output: p.output, route: p.route, request: p.request, webhookUrl: p.webhookUrl,
        attempts: p.attempts, queuedAt: p.queuedAt, now, notifyFn, logFn, updated,
      });
      if (r.fired && checkerFailure) {
        updated.lastError = checkerFailure.reason || checkerFailure.error;
      }
      if (!commitRuntime(id, updated)) {
        results.push({ id, removed: true });
        continue;
      }
      results.push({ ...(checkerFailure || {}), ...r, retried: true });
      continue;
    }

    if (checkerFailure) {
      if (!commitRuntime(id, updated)) {
        results.push({ id, removed: true });
        continue;
      }
      results.push(checkerFailure);
      continue;
    }

    // Ran, produced no transition, nothing owed: silence.
    updated.lastError = null;
    if (!commitRuntime(id, updated)) {
      results.push({ id, removed: true });
      continue;
    }
    if (res.timedOut) logFn(`TIMEOUT ${id}`);
    results.push({ id, fired: false, timedOut: res.timedOut });
  }
  return results;
}

// ---- process lifecycle -----------------------------------------------------

function readPid() {
  const file = paths.pidPath();
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    const record = JSON.parse(contents);
    if (Number.isInteger(record.pid) && record.pid > 0 && typeof record.token === 'string') {
      return record;
    }
  } catch {
    const pid = Number(contents);
    if (Number.isInteger(pid) && pid > 0) return { pid, token: null };
  }
  return { pid: null, token: null };
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not ours
  }
}

function processToken(pid) {
  if (!isAlive(pid)) return null;
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'state='], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  const fields = result.stdout.trim().split(/\s+/);
  const state = fields.pop();
  if (!state || state.startsWith('Z')) return null;
  return fields.join(' ') || null;
}

function ownsProcess(record) {
  return Boolean(record && record.token && processToken(record.pid) === record.token);
}

// { running, pid, stale } — stale means a pid file points at a dead process.
function status() {
  const record = readPid();
  if (record == null) return { running: false, pid: null, stale: false };
  if (ownsProcess(record)) return { running: true, pid: record.pid, stale: false, record };
  if (!isAlive(record.pid)) return { running: false, pid: record.pid, stale: true, record };
  return { running: false, pid: record.pid, stale: false, foreign: true, record };
}

function writePid() {
  store.ensureHome();
  const record = { pid: process.pid, token: processToken(process.pid) };
  if (!record.token) throw new Error('could not determine daemon process identity');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(paths.pidPath(), `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
      return record;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const st = status();
      if (st.running) throw new Error(`daemon already running (pid ${st.pid})`);
      clearPid(st.record);
    }
  }
  throw new Error('could not acquire daemon pid file');
}

function clearPid(expected) {
  if (expected) {
    const current = readPid();
    if (!current || current.pid !== expected.pid || current.token !== expected.token) return false;
  }
  fs.rmSync(paths.pidPath(), { force: true });
  return true;
}

function log(msg) {
  store.ensureHome();
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(paths.logPath(), line);
  } catch {
    /* logging is best-effort */
  }
}

// Run the blocking loop in THIS process until signalled. Reclaims an unowned pid file.
function runForeground(opts = {}) {
  const pollMs = opts.pollMs || parseInt(process.env.WATCHTELL_POLL || '', 10) || DEFAULT_POLL_MS;
  const ownership = writePid();
  log(`daemon started (pid ${process.pid}, poll ${pollMs}ms)`);

  let stopping = false;
  const shutdown = (sig) => {
    if (stopping) return;
    stopping = true;
    log(`daemon stopping (${sig})`);
    clearInterval(timer);
    clearPid(ownership);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const tick = () => {
    try {
      runDue({ logFn: log });
    } catch (e) {
      log(`tick error: ${e.message}`);
    }
  };
  tick();
  const timer = setInterval(tick, pollMs);
}

// Spawn a detached foreground daemon and return its pid.
function startDetached() {
  const st = status();
  if (st.running) {
    throw new Error(`daemon already running (pid ${st.pid})`);
  }
  store.ensureHome();
  const out = fs.openSync(paths.logPath(), 'a');
  const entry = path.join(__dirname, '..', 'bin', 'watchtell.js');
  const child = spawn(process.execPath, [entry, 'daemon', 'start', '--foreground'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  fs.closeSync(out);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const st = status();
    if (st.running && st.pid === child.pid) return child.pid;
    if (st.running && st.pid !== child.pid) {
      throw new Error(`daemon already running (pid ${st.pid})`);
    }
    if (!isAlive(child.pid)) break;
    wait(20);
  }
  throw new Error('daemon failed to start');
}

function stop(opts = {}) {
  const st = status();
  if (st.stale) {
    clearPid(st.record);
    return { stopped: false, stale: true, pid: st.pid };
  }
  if (!st.running) {
    return { stopped: false, running: false };
  }
  signalOwnedProcess(st.record, 'SIGTERM');
  const deadline = Date.now() + (opts.graceMs ?? STOP_TIMEOUT_MS);
  while (ownsProcess(st.record) && Date.now() < deadline) {
    wait(25);
  }
  let forced = false;
  if (ownsProcess(st.record)) {
    forced = signalOwnedProcess(st.record, 'SIGKILL');
    const killDeadline = Date.now() + KILL_TIMEOUT_MS;
    while (ownsProcess(st.record) && Date.now() < killDeadline) {
      wait(25);
    }
  }
  if (ownsProcess(st.record)) {
    return { stopped: false, running: true, timedOut: true, pid: st.pid, forced };
  }
  clearPid(st.record);
  log(`daemon stopped (pid ${st.pid})`);
  return { stopped: true, pid: st.pid, forced };
}

function signalOwnedProcess(record, signal) {
  if (!ownsProcess(record)) return false;
  try {
    process.kill(record.pid, signal);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') return false;
    throw e;
  }
}

function wait(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

module.exports = {
  DEFAULT_POLL_MS,
  isDue,
  readState,
  runDue,
  status,
  runForeground,
  startDetached,
  stop,
};
