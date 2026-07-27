'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { Command } = require('commander');

const paths = require('./paths');
const compile = require('./compile');
const store = require('./store');
const trust = require('./trust');
const run = require('./run');
const daemon = require('./daemon');
const launchd = require('./launchd');
const skillInstall = require('./skill-install');

function nowIso() {
  return new Date().toISOString();
}

function askYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

function fail(msg) {
  process.stderr.write(`watchtell: ${msg}\n`);
  process.exitCode = 1;
}

// ---- add -------------------------------------------------------------------

async function cmdAdd(request, options) {
  request = String(request || '').trim();
  if (!request) return fail('add requires a natural-language request');

  // Parse an explicit --interval BEFORE compiling so an invalid value fails
  // fast without spending an LLM compile.
  let forcedInterval = null;
  if (options.interval != null) {
    try {
      forcedInterval = compile.parseDuration(options.interval);
    } catch (e) {
      return fail(e.message);
    }
  }

  let compiled;
  try {
    compiled = compile.compile(request);
  } catch (e) {
    return fail(e.message);
  }

  const { meta, script } = compiled;

  // An explicit --interval WINS over whatever the compiler inferred; reuse the
  // single 60s floor owner so the flag value is clamped like any other.
  if (forcedInterval != null) {
    const floored = compile.clampInterval(forcedInterval);
    meta.interval = floored.interval;
    compiled.intervalNotice = floored.notice;
  }
  process.stdout.write(`\nCompiled by ${compiled.agent}. Generated checker:\n\n`);
  process.stdout.write(script.replace(/^/gm, '  '));
  if (compiled.intervalNotice) {
    process.stdout.write(`  ${compiled.intervalNotice}\n`);
  }
  process.stdout.write(`\n  meta: interval=${meta.interval}s route=${meta.route}\n`);
  if (!store.SUPPORTED_ROUTES.includes(meta.route)) {
    process.stdout.write(
      `  note: route '${meta.route}' not yet supported, using notify\n`
    );
  }
  process.stdout.write('\n');

  let keep = options.yes;
  if (keep) {
    process.stdout.write('--yes: keeping (trusting the generator without review)\n');
  } else {
    keep = await askYesNo('Keep this checker? (y/n) ');
  }
  if (!keep) {
    process.stdout.write('Discarded. Nothing was written.\n');
    return;
  }

  const id = store.newId();
  store.ensureHome();
  fs.writeFileSync(paths.scriptPath(id), script, { mode: 0o700 });
  store.writeMeta(id, {
    id,
    request,
    interval: meta.interval,
    route: meta.route,
    agent: compiled.agent,
    createdAt: nowIso(),
  });
  trust.bind(id);
  process.stdout.write(`\nKept as ${id} (hash-bound). Running one immediate test...\n`);

  const res = run.runChecker(id);
  reportRun(id, res, { immediate: true });
}

// ---- test ------------------------------------------------------------------

function cmdTest(id) {
  if (!store.exists(id)) return fail(`no checker with id '${id}'`);
  const res = run.runChecker(id);
  reportRun(id, res, { immediate: false });
}

function reportRun(id, res, { immediate }) {
  if (res.refused) {
    return fail(`refusing to run ${id}: ${res.reason}`);
  }
  const runtime = store.readRuntime(id);
  runtime.lastRunAt = Date.now();
  runtime.lastState = daemon.readState(id);
  if (res.timedOut) {
    runtime.lastError = 'timed out';
    store.writeRuntime(id, runtime);
    return process.stdout.write(`  timed out after ${run.HARD_TIMEOUT_MS / 1000}s (no alarm)\n`);
  }
  if (res.error) {
    runtime.lastError = res.error;
    store.writeRuntime(id, runtime);
    return process.stdout.write(`  checker error: ${res.error} (no alarm)\n`);
  }
  runtime.lastError = null;
  if (res.output) {
    runtime.lastOutput = res.output;
    store.writeRuntime(id, runtime);
    process.stdout.write(`  TRANSITION: ${res.output}\n`);
    if (!immediate) {
      process.stdout.write(`  (test does not send a notification; the daemon does)\n`);
    }
  } else {
    store.writeRuntime(id, runtime);
    process.stdout.write(`  silent (no transition). state=${runtime.lastState ?? 'none'}\n`);
  }
}

// ---- list ------------------------------------------------------------------

