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

// The generated, hash-bound bash checker.
function scriptPath(id) {
  return path.join(checkersDir(), `${id}.check.sh`);
}

// The trust record ("watchtell-check-v1\n<sha256>") that binds the script bytes.
function trustPath(id) {
  return path.join(checkersDir(), `${id}.check-trust`);
}

// Compile-time metadata: request text, interval, route, createdAt.
function metaPath(id) {
  return path.join(checkersDir(), `${id}.meta.json`);
}

// The checker's own state sidecar (exposed to it as $WATCHTELL_STATE).
function statePath(id) {
  return path.join(checkersDir(), `${id}.state`);
}

// Daemon-written runtime record: last run, last state, last fired, last output.
function runtimePath(id) {
  return path.join(checkersDir(), `${id}.runtime.json`);
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
  scriptPath,
  trustPath,
  metaPath,
  statePath,
  runtimePath,
  pidPath,
  logPath,
};
