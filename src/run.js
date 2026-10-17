'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');
const trust = require('./trust');

const HARD_TIMEOUT_MS = 30000; // 30s hard timeout per run (checker contract).

// Resolve the per-run timeout: explicit opt, else env override (tests), else 30s.
function resolveTimeout(opts) {
  if (opts.timeoutMs) return opts.timeoutMs;
  const env = parseInt(process.env.WATCHTELL_TIMEOUT_MS || '', 10);
  return Number.isFinite(env) && env > 0 ? env : HARD_TIMEOUT_MS;
}

// Run a checker exactly once. The trust boundary is enforced here: the script is
// re-hashed against its trust record immediately before execution and REFUSED on
// any mismatch/absence — nothing is quarantined silently, the caller reports it.
function runChecker(id, opts = {}) {
  const v = trust.verify(id);
  if (!v.ok) {
    return { refused: true, reason: v.reason };
  }
  return execute(paths.scriptPath(id), paths.statePath(id), opts);
}

// Preview a checker WITHOUT consuming its transition (`watchtell test`). The
// trusted bytes are read and hashed once, copied into a private temporary
// directory together with a copy of the current state sidecar, and executed
// there. The production state sidecar and runtime record are never written, so
// a transition the preview observes is still owed to the daemon, which detects
// and delivers it on its next due run. The temp directory is always removed.
//
// Deliberately NOT save-and-restore of the production state: restoring would
// overwrite any state a concurrently running daemon tick wrote in between.
function previewChecker(id, opts = {}) {
  const v = trust.verifyBytes(id);
  if (!v.ok) {
    return { refused: true, reason: v.reason };
  }
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(opts.tmpDir || os.tmpdir(), 'watchtell-preview-'));
    fs.chmodSync(dir, 0o700);
    const scriptFile = path.join(dir, 'check.sh');
    const stateFile = path.join(dir, 'check.state');
    fs.writeFileSync(scriptFile, v.bytes, { mode: 0o700 });
    const current = readState(paths.statePath(id));
    if (current.exists) fs.writeFileSync(stateFile, current.bytes, { mode: 0o600 });
    const res = execute(scriptFile, stateFile, opts);
    const after = readState(stateFile);
    const previewState = after.exists ? after.bytes.toString('utf8').trim() || null : null;
    return { ...res, preview: true, previewState };
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function execute(scriptFile, stateFile, opts) {
  const timeout = resolveTimeout(opts);
  const priorState = readState(stateFile);
  const r = spawnSync('bash', [scriptFile], {
    detached: true,
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    env: { ...process.env, WATCHTELL_STATE: stateFile },
  });
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  if (timedOut) killProcessGroup(r.pid);
  const succeeded = !r.error && r.status === 0;
  if (!succeeded) restoreState(stateFile, priorState);
  // A checker fires on transition by printing exactly one line; anything else is
  // silence. We relay the first non-empty line as the alarm.
  const output = succeeded ? firstLine(r.stdout) : '';
  const stderr = (r.stderr || '').trim();
  return {
    refused: false,
    timedOut,
    exitCode: r.status,
    output,
    stderr,
    error: succeeded ? null : checkerError(r, stderr, timedOut),
  };
}

function killProcessGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function readState(file) {
  try {
    return { exists: true, bytes: fs.readFileSync(file) };
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, bytes: null };
    throw e;
  }
}

function restoreState(file, priorState) {
  if (priorState.exists) {
    fs.writeFileSync(file, priorState.bytes);
  } else {
    fs.rmSync(file, { force: true });
  }
}

function checkerError(result, stderr, timedOut) {
  if (timedOut) return 'timed out';
  if (result.error) return result.error.message;
  if (stderr) return stderr;
  return `checker exited with status ${result.status}`;
}

function firstLine(stdout) {
  if (!stdout) return '';
  const line = stdout.split('\n').find((l) => l.trim() !== '');
  return line ? line.trim() : '';
}

module.exports = { HARD_TIMEOUT_MS, runChecker, previewChecker };
