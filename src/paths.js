'use strict';

const os = require('os');
const path = require('path');

// All watchtell state lives under a single home directory. Tests and callers
// override it via WATCHTELL_HOME; production defaults to ~/.watchtell.
function home() {
  return process.env.WATCHTELL_HOME || path.join(os.homedir(), '.watchtell');
}

function checkersDir() {
  return path.join(home(), 'checkers');
}

function validateId(id) {
  if (!/^[0-9a-f]{6}$/.test(id)) {
    throw new Error(`invalid checker id '${id}'`);
  }
  return id;
}

function checkerPath(id, suffix) {
  return path.join(checkersDir(), `${validateId(id)}${suffix}`);
}

// The generated, hash-bound bash checker.
function scriptPath(id) {
  return checkerPath(id, '.check.sh');
}

// The trust record ("watchtell-check-v1\n<sha256>") that binds the script bytes.
function trustPath(id) {
  return checkerPath(id, '.check-trust');
}

// Add-time metadata: id, request, interval, route, optional webhook URL, agent, createdAt.
function metaPath(id) {
  return checkerPath(id, '.meta.json');
}

// The checker's own state sidecar (exposed to it as $WATCHTELL_STATE).
function statePath(id) {
  return checkerPath(id, '.state');
}

// Daemon-written runtime record: last run, state, output, error, notification time,
// and any alarm awaiting delivery.
function runtimePath(id) {
  return checkerPath(id, '.runtime.json');
}

// Tombstone marker written by `rm` before it deletes a checker's sidecars. It
// outlives the delete so a daemon tick that overlaps the rm cannot resurrect any
// file for the id; the daemon reaps the tombstone once nothing is left to revive.
function tombstonePath(id) {
  return checkerPath(id, '.removed');
}

function pidPath() {
  return path.join(home(), 'daemon.pid');
}

function logPath() {
  return path.join(home(), 'daemon.log');
}

module.exports = {
  home,
  checkersDir,
  validateId,
  scriptPath,
  trustPath,
  metaPath,
  statePath,
  runtimePath,
  tombstonePath,
  pidPath,
  logPath,
};
