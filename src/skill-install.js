'use strict';

// Install the repo's coding-agent skill (skills/watchtell) into the user-level
// skill directories of supported agents by SYMLINK, so a `git pull` in the clone
// keeps the installed skill current. The core is pure and takes explicit
// homeDir/source paths so tests exercise it against a temp dir, never real ~/.
//
// Never overwrite: a real file/dir or a foreign symlink at the target is reported
// as skipped with a manual-fix hint. Uninstall removes only a symlink that points
// at this clone (or, with force, any watchtell symlink there); it never deletes a
// real directory.

const fs = require('fs');
const path = require('path');

// Supported agents and their standard user-level skill locations, relative to
// the user's home directory. These are the documented standard paths, so their
// parents are created with mkdir -p.
const AGENTS = [
  { key: 'claude', label: 'Claude Code', subdir: ['.claude', 'skills', 'watchtell'] },
  { key: 'codex', label: 'codex', subdir: ['.codex', 'skills', 'watchtell'] },
];

// Absolute path to the skill directory inside THIS clone, resolved from the
// running script's location (not cwd) so the symlink source is stable.
function skillSourceDir() {
  return path.resolve(__dirname, '..', 'skills', 'watchtell');
}

function targetsFor(homeDir, keys) {
  const wanted = keys && keys.length ? new Set(keys) : null;
  return AGENTS.filter((a) => !wanted || wanted.has(a.key)).map((a) => ({
    key: a.key,
    label: a.label,
    linkPath: path.join(homeDir, ...a.subdir),
  }));
}

// Resolve where a symlink at linkPath points, as an absolute path; null if it is
// not a symlink or cannot be read.
function symlinkTarget(linkPath) {
  let dest;
  try {
    dest = fs.readlinkSync(linkPath);
  } catch {
    return null;
  }
  return path.resolve(path.dirname(linkPath), dest);
}

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// Install one target. Returns { key, label, linkPath, status, message, points }.
// status: 'installed' | 'already-installed' | 'skipped'.
function installTarget(target, source) {
  const { linkPath } = target;
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });

  const st = lstat(linkPath);
  if (st && st.isSymbolicLink()) {
    const points = symlinkTarget(linkPath);
    if (points === source) {
      return { ...target, status: 'already-installed', points };
    }
    return {
      ...target,
      status: 'skipped',
      points,
      message:
        `a different symlink is already here (-> ${points}). ` +
        `Remove it first: rm "${linkPath}"`,
    };
  }
  if (st) {
    const kind = st.isDirectory() ? 'directory' : 'file';
    return {
      ...target,
      status: 'skipped',
      message:
        `a real ${kind} already exists here. ` +
        `Move or remove it first, then re-run: rm -rf "${linkPath}"`,
    };
  }

  fs.symlinkSync(source, linkPath);
  return { ...target, status: 'installed', points: source };
}

// Uninstall one target. Removes only a symlink pointing at `source` (or, with
// force, any symlink at the path). Never deletes a real directory. Idempotent.
// status: 'removed' | 'absent' | 'skipped'.
function uninstallTarget(target, source, { force = false } = {}) {
  const { linkPath } = target;
  const st = lstat(linkPath);
  if (!st) return { ...target, status: 'absent' };
  if (!st.isSymbolicLink()) {
    const kind = st.isDirectory() ? 'directory' : 'file';
    return {
      ...target,
      status: 'skipped',
      message: `a real ${kind} is here, not a symlink; refusing to delete it`,
    };
  }
  const points = symlinkTarget(linkPath);
  if (!force && points !== source) {
    return {
      ...target,
      status: 'skipped',
      points,
      message:
        `symlink points elsewhere (-> ${points}); ` +
        `not ours. Use --force to remove any watchtell symlink here`,
    };
  }
  fs.rmSync(linkPath);
  return { ...target, status: 'removed', points };
}

// Report one target's state. status: 'installed' | 'installed-other' |
// 'not-installed' | 'real-path'.
function statusTarget(target, source) {
  const { linkPath } = target;
  const st = lstat(linkPath);
  if (!st) return { ...target, status: 'not-installed' };
  if (st.isSymbolicLink()) {
    const points = symlinkTarget(linkPath);
    return {
      ...target,
      status: points === source ? 'installed' : 'installed-other',
      points,
    };
  }
  const kind = st.isDirectory() ? 'directory' : 'file';
  return { ...target, status: 'real-path', message: `a real ${kind} is here`, kind };
}

function install(opts = {}) {
  const source = opts.source || skillSourceDir();
  return targetsFor(opts.homeDir, opts.keys).map((t) => installTarget(t, source));
}

function uninstall(opts = {}) {
  const source = opts.source || skillSourceDir();
  return targetsFor(opts.homeDir, opts.keys).map((t) =>
    uninstallTarget(t, source, { force: opts.force })
  );
}

function status(opts = {}) {
  const source = opts.source || skillSourceDir();
  return targetsFor(opts.homeDir, opts.keys).map((t) => statusTarget(t, source));
}

module.exports = {
  AGENTS,
  skillSourceDir,
  targetsFor,
  installTarget,
  uninstallTarget,
  statusTarget,
  install,
  uninstall,
  status,
};
