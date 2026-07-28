'use strict';

// Child process invoked by src/webhook.js `deliver`: read a JSON body from stdin
// and POST it as application/json to argv[2]. Exit 0 on a 2xx response, 1 on any
// non-2xx, transport error, redirect, or timeout. Kept out-of-line so the
// daemon's synchronous dispatch path can POST via spawnSync without becoming
// async or adding a runtime dependency (Node >= 20 `fetch`, no new deps).

const url = process.argv[2];
const timeoutMs = parseInt(process.env.WATCHTELL_WEBHOOK_TIMEOUT_MS || '', 10) || 10000;

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  body += chunk;
});
process.stdin.on('end', () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    // Never follow redirects: a webhook URL may embed a secret, and a redirect
    // could re-POST the body (and its context) somewhere else. Treat 3xx as a
    // failed dispatch instead.
    redirect: 'error',
    signal: controller.signal,
  })
    .then((res) => {
      clearTimeout(timer);
      process.exit(res.ok ? 0 : 1);
    })
    .catch(() => {
      clearTimeout(timer);
      process.exit(1);
    });
});
