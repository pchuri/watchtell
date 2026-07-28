'use strict';

// Child process invoked by src/webhook.js `deliver`: read the target URL and
// JSON payload from stdin and POST the payload as application/json. Exit 0 on a
// 2xx response, 1 on any non-2xx, transport error, redirect, or timeout. Kept
// out-of-line so the daemon's synchronous dispatch path can POST via spawnSync
// without becoming async or adding a runtime dependency (Node >= 20 `fetch`, no
// new deps).

const timeoutMs = parseInt(process.env.WATCHTELL_WEBHOOK_TIMEOUT_MS || '', 10) || 10000;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let envelope;
  try {
    envelope = JSON.parse(input);
  } catch {
    process.exit(1);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  fetch(envelope.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope.payload),
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
