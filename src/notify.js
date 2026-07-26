'use strict';

const { spawnSync } = require('child_process');
const store = require('./store');

// Dispatch a notification for a checker's transition line.
//
// v0.1 supports exactly one route: `notify` = macOS Notification Center via
// osascript. Any other route (e.g. `slack`) was accepted at compile time but is
// relayed through `notify` here (the Slack webhook plugin is v0.2).
//
// WATCHTELL_NOTIFY_CMD overrides the dispatch command (used by tests to mock
// osascript): it is run via `sh -c` with WATCHTELL_TITLE / WATCHTELL_MESSAGE /
// WATCHTELL_ROUTE in the environment.
function dispatch(route, title, message) {
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
  const script = `display notification ${quote(message)} with title ${quote(title)}`;
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  return { ok: r.status === 0, route: effectiveRoute, requestedRoute: route };
}

// AppleScript string literal: wrap in double quotes, escape backslash and quote.
function quote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

module.exports = { dispatch };