function cmdList() {
  const ids = store.listIds();
  if (ids.length === 0) {
    process.stdout.write('No checkers. Add one with: watchtell add "<request>"\n');
    return;
  }
  const rows = ids.map((id) => {
    const meta = store.readMeta(id);
    const rt = store.readRuntime(id);
    return {
      id,
      request: truncate(meta.request, 40),
      interval: `${meta.interval}s`,
      route: meta.route,
      state: rt.lastState ? truncate(rt.lastState, 16) : '-',
      fired: rt.lastFiredAt ? new Date(rt.lastFiredAt).toISOString() : '-',
    };
  });
  const cols = [
    ['id', 'id'],
    ['request', 'request'],
    ['interval', 'interval'],
    ['route', 'route'],
    ['state', 'last state'],
    ['fired', 'last fired'],
  ];
  const widths = cols.map(([key, header]) =>
    Math.max(header.length, ...rows.map((r) => String(r[key]).length))
  );
  const line = (cells) =>
    cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').replace(/\s+$/, '') + '\n';
  process.stdout.write(line(cols.map((c) => c[1])));
  for (const r of rows) {
    process.stdout.write(line(cols.map((c) => r[c[0]])));
  }
}

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---- rm --------------------------------------------------------------------

function cmdRm(id) {
  if (!store.exists(id)) return fail(`no checker with id '${id}'`);
  store.remove(id);
  process.stdout.write(`Removed ${id} (checker, trust record, and state).\n`);
}

// ---- daemon ----------------------------------------------------------------

function cmdDaemon(action, options) {
  switch (action) {
    case 'start': {
      if (options.detach) {
        try {
          const pid = daemon.startDetached();
          process.stdout.write(`Daemon started (pid ${pid}). Logs: ${paths.logPath()}\n`);
        } catch (e) {
          return fail(e.message);
        }
        return;
      }
      // Foreground (default and internal --foreground): blocks until signalled.
      try {
        process.stdout.write(`watchtell daemon running (Ctrl-C to stop). Logs: ${paths.logPath()}\n`);
        daemon.runForeground();
      } catch (e) {
        return fail(e.message);
      }
      return;
    }
    case 'stop': {
      const r = daemon.stop();
      if (r.stale) return process.stdout.write(`Cleared stale pid file (pid ${r.pid} was dead).\n`);
      if (r.running === false) return process.stdout.write('Daemon is not running.\n');
      if (!r.stopped) return fail(`daemon did not stop (pid ${r.pid})`);
      return process.stdout.write(`Daemon stopped (pid ${r.pid}).\n`);
    }
    case 'status': {
      const st = daemon.status();
      if (st.running) return process.stdout.write(`running (pid ${st.pid})\n`);
      if (st.stale) return process.stdout.write(`not running (stale pid file: ${st.pid})\n`);
      return process.stdout.write('not running\n');
    }
    case 'install': {
      if (!launchd.isSupportedPlatform()) return fail(launchd.UNSUPPORTED_MESSAGE);
      // launchd must own the single instance: stop any plain detached daemon first,
      // otherwise two daemons would poll at once.
      const st = daemon.status();
      if (st.running) {
        const r = daemon.stop();
        if (!r.stopped) return fail(`daemon did not stop (pid ${r.pid}); LaunchAgent not installed`);
        process.stdout.write(
          `Stopped the running detached daemon (pid ${r.pid}) so launchd owns the single instance.\n`
        );
      } else if (st.stale) {
        daemon.stop(); // clears the stale pid file
      }
      let result;
      try {
        result = launchd.install();
      } catch (e) {
        return fail(e.message);
      }
      if (result.unsupported) return fail(result.message);
      if (!result.ok) {
        const recovery = st.running && !result.loaded
          ? " Run 'watchtell daemon start' to resume without auto-start."
          : '';
        return fail(`${result.message}.${recovery}`);
      }
      process.stdout.write(`Installed LaunchAgent: ${result.plistPath}\n`);
      process.stdout.write(
        `Label ${launchd.LABEL} — auto-starts on login/reboot and restarts on crash.\n`
      );
      process.stdout.write(`Uninstall with: watchtell daemon uninstall\n`);
      return;
    }
    case 'uninstall': {
      if (!launchd.isSupportedPlatform()) return fail(launchd.UNSUPPORTED_MESSAGE);
      let result;
      try {
        result = launchd.uninstall();
      } catch (e) {
        return fail(e.message);
      }
      if (result.unsupported) return fail(result.message);
      if (!result.ok) return fail(result.message);
      if (result.existed) {
        return process.stdout.write(`Uninstalled LaunchAgent: ${result.plistPath}\n`);
      }
      return process.stdout.write('No LaunchAgent installed (nothing to remove).\n');
    }
    default:
      return fail(`unknown daemon action '${action}' (use start|stop|status|install|uninstall)`);
  }
}

// ---- skill -----------------------------------------------------------------

function skillKeys(options) {
  const keys = [];
  if (options.claude) keys.push('claude');
  if (options.codex) keys.push('codex');
  return keys; // empty = all supported agents
}

