'use strict';

const { spawnSync } = require('child_process');

// The PROVEN compile prompt from the watchtell-spike-v1 report (94.7% no-edit
// compile reliability), extended with the ONE portability hint the spike's sole
// failure (bash 3.2 empty-array under `set -u`) mandated. Do not tune per
// category — a single general prompt is the whole point.
const COMPILE_PROMPT = `You are watchtell's compiler. Convert ONE natural-language alarm request into a deterministic bash "checker" script that a scheduler will run repeatedly.

CONTRACT — the checker you output MUST obey all of these:
1. DETERMINISTIC: no LLM or AI calls at runtime. Use only ordinary tools (curl, jq, grep, awk, sed, lsof, pgrep, cmp, etc.).
2. SILENT BY DEFAULT: produce NO stdout at all when nothing alarm-worthy has happened.
3. TRANSITION-ONLY, ONE LINE: print EXACTLY ONE human-readable line ONLY when the watched condition TRANSITIONS (ok->failing, below->above a threshold, present->absent, old->new release, up->down, etc.). Persist the previous state in a sidecar file so the SAME ongoing condition does NOT re-alarm on every poll. A recovery transition back (e.g. failing->ok) MAY also print one line when meaningful.
4. STATE SIDECAR: read and write your previous state from the file path in environment variable $WATCHTELL_STATE; if it is unset, default to "\${0}.state". On the FIRST run (no prior state yet) just record the current observation and stay SILENT — never alarm on the first run merely because there is no history.
5. TIMELY + FAIL SAFE: finish within 30 seconds (use curl --max-time etc.). If the probe ITSELF errors (network down, missing tool, non-parseable output), do NOT emit an alarm unless the request is specifically about that failure; stay silent and keep the previous state.
6. PORTABILITY: the target shell is macOS default bash 3.2. Under \`set -u\` do NOT expand an empty or unset array as "\${arr[@]}" (bash 3.2 raises "unbound variable"). Build optional arguments as plain strings/variables, or guard with "\${arr[@]+"\${arr[@]}"}".

OUTPUT FORMAT — output ONLY the block below. No markdown code fences, no explanation before or after:
<<<META>>>
interval=<integer poll seconds>
route=<notify|slack>
<<<SCRIPT>>>
#!/usr/bin/env bash
<the complete self-contained checker script>
<<<END>>>

The natural-language alarm request:
`;

class CompileError extends Error {}

