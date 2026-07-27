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
5. TIMELY + FAIL SAFE: keep the probe reasonably quick. The RUNTIME enforces a hard ~30s timeout and SIGKILLs any probe that overruns, so do NOT add tool-specific timeout or retry flags and do NOT assume any particular tool supports them — just write the probe naturally. If the probe ITSELF errors (network down, missing tool, non-parseable output), do NOT emit an alarm unless the request is specifically about that failure; stay silent and keep the previous state.
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

// Hard minimum poll interval (seconds). Enforced at registration (clamp, below)
// and again at runtime in the daemon (defense in depth against hand-edited
// meta.json). This is the ONE owner of the value — daemon.js imports it here.
// Clamping (not rejecting) preserves compiler-inferred interval behavior and
// gives explicit values below the floor the same effective minimum. Skill/README
// guidance still recommends >=5 min as best practice; this is only the abuse floor.
const MIN_INTERVAL_SECONDS = 60;

// Clamp an interval to the floor. Returns the effective interval plus a
// user-facing notice string when clamping occurred (null otherwise).
function clampInterval(seconds) {
  if (Number.isFinite(seconds) && seconds < MIN_INTERVAL_SECONDS) {
    return {
      interval: MIN_INTERVAL_SECONDS,
      notice: `interval ${seconds}s is below the ${MIN_INTERVAL_SECONDS}s minimum; using ${MIN_INTERVAL_SECONDS}s`,
    };
  }
  return { interval: seconds, notice: null };
}

// Parse an explicit `--interval` value into whole seconds. Accepts a plain
// integer (seconds) or a simple duration form with a single unit suffix:
// `90s`, `5m`, `1h`. Rejects zero, negatives, fractions, and garbage — the
// caller fails fast before spending an LLM compile. Does NOT apply the floor;
// clampInterval owns that so there is one floor definition.
function parseDuration(value) {
  const raw = String(value == null ? '' : value).trim();
  const m = raw.match(/^(\d+)(s|m|h)?$/i);
  if (!m) {
    throw new CompileError(
      `invalid --interval '${value}': use seconds (e.g. 600) or a duration (90s, 5m, 1h)`
    );
  }
  const n = parseInt(m[1], 10);
  const unit = (m[2] || 's').toLowerCase();
  const seconds = unit === 'h' ? n * 3600 : unit === 'm' ? n * 60 : n;
  if (!Number.isSafeInteger(seconds) || seconds <= 0) {
    throw new CompileError(
      `invalid --interval '${value}': must be a positive duration`
    );
  }
  return seconds;
}

class CompileError extends Error {}

// ---- ASCII-confusable lint -------------------------------------------------
//
// LLMs recurrently emit fullwidth/lookalike Unicode where ASCII code was meant
// (real incident: `.number｜tostring` with U+FF5C FULLWIDTH VERTICAL LINE instead
// of `|`). Such a checker passes the add-time immediate test — which only records
// the baseline — then silently loses its first real alarm when the confusable
// breaks jq/grep/etc. and the surrounding `2>/dev/null` guard swallows the error
// after the state sidecar already advanced. We gate at add time BEFORE keep/hash-bind.
//
// This is deliberately NOT a blanket non-ASCII ban: legitimate checkers carry
// non-ASCII in grep patterns and notification strings (e.g. Korean `권한이 없습니다`).
// We reject only a small, explicit list of characters that have NO legitimate use
// even inside a message string — a Korean message uses Korean, never a fullwidth
// ASCII lookalike — so a simple whole-file scan is safe and sufficient.

// Explicit lookalikes beyond the fullwidth block. Keep this small and commented,
// not a full Unicode-confusables database.
const CONFUSABLE_EXTRAS = new Map([
  [0x2018, "'"], // LEFT SINGLE QUOTATION MARK
  [0x2019, "'"], // RIGHT SINGLE QUOTATION MARK
  [0x201c, '"'], // LEFT DOUBLE QUOTATION MARK
  [0x201d, '"'], // RIGHT DOUBLE QUOTATION MARK
  [0x2013, '-'], // EN DASH
  [0x2014, '-'], // EM DASH
  [0x2212, '-'], // MINUS SIGN
  [0x00a0, ' '], // NO-BREAK SPACE
  [0x3000, ' '], // IDEOGRAPHIC (fullwidth) SPACE
]);

