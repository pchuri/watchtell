'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

// Mirror the checker-run timeout convention (run.js WATCHTELL_TIMEOUT_MS): an
// env-tunable millisecond bound with a sane default. A webhook POST that does not
// complete within this is a failed dispatch, so the owed-alarm queue retries it.
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 300000;
const POSTER = path.join(__dirname, 'webhook-post.js');

// Validate a user-supplied webhook target URL. Accept only http/https and
// parseable URLs; reject everything else (garbage, ftp, empty). Returns the
// normalized href. Throws Error with a user-facing message on invalid input.
function validateUrl(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new Error('webhook URL is empty');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('invalid webhook URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('webhook URL must be http or https');
  }
  if (u.username || u.password) {
    throw new Error('webhook URL must not include credentials');
  }
  return u.href;
}

// Redact a webhook URL for logs / CLI output: scheme + host only, never the path
// or query. Slack/Discord/ntfy webhook secrets live in the path, so the full URL
// must never be printed. Returns e.g. `https://hooks.slack.com`.
function redactUrl(raw) {
  try {
    const u = new URL(String(raw));
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<redacted>';
  }
}

// The stable, minimal JSON payload POSTed when an alarm fires. Documented in
// README ("Notifications"). Field order/names are the public contract.
function buildPayload({ id, request, message, firedAt }) {
  return { id, request, message, firedAt };
}

function resolveTimeoutMs(opts) {
  const raw = opts.timeoutMs ?? process.env.WATCHTELL_WEBHOOK_TIMEOUT_MS;
  if (raw == null || (typeof raw === 'string' && !raw.trim())) return DEFAULT_TIMEOUT_MS;

  const timeoutMs = Number(raw);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    return DEFAULT_TIMEOUT_MS;
  }
  return timeoutMs;
}

// Deliver one alarm payload by POSTing application/json to `url`. Synchronous by
// design: the daemon's dispatch path is synchronous and reuses the notify
// backend's spawnSync style, so we run a tiny Node child (webhook-post.js) that
// performs the fetch and exits 0 on 2xx, non-zero otherwise. Returns { ok }.
function deliver(url, payload, opts = {}) {
  const timeoutMs = resolveTimeoutMs(opts);
  const spawn = opts.spawnSyncFn || spawnSync;
  try {
    const child = spawn(process.execPath, [POSTER], {
      input: JSON.stringify({ url: String(url), payload }),
      encoding: 'utf8',
      // Give the parent a little headroom over the child's own fetch timeout so a
      // clean non-2xx/timeout exit is observed rather than a hard kill.
      timeout: timeoutMs + 2000,
      env: { ...process.env, WATCHTELL_WEBHOOK_TIMEOUT_MS: String(timeoutMs) },
    });
    return { ok: child.status === 0 };
  } catch {
    return { ok: false };
  }
}

module.exports = {
  validateUrl,
  redactUrl,
  buildPayload,
  deliver,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
};