// Parse the spike's <<<META>>>/<<<SCRIPT>>>/<<<END>>> delimiter format out of
// the raw agent output. Tolerant of leading/trailing noise around the block.
function parse(raw) {
  const metaMatch = raw.match(/<<<META>>>\n([\s\S]*?)\n<<<SCRIPT>>>/);
  const scriptMatch = raw.match(/<<<SCRIPT>>>\n([\s\S]*?)\n<<<END>>>/);
  if (!metaMatch || !scriptMatch) {
    throw new CompileError(
      'agent output did not contain the expected <<<META>>>/<<<SCRIPT>>>/<<<END>>> block'
    );
  }
  const meta = { interval: 300, route: 'notify' };
  for (const line of metaMatch[1].split('\n')) {
    const m = line.match(/^\s*(interval|route)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    if (m[1] === 'interval') {
      const n = parseInt(m[2], 10);
      if (Number.isFinite(n) && n > 0) meta.interval = n;
    } else {
      meta.route = m[2];
    }
  }
  let script = scriptMatch[1];
  if (!script.endsWith('\n')) script += '\n';
  if (!/^#!/.test(script)) {
    throw new CompileError('generated checker is missing a shebang line');
  }
  return { meta, script };
}

// Resolve which agent CLI to invoke. WATCHTELL_COMPILER_CMD overrides everything
// (used by tests / fixture compilers): it is run via `sh -c` with the full prompt
// on stdin. Otherwise prefer an installed `claude`, then `codex`. No API keys.
function resolveCommand() {
  const override = process.env.WATCHTELL_COMPILER_CMD;
  if (override) {
    return { file: 'sh', args: ['-c', override], label: override };
  }
  if (which('claude')) {
    // Print mode, prompt on stdin — exactly as the spike drove it.
    return { file: 'claude', args: ['-p'], label: 'claude' };
  }
  if (which('codex')) {
    // Codex non-interactive exec, prompt on stdin.
    return { file: 'codex', args: ['exec', '-'], label: 'codex' };
  }
  throw new CompileError(
    'no agent CLI found. Install `claude` or `codex` on your PATH (already authenticated, no API key needed) so watchtell can compile the request.'
  );
}

function which(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() !== '';
}

// Default compile timeout. Complex requests (authenticated checkers with
// link-list extraction, multi-step transitions, dedupe) can legitimately need
// ~200-300s of agent reasoning; the old 180s cap killed them mid-thought.
const DEFAULT_COMPILE_TIMEOUT_MS = 600000;
// Total attempts on a TIMEOUT (1 initial + 1 retry). Latency is variable, so a
// fresh call often lands in a faster band; work stays bounded at 2 x timeout.
const MAX_COMPILE_ATTEMPTS = 2;

// Resolve the per-attempt timeout in ms. Precedence: explicit opts.timeoutMs
// (tests) > WATCHTELL_COMPILE_TIMEOUT (whole seconds) > default. Invalid or
// non-positive env values are ignored and fall back to the default.
function resolveTimeoutMs(opts = {}) {
  if (opts.timeoutMs) return opts.timeoutMs;
  const raw = process.env.WATCHTELL_COMPILE_TIMEOUT;
  if (raw != null && raw.trim() !== '') {
    const secs = Number(raw);
    const timeoutMs = secs * 1000;
    if (
      Number.isInteger(secs) &&
      secs > 0 &&
      Number.isFinite(timeoutMs) &&
      Number.isInteger(timeoutMs) &&
      timeoutMs > 0
    ) {
      return timeoutMs;
    }
  }
  return DEFAULT_COMPILE_TIMEOUT_MS;
}

// spawnSync reports a timeout by killing the child (SIGTERM) and setting
// r.error.code === 'ETIMEDOUT'. Verified on this Node.
function isTimeout(r) {
  return !!(r.error && r.error.code === 'ETIMEDOUT');
}

// Compile a natural-language request into { meta, script, agent } by invoking the
// agent CLI. The full prompt (fixed contract + request) is fed on stdin. A
// TIMEOUT (and only a timeout) is retried once — other failures are not
// transient and surface immediately.
function compile(request, opts = {}) {
  const cmd = opts.command || resolveCommand();
  const prompt = COMPILE_PROMPT + request + '\n';
  const timeoutMs = resolveTimeoutMs(opts);
  for (let attempt = 1; attempt <= MAX_COMPILE_ATTEMPTS; attempt++) {
    process.stderr.write('compiling (this can take a minute)...\n');
    const r = spawnSync(cmd.file, cmd.args, {
      input: prompt,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
    });
    if (isTimeout(r)) {
      if (attempt < MAX_COMPILE_ATTEMPTS) {
        process.stderr.write(
          `compile timed out, retrying (${attempt + 1}/${MAX_COMPILE_ATTEMPTS})...\n`
        );
        continue;
      }
      throw new CompileError(
        `compiler (${cmd.label}) timed out after ${MAX_COMPILE_ATTEMPTS} attempts ` +
          `of ${Math.round(timeoutMs / 1000)}s each. Set WATCHTELL_COMPILE_TIMEOUT ` +
          `(seconds) higher if the request is legitimately complex.`
      );
    }
    if (r.error) {
      throw new CompileError(`failed to run compiler (${cmd.label}): ${r.error.message}`);
    }
    if (r.status !== 0) {
      throw new CompileError(
        `compiler (${cmd.label}) exited ${r.status}: ${(r.stderr || '').trim() || 'no stderr'}`
      );
    }
    const parsed = parse(r.stdout);
    return { ...parsed, agent: cmd.label, raw: r.stdout };
  }
}

module.exports = {
  COMPILE_PROMPT,
  CompileError,
  parse,
  resolveCommand,
  resolveTimeoutMs,
  compile,
  DEFAULT_COMPILE_TIMEOUT_MS,
};
