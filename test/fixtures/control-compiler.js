'use strict';
// Test fixture: stands in for `claude -p`. Consumes the prompt on stdin and emits
// a checker in the <<<META>>>/<<<SCRIPT>>>/<<<END>>> format whose script carries a
// review-spoofing control character selected by env — no live LLM.
//
// Knobs via env:
//   CONTROL_KIND         esc | cr | rlo | lri | lrm | del | c1 | nul | clean (default esc)
//   CONTROL_CLEAN_AFTER  emit a clean checker once the attempt counter exceeds N
//   CONTROL_ROUTE_BAD    when set, put an ESC sequence into the meta route instead
//   CONTROL_MARKER       file the checker touches if it is ever executed
//   FLAKY_COUNTER        attempt counter file (incremented per invocation)
//
// All control characters are written as escapes so this file itself stays clean.

const fs = require('fs');

fs.readFileSync(0); // consume the prompt

let n = 0;
const counter = process.env.FLAKY_COUNTER;
if (counter) {
  try {
    n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0;
  } catch {
    n = 0;
  }
  n += 1;
  fs.writeFileSync(counter, String(n));
}

const CONTROLS = {
  esc: `${String.fromCharCode(0x1b)}[2K${String.fromCharCode(0x1b)}[1A`,
  cr: String.fromCharCode(0x0d),
  rlo: String.fromCharCode(0x202e),
  lri: String.fromCharCode(0x2066),
  lrm: String.fromCharCode(0x200e),
  del: String.fromCharCode(0x7f),
  c1: String.fromCharCode(0x85),
  nul: String.fromCharCode(0x00),
  clean: '',
};

let kind = process.env.CONTROL_KIND || 'esc';
const cleanAfter = process.env.CONTROL_CLEAN_AFTER;
if (cleanAfter != null && n > Number(cleanAfter)) kind = 'clean';
const routeBad = Boolean(process.env.CONTROL_ROUTE_BAD) && kind !== 'clean';
const bad = routeBad ? '' : CONTROLS[kind];
const marker = process.env.CONTROL_MARKER || '/dev/null';

// Ordinary Unicode that must stay allowed: Korean, emoji, an emoji ZWJ sequence
// (U+1F469 U+200D U+1F4BB), and a literal TAB.
const ZWJ_EMOJI = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
const ordinary = `알림 ✅ ${ZWJ_EMOJI}${String.fromCharCode(0x09)}done`;

const script = [
  '#!/usr/bin/env bash',
  'set -u',
  `: > "${marker}"`,
  `printf '%s\\n' "${ordinary}${bad}" >/dev/null`,
  'exit 0',
].join('\n');

const route = routeBad ? `notify${String.fromCharCode(0x1b)}[8m` : 'notify';
process.stdout.write(
  `<<<META>>>\ninterval=300\nroute=${route}\n<<<SCRIPT>>>\n${script}\n<<<END>>>\n`
);
