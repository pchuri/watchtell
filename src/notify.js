'use strict';

const { spawnSync } = require('child_process');
const store = require('./store');

// Dispatch a notification for a checker's transition line.
//
// v0.1 supports exactly one route: `notify` = macOS Notification Center. Any
// other route (e.g. `slack`) was accepted at compile time but is relayed
// through `notify` here (the Slack webhook plugin is v0.2).
//
// Delivery preference (highest first):
//   1. WATCHTELL_NOTIFY_CMD override (tests/mocks): run via `sh -c` with
//      WATCHTELL_TITLE / WATCHTELL_MESSAGE / WATCHTELL_ROUTE in the environment.
//   2. terminal-notifier when on PATH: sent with an args array (no shell string).
//      When the message contains a URL it is passed as `-open <url>`, making the
//      notification click-to-open. Strictly optional; absent -> fall back.
//   3. osascript `display notification` (no extra dependency).
function dispatch(route, title, message, opts = {}) {
  const effectiveRoute = store.SUPPORTED_ROUTES.includes(route) ? route : 'notify';
  const override = process.env.WATCHTELL_NOTIFY_CMD;
  if (override) {
    const r = spawnSync('sh', ['-c', override], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WATCHTELL_TITLE: title,
        WATCHTELL_MESSAGE: message,
        WATCHTELL_ROUTE: effectiveRoute,
      },
    });
    return { ok: r.status === 0, route: effectiveRoute, requestedRoute: route };
  }

  // Injectable seam for tests: pass `terminalNotifierPath` (a path, or null to
  // force the osascript fallback). Otherwise detect once, cached.
  const tnPath = 'terminalNotifierPath' in opts
    ? opts.terminalNotifierPath
    : detectTerminalNotifier();
  if (tnPath) {
    const args = buildTerminalNotifierArgs({ title, message });
    const r = spawnSync(tnPath, args, { encoding: 'utf8' });
    return { ok: r.status === 0, route: effectiveRoute, requestedRoute: route };
  }

  const script = `display notification ${quote(message)} with title ${quote(title)}`;
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  return { ok: r.status === 0, route: effectiveRoute, requestedRoute: route };
}

// Build terminal-notifier argv. Never a shell string: title/message/url are
// discrete array elements, so no shell-injection surface. `-open <url>` is
// added only when the message carries a URL.
function buildTerminalNotifierArgs({ title, message }) {
  const args = ['-title', String(title), '-message', String(message)];
  const url = extractOpenUrl(message);
  if (url) args.push('-open', url);
  return args;
}

// Extract the first http(s) URL from a message, trimming trailing punctuation
// (e.g. a URL ending a sentence). Returns null when none is present.
function extractOpenUrl(message) {
  const m = String(message).match(/https?:\/\/[^\s]+/);
  if (!m) return null;
  return m[0].replace(/[.,;:!?)\]}'"]+$/, '') || null;
}

let cachedTerminalNotifierPath; // undefined = not yet probed
function detectTerminalNotifier() {
  if (cachedTerminalNotifierPath !== undefined) return cachedTerminalNotifierPath;
  const r = spawnSync('sh', ['-c', 'command -v terminal-notifier'], { encoding: 'utf8' });
  cachedTerminalNotifierPath = r.status === 0 ? r.stdout.trim() || null : null;
  return cachedTerminalNotifierPath;
}

// AppleScript string literal: wrap in double quotes, escape backslash and quote.
function quote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

module.exports = { dispatch, buildTerminalNotifierArgs, extractOpenUrl };
