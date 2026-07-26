'use strict';

const fs = require('fs');
const crypto = require('crypto');
const paths = require('./paths');

const SUPPORTED_ROUTES = ['notify'];

function ensureHome() {
  fs.mkdirSync(paths.checkersDir(), { recursive: true });
}

// Short, typeable, collision-checked id for use in `list`/`test`/`rm`.
function newId() {
  ensureHome();
  for (let i = 0; i < 100; i++) {
    const id = crypto.randomBytes(4).toString('hex').slice(0, 6);
    if (!fs.existsSync(paths.metaPath(id))) return id;
  }
  throw new Error('could not allocate a unique checker id');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj, mode) {
  const opts = mode ? { mode } : undefined;
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', opts);
}

function writeMeta(id, meta) {
  writeJson(paths.metaPath(id), meta);
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
  writeJson(paths.runtimePath(id), runtime);
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

// Delete a checker and every sidecar it owns (script, trust, meta, state, runtime).
function remove(id) {
  const targets = [
    paths.scriptPath(id),
    paths.trustPath(id),
    paths.metaPath(id),
    paths.statePath(id),
    paths.runtimePath(id),
  ];
  let removed = false;
  for (const t of targets) {
    if (fs.existsSync(t)) {
      fs.rmSync(t, { force: true });
      removed = true;
    }
  }
  return removed;
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
};
