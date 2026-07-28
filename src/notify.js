'use strict';

const { spawnSync } = require('child_process');
const store = require('./store');
const webhook = require('./webhook');

// Dispatch an alarm for a checker's transition line.
//
// Routes:
//   - `webhook` (with `opts.webhookUrl`): POST the alarm as JSON to that URL. On
//     failure, ALSO surface a best-effort local Notification Center note so a
//     broken webhook URL is never silent — this local note does not change the
//     dispatch result, so the owed-alarm queue accounts only for the POST.
//   - `notify` (and any other compiler-invented route, e.g. `slack`): deliver to
//     macOS Notification Center. Unsupported routes fall back to notify.
function dispatch(route, title, message, opts = {}) {
  if (route === 'webhook' && opts.webhookUrl) {
    const payload = webhook.buildPayload({
      id: opts.id,
      request: opts.request,
      message,
      firedAt: opts.firedAt,
    });
    const r = webhook.deliver(opts.webhookUrl, payload, { timeoutMs: opts.webhookTimeoutMs });
    if (!r.ok) {
      // Best-effort local surface; intentionally ignore its result.
      deliverLocal('watchtell: webhook delivery failed', `webhook delivery failed for ${opts.id}`, opts);
    }
    return { ok: r.ok, route: 'webhook', requestedRoute: 'webhook' };
  }
  const effectiveRoute = store.SUPPORTED_ROUTES.includes(route) ? route : 'notify';
  const r = deliverLocal(title, message, opts);
  return { ok: r.ok, route: effectiveRoute, requestedRoute: route };
}

// Deliver one note to macOS Notification Center. Returns { ok }.
//
// Delivery preference (highest first):
//   1. WATCHTELL_NOTIFY_CMD override (tests/mocks): run via `sh -c` with
//      WATCHTELL_TITLE / WATCHTELL_MESSAGE / WATCHTELL_ROUTE in the environment.
//   2. terminal-notifier when on PATH: sent with an args array (no shell string).
//      When the message contains a URL it is passed as `-open <url>`, making the
//      notification click-to-open. Strictly optional; absent -> fall back.
//   3. osascript `display notification` (no extra dependency).
function deliverLocal(title, message, opts = {}) {
  const override = process.env.WATCHTELL_NOTIFY_CMD;
  if (override) {
    const r = spawnSync('sh', ['-c', override], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WATCHTELL_TITLE: title,
        WATCHTELL_MESSAGE: message,
        WATCHTELL_ROUTE: 'notify',
      },
    });
    return { ok: r.status === 0 };
  }

  // Injectable seam for tests: pass `terminalNotifierPath` (a path, or null to
  // force the osascript fallback). Otherwise detect once, cached.
  const tnPath = 'terminalNotifierPath' in opts
    ? opts.terminalNotifierPath
    : detectTerminalNotifier();
  if (tnPath) {
    const args = buildTerminalNotifierArgs({ title, message });
    const r = spawnSync(tnPath, args, { encoding: 'utf8' });
    return { ok: r.status === 0 };
  }

  const script = `display notification ${quote(message)} with title ${quote(title)}`;
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  return { ok: r.status === 0 };
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

module.exports = { dispatch, deliverLocal, buildTerminalNotifierArgs, extractOpenUrl };
