'use strict';

const fs = require('fs');
const crypto = require('crypto');
const paths = require('./paths');

const TRUST_VERSION = 'watchtell-check-v1';

// SHA256 of the exact script bytes on disk. The trust boundary is byte-exact:
// the daemon and `test` re-hash before every run and refuse on any mismatch.
function sha256File(file) {
  const bytes = fs.readFileSync(file);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Keep = bind: record "<version>\n<hash>" so the exact bytes are trusted.
function bind(id) {
  const script = paths.scriptPath(id);
  const hash = sha256File(script);
  fs.writeFileSync(paths.trustPath(id), `${TRUST_VERSION}\n${hash}\n`, { mode: 0o600 });
  return hash;
}

function parseTrust(text) {
  const lines = text.split('\n');
  const version = lines[0];
  const hash = lines[1];
  if (version !== TRUST_VERSION) return null;
  if (!/^[0-9a-f]{64}$/.test(hash || '')) return null;
  return { version, hash };
}

function readIfPresent(file, encoding) {
  try {
    return fs.readFileSync(file, encoding);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

// Re-hash the script and compare against the trust record, reading the script
// bytes exactly ONCE. On success the verified bytes are returned so a caller can
// execute precisely what was hashed (no re-read between verify and run).
function verifyBytes(id) {
  const script = paths.scriptPath(id);
  const trust = paths.trustPath(id);
  const bytes = readIfPresent(script);
  if (bytes == null) {
    return { ok: false, reason: 'checker script is missing' };
  }
  const trustText = readIfPresent(trust, 'utf8');
  if (trustText == null) {
    return { ok: false, reason: 'trust record is absent (checker was never kept)' };
  }
  const parsed = parseTrust(trustText);
  if (!parsed) {
    return { ok: false, reason: 'trust record is malformed' };
  }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== parsed.hash) {
    return { ok: false, reason: 'script hash mismatch — checker was modified after Keep' };
  }
  return { ok: true, hash: actual, bytes };
}

// Re-hash the script and compare against the trust record. Returns a structured
// result; the daemon/test refuse to run when ok is false and surface `reason`.
function verify(id) {
  const v = verifyBytes(id);
  if (!v.ok) return v;
  return { ok: true, hash: v.hash };
}

module.exports = { TRUST_VERSION, sha256File, bind, verify, verifyBytes };
