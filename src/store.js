'use strict';

const fs = require('fs');
const crypto = require('crypto');
const paths = require('./paths');

const SUPPORTED_ROUTES = ['notify'];

function ensureHome() {
  fs.mkdirSync(paths.checkersDir(), { recursive: true });
}

// Short, typeable, collision-checked id for use in `list`/`test`/`rm`. Skip ids
// that still carry a tombstone (a prior rm not yet reaped) so a recycled id can
// never be swept away as if it were the removed checker.
function newId() {
  ensureHome();
  for (let i = 0; i < 100; i++) {
    const id = crypto.randomBytes(4).toString('hex').slice(0, 6);
    if (!fs.existsSync(paths.metaPath(id)) && !fs.existsSync(paths.tombstonePath(id))) return id;
  }
  throw new Error('could not allocate a unique checker id');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePrivateJson(file, obj) {
  const json = JSON.stringify(obj, null, 2) + '\n';
  const fd = fs.openSync(file, 'w', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, json, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function writeMeta(id, meta) {
  writePrivateJson(paths.metaPath(id), meta);
}

function readMeta(id) {
  return readJson(paths.metaPath(id));
}

function exists(id) {
  return fs.existsSync(paths.metaPath(id));
}

function readRuntime(id) {
  const file = paths.runtimePath(id);
  if (!fs.existsSync(file)) {
    return { lastRunAt: null, lastFiredAt: null, lastState: null, lastOutput: null };
  }
  try {
    return readJson(file);
  } catch {
    return { lastRunAt: null, lastFiredAt: null, lastState: null, lastOutput: null };
  }
}

function writeRuntime(id, runtime) {
  writePrivateJson(paths.runtimePath(id), runtime);
}

// Every checker id present on disk, sorted by creation time (oldest first).
function listIds() {
  const dir = paths.checkersDir();
  if (!fs.existsSync(dir)) return [];
  const ids = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => f.slice(0, -'.meta.json'.length))
    .filter((id) => /^[0-9a-f]{6}$/.test(id));
  ids.sort((a, b) => {
    const ta = safeCreatedAt(a);
    const tb = safeCreatedAt(b);
    return ta - tb;
  });
  return ids;
}

function safeCreatedAt(id) {
  try {
    return new Date(readMeta(id).createdAt).getTime() || 0;
  } catch {
    return 0;
  }
}

// Every sidecar a checker owns, excluding the tombstone.
function sidecars(id) {
  return [
    paths.scriptPath(id),
    paths.trustPath(id),
    paths.metaPath(id),
    paths.statePath(id),
    paths.runtimePath(id),
  ];
}

function unlinkAll(files) {
  let removed = false;
  for (const t of files) {
    if (fs.existsSync(t)) {
      fs.rmSync(t, { force: true });
      removed = true;
    }
  }
  return removed;
}

// True while a tombstone marks the id as removed but not yet reaped.
function isRemoved(id) {
  return fs.existsSync(paths.tombstonePath(id));
}

// Delete a checker and every sidecar it owns (script, trust, meta, state, runtime).
// The tombstone is written FIRST and left behind: a daemon tick already in flight
// on this id re-checks the tombstone before every write and around each run, so it
// discards any resurrected file instead of leaving an orphan. The daemon reaps the
// tombstone (finalizeRemoval) once nothing is left to revive. Crash-safe: if rm dies
// mid-delete the tombstone survives, so the daemon still finishes the cleanup.
function remove(id) {
  fs.writeFileSync(paths.tombstonePath(id), '', { mode: 0o600 });
  return unlinkAll(sidecars(id));
}

// Reap a removed id: drop any resurrected sidecar, then the tombstone LAST (so a
// crash between the two still leaves a tombstone to retry). Returns true if any
// sidecar was actually present (a resurrection worth logging once).
function finalizeRemoval(id) {
  const revived = unlinkAll(sidecars(id));
  fs.rmSync(paths.tombstonePath(id), { force: true });
  return revived;
}

// Ids currently tombstoned (removed, awaiting reap).
function listTombstones() {
  const dir = paths.checkersDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.removed'))
    .map((f) => f.slice(0, -'.removed'.length))
    .filter((id) => /^[0-9a-f]{6}$/.test(id));
}

module.exports = {
  SUPPORTED_ROUTES,
  ensureHome,
  newId,
  writeMeta,
  readMeta,
  exists,
  readRuntime,
  writeRuntime,
  listIds,
  remove,
  isRemoved,
  finalizeRemoval,
  listTombstones,
};