// Resolve the ASCII a code point resembles, or null if it is not a confusable we
// reject. Fullwidth forms U+FF01–U+FF5E map to their ASCII counterpart via the
// fixed 0xFEE0 offset (U+FF5C -> U+007C `|`); the extras table covers the rest.
function confusableAscii(cp) {
  if (cp >= 0xff01 && cp <= 0xff5e) return String.fromCharCode(cp - 0xfee0);
  return CONFUSABLE_EXTRAS.has(cp) ? CONFUSABLE_EXTRAS.get(cp) : null;
}

function hexCodepoint(cp) {
  return 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
}

// Scan a checker script for ASCII-confusable characters. Returns an array of
// findings { line, column, char, codepoint, ascii } (empty when clean). Column
// is a 1-based code-point index within the line.
function lintConfusables(script) {
  const findings = [];
  const lines = String(script).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const chars = Array.from(lines[i]); // code-point aware
    for (let c = 0; c < chars.length; c++) {
      const cp = chars[c].codePointAt(0);
      const ascii = confusableAscii(cp);
      if (ascii != null) {
        findings.push({
          line: i + 1,
          column: c + 1,
          char: chars[c],
          codepoint: hexCodepoint(cp),
          ascii,
        });
      }
    }
  }
  return findings;
}

// Format lint findings into a clear, multi-line failure message naming each
// offending line, character, code point, and the ASCII it resembles.
function formatConfusables(findings) {
  const lines = [
    'generated checker contains ASCII-confusable characters (likely a broken checker):',
  ];
  for (const f of findings) {
    lines.push(
      `  line ${f.line} col ${f.column}: '${f.char}' (${f.codepoint}) resembles ASCII '${f.ascii}'`
    );
  }
  return lines.join('\n');
}

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
  // Enforce the registration floor: a sub-minute LLM-inferred interval is
  // clamped up to the minimum so it cannot register abusive polling.
  const floored = clampInterval(meta.interval);
  meta.interval = floored.interval;

  let script = scriptMatch[1];
  if (!script.endsWith('\n')) script += '\n';
  if (!/^#!/.test(script)) {
    throw new CompileError('generated checker is missing a shebang line');
  }
  return { meta, script, intervalNotice: floored.notice };
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
// Total attempts for retriable compile failures (1 initial + 1 retry). A fresh
// call can avoid either transient latency or a model-emitted confusable.
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
      Number.isSafeInteger(timeoutMs) &&
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
// agent CLI. The full prompt (fixed contract + request) is fed on stdin.
// Timeouts and confusable output are retried once; other failures surface
// immediately.
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
    // ASCII-confusable gate: a checker with fullwidth/lookalike characters would
    // ship and then silently lose its first real alarm. Treat it like a timeout —
    // one retry (a fresh compile often avoids the glitch), then fail clearly.
    const findings = lintConfusables(parsed.script);
    if (findings.length > 0) {
      const message = formatConfusables(findings);
      if (attempt < MAX_COMPILE_ATTEMPTS) {
        process.stderr.write(
          `compile produced confusable characters, retrying (${attempt + 1}/${MAX_COMPILE_ATTEMPTS})...\n`
        );
        continue;
      }
      throw new CompileError(message);
    }
    return { ...parsed, agent: cmd.label, raw: r.stdout };
  }
}

module.exports = {
  COMPILE_PROMPT,
  CompileError,
  MIN_INTERVAL_SECONDS,
  clampInterval,
  parseDuration,
  parse,
  lintConfusables,
  formatConfusables,
  resolveCommand,
  resolveTimeoutMs,
  compile,
  DEFAULT_COMPILE_TIMEOUT_MS,
};
