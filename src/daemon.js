'use strict';

const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const paths = require('./paths');
const store = require('./store');
const run = require('./run');
const notify = require('./notify');

const DEFAULT_POLL_MS = 15000; // how often the loop wakes to look for due checkers
const START_TIMEOUT_MS = 5000;
const STOP_TIMEOUT_MS = run.HARD_TIMEOUT_MS + 5000;
const KILL_TIMEOUT_MS = 5000;

// A checker is due when it has never run, or its interval has elapsed since the
// last run. interval comes from compile-time meta (seconds).
function isDue(runtime, meta, now) {
  if (!runtime || runtime.lastRunAt == null) return true;
  const intervalMs = (meta.interval || 300) * 1000;
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

// Run every DUE checker once. Transition dedupe lives inside each checker (its
// state sidecar); the daemon just relays a non-empty line to the notifier and
// records last-fired. Trust is re-verified per run inside runChecker.
//
// Pure enough to unit-test: pass `now` and an optional `notifyFn`/`logFn`.
function runDue(opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const notifyFn = opts.notifyFn || notify.dispatch;
  const logFn = opts.logFn || (() => {});
  const results = [];

  for (const id of store.listIds()) {
    let meta;
    try {
      meta = store.readMeta(id);
    } catch {
      continue;
    }
    const runtime = store.readRuntime(id);
    if (!isDue(runtime, meta, now)) continue;

    const res = run.runChecker(id);
    const updated = { ...runtime, lastRunAt: now };

    if (res.refused) {
      updated.lastError = res.reason;
      store.writeRuntime(id, updated);
      logFn(`REFUSED ${id}: ${res.reason}`);
      results.push({ id, refused: true, reason: res.reason });
      continue;
    }

    updated.lastState = readState(id);

    if (res.error) {
      updated.lastError = res.error;
      store.writeRuntime(id, updated);
      logFn(`ERROR ${id}: ${res.error}`);
      results.push({ id, fired: false, timedOut: res.timedOut, error: res.error });
      continue;
    }

    if (res.output) {
      const disp = notifyFn(meta.route, `watchtell: ${meta.request}`, res.output);
      updated.lastOutput = res.output;
      if (!disp || !disp.ok) {
        updated.lastError = 'notification dispatch failed';
        store.writeRuntime(id, updated);
        logFn(`NOTIFY FAILED ${id}: ${res.output}`);
        results.push({ id, fired: false, output: res.output, dispatch: disp });
        continue;
      }
      updated.lastError = null;
      updated.lastFiredAt = now;
      store.writeRuntime(id, updated);
      logFn(`FIRED ${id} [${disp && disp.route}]: ${res.output}`);
      results.push({ id, fired: true, output: res.output, dispatch: disp });
    } else {
      updated.lastError = null;
      store.writeRuntime(id, updated);
      if (res.timedOut) logFn(`TIMEOUT ${id}`);
      results.push({ id, fired: false, timedOut: res.timedOut });
    }
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

// Run the blocking loop in THIS process until signalled. Reclaims a stale pid file.
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
