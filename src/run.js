'use strict';

const fs = require('fs');
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
//
// Returns:
//   { refused: true, reason }                       — trust check failed, not run
//   { refused: false, output, timedOut, exitCode }  — ran; output is trimmed stdout
function runChecker(id, opts = {}) {
  const v = trust.verify(id);
  if (!v.ok) {
    return { refused: true, reason: v.reason };
  }
  const timeout = resolveTimeout(opts);
  const stateFile = paths.statePath(id);
  const priorState = readState(stateFile);
  const r = spawnSync('bash', [paths.scriptPath(id)], {
    encoding: 'utf8',
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    env: { ...process.env, WATCHTELL_STATE: stateFile },
  });
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
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

module.exports = { HARD_TIMEOUT_MS, runChecker };