function skillInstallSummary(results, source) {
  const sourceIsInstalled = results.some(
    (result) => result.status === 'installed' || result.status === 'already-installed'
  );
  const lines = [''];
  if (sourceIsInstalled) {
    lines.push(
      `Symlinked from ${source}. Re-run 'watchtell skill install' after upgrading watchtell.`
    );
  }
  lines.push('Manual fallback:');
  for (const result of results) {
    lines.push(`mkdir -p "${path.dirname(result.linkPath)}"`);
    lines.push(`ln -s "${source}" "${result.linkPath}"`);
  }
  return `${lines.join('\n')}\n`;
}

function cmdSkill(action, options) {
  const homeDir = os.homedir();
  const source = skillInstall.skillSourceDir();
  const keys = skillKeys(options);

  switch (action) {
    case 'install': {
      const results = skillInstall.install({ homeDir, source, keys });
      for (const r of results) {
        switch (r.status) {
          case 'installed':
            process.stdout.write(`  ${r.label}: installed -> ${r.linkPath}\n`);
            break;
          case 'already-installed':
            process.stdout.write(`  ${r.label}: already installed (same link)\n`);
            break;
          case 'skipped':
            process.stdout.write(`  ${r.label}: SKIPPED — ${r.message}\n`);
            break;
        }
      }
      const summary = skillInstallSummary(results, source);
      process.stdout.write(summary);
      return;
    }
    case 'uninstall': {
      const results = skillInstall.uninstall({ homeDir, source, keys, force: options.force });
      for (const r of results) {
        switch (r.status) {
          case 'removed':
            process.stdout.write(`  ${r.label}: removed ${r.linkPath}\n`);
            break;
          case 'absent':
            process.stdout.write(`  ${r.label}: not installed (nothing to remove)\n`);
            break;
          case 'skipped':
            process.stdout.write(`  ${r.label}: SKIPPED — ${r.message}\n`);
            break;
        }
      }
      return;
    }
    case 'status': {
      const results = skillInstall.status({ homeDir, source, keys });
      for (const r of results) {
        switch (r.status) {
          case 'installed':
            process.stdout.write(`  ${r.label}: installed -> ${r.points}\n`);
            break;
          case 'installed-other':
            process.stdout.write(
              `  ${r.label}: installed, but points elsewhere -> ${r.points}\n`
            );
            break;
          case 'real-path':
            process.stdout.write(`  ${r.label}: ${r.message} (${r.linkPath})\n`);
            break;
          case 'not-installed':
            process.stdout.write(`  ${r.label}: not installed\n`);
            break;
        }
      }
      return;
    }
    default:
      return fail(`unknown skill action '${action}' (use install|uninstall|status)`);
  }
}

// ---- wiring ----------------------------------------------------------------

function buildProgram() {
  const program = new Command();
  program
    .name('watchtell')
    .description('Natural-language custom alarm CLI + local daemon for macOS.')
    .version(require('../package.json').version);

  program
    .command('add')
    .argument('<request>', 'natural-language alarm request')
    .option('--yes', 'keep without interactive review (trusts the generator)')
    .option(
      '--interval <duration>',
      'set the poll interval explicitly (e.g. 600, 90s, 5m, 1h); ' +
        'overrides the compiler-inferred value'
    )
    .description(
      'compile a request into a checker, review it, keep + hash-bind it ' +
        '(poll interval is clamped to a 60s minimum; >=5 min recommended)'
    )
    .action(cmdAdd);

  program
    .command('list')
    .description('list checkers: id, request, interval, route, last state, last fired')
    .action(cmdList);

  program
    .command('test')
    .argument('<id>', 'checker id')
    .description('force one run now (ignores schedule) and show the result')
    .action(cmdTest);

  program
    .command('rm')
    .argument('<id>', 'checker id')
    .description('delete a checker and its trust record + state')
    .action(cmdRm);

  program
    .command('daemon')
    .argument('<action>', 'start | stop | status | install | uninstall')
    .option('--detach', 'run the scheduler in the background')
    .option('--foreground', 'run in the foreground (internal; default for start)')
    .description('control the internal-loop scheduler (install/uninstall manage launchd auto-start)')
    .action(cmdDaemon);

  program
    .command('skill')
    .argument('<action>', 'install | uninstall | status')
    .option('--claude', 'limit to Claude Code (~/.claude/skills/watchtell)')
    .option('--codex', 'limit to codex (~/.codex/skills/watchtell)')
    .option('--force', 'uninstall: remove any watchtell symlink, not only ours')
    .description(
      "symlink watchtell's bundled coding-agent skill into user-level skill dirs (default: all agents)"
    )
    .action(cmdSkill);

  return program;
}

async function main(argv) {
  const program = buildProgram();
  await program.parseAsync(argv);
}

module.exports = {
  main,
  buildProgram,
  cmdAdd,
  cmdList,
  cmdTest,
  cmdRm,
  cmdDaemon,
  cmdSkill,
  skillInstallSummary,
};
