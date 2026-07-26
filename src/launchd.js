'use strict';

// launchd auto-start (macOS only). The plist builder and platform guard are pure
// so they can be unit-tested without invoking launchctl. The real launchctl call
// is gated behind the darwin runtime path and is injectable for tests.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const paths = require('./paths');

const LABEL = 'com.watchtell.daemon';
const UNSUPPORTED_MESSAGE =
  'launchd auto-start is macOS-only; on Linux use a systemd user unit (not yet implemented).';

function launchAgentsDir() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

// Fixed production location; launchd only discovers agents under ~/Library/LaunchAgents.
function plistPath() {
  return path.join(launchAgentsDir(), `${LABEL}.plist`);
}

function isSupportedPlatform(platform) {
  return (platform || process.platform) === 'darwin';
}

// Escape a value for use inside an XML <string> element (blocks XML injection).
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Pure: build a well-formed LaunchAgent plist. ProgramArguments hard-codes the
// absolute node binary and script path resolved at install time so launchd does
// not depend on PATH. --foreground is required because launchd owns the
// lifecycle; a detaching start would make launchd think the process exited.
function buildPlist({ nodePath, scriptPath, logPath, watchtellHome, environmentPath } = {}) {
  const args = [nodePath, scriptPath, 'daemon', 'start', '--foreground'];
  const argLines = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');

  let workingDirectoryBlock = '';
  if (watchtellHome) {
    workingDirectoryBlock =
      `  <key>WorkingDirectory</key>\n` +
      `  <string>${xmlEscape(watchtellHome)}</string>\n`;
  }
  const watchtellHomeEntry = watchtellHome
    ? `    <key>WATCHTELL_HOME</key>\n` +
      `    <string>${xmlEscape(watchtellHome)}</string>\n`
    : '';
  const environmentBlock =
    `  <key>EnvironmentVariables</key>\n` +
    `  <dict>\n` +
    `    <key>PATH</key>\n` +
    `    <string>${xmlEscape(environmentPath)}</string>\n` +
    `${watchtellHomeEntry}` +
    `  </dict>\n`;

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">\n` +
    `<dict>\n` +
    `  <key>Label</key>\n` +
    `  <string>${xmlEscape(LABEL)}</string>\n` +
    `  <key>ProgramArguments</key>\n` +
    `  <array>\n` +
    `${argLines}\n` +
    `  </array>\n` +
    `  <key>RunAtLoad</key>\n` +
    `  <true/>\n` +
    `  <key>KeepAlive</key>\n` +
    `  <true/>\n` +
    `  <key>StandardOutPath</key>\n` +
    `  <string>${xmlEscape(logPath)}</string>\n` +
    `  <key>StandardErrorPath</key>\n` +
    `  <string>${xmlEscape(logPath)}</string>\n` +
    `${workingDirectoryBlock}` +
    `${environmentBlock}` +
    `</dict>\n` +
    `</plist>\n`
  );
}

// Resolve the install-time spec: absolute node + script paths, the log path, and
// the WATCHTELL_HOME override if one is in effect.
function resolveInstallSpec() {
  const watchtellHome = process.env.WATCHTELL_HOME
    ? path.resolve(process.env.WATCHTELL_HOME)
    : null;
  const homePath = watchtellHome || paths.home();
  return {
    nodePath: process.execPath,
    scriptPath: path.resolve(__dirname, '..', 'bin', 'watchtell.js'),
    logPath: path.join(homePath, 'daemon.log'),
    homePath,
    watchtellHome,
    environmentPath: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
  };
}

function domainTarget() {
  return `gui/${process.getuid()}`;
}

function serviceTarget() {
  return `${domainTarget()}/${LABEL}`;
}

function realLaunchctl(args) {
  const r = spawnSync('launchctl', args, { encoding: 'utf8' });
  return {
    status: r.status == null ? 1 : r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

function launchctlFailure(action, result) {
  const detail = result.stderr || result.stdout || `exit status ${result.status}`;
  return `launchctl ${action} failed: ${detail}`;
}

function unloadService(launchctlFn) {
  const result = launchctlFn(['bootout', serviceTarget()]);
  if (result.status === 0) return { unloaded: true, result };
  const state = launchctlFn(['print', serviceTarget()]);
  return { unloaded: state.status !== 0, result, state };
}

// Write the plist and load it via launchctl. The opts seams exist only so tests
// can isolate the platform and filesystem and avoid touching launchctl.
function install(opts = {}) {
  const platform = opts.platform || process.platform;
  if (!isSupportedPlatform(platform)) {
    return { ok: false, unsupported: true, message: UNSUPPORTED_MESSAGE };
  }
  const file = opts.plistPath || plistPath();
  const launchctlFn = opts.launchctlFn || realLaunchctl;
  const spec = resolveInstallSpec();
  const xml = buildPlist(spec);

  fs.mkdirSync(spec.homePath, { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, xml, { mode: 0o644 });

  const initialBootout = launchctlFn(['bootout', domainTarget(), file]);
  const res = launchctlFn(['bootstrap', domainTarget(), file]);
  const loaded = res.status === 0;
  if (!loaded) {
    const rollback = unloadService(launchctlFn);
    if (rollback.unloaded) fs.rmSync(file, { force: true });
    return {
      ok: false,
      unsupported: false,
      plistPath: file,
      spec,
      initialBootout,
      launchctl: res,
      loaded: !rollback.unloaded,
      rolledBack: rollback.unloaded,
      rollback,
      message: rollback.unloaded
        ? `${launchctlFailure('bootstrap', res)}; LaunchAgent was not installed`
        : `${launchctlFailure('bootstrap', res)}; service is still loaded and the plist was retained. Run 'watchtell daemon uninstall' or 'launchctl bootout ${serviceTarget()}' to remove it`,
    };
  }
  return {
    ok: true,
    unsupported: false,
    plistPath: file,
    spec,
    initialBootout,
    launchctl: res,
    loaded: true,
    rolledBack: false,
    message: null,
  };
}

// Unload (if loaded) and remove the plist. Idempotent: succeeds if already absent.
function uninstall(opts = {}) {
  const platform = opts.platform || process.platform;
  if (!isSupportedPlatform(platform)) {
    return { ok: false, unsupported: true, message: UNSUPPORTED_MESSAGE };
  }
  const file = opts.plistPath || plistPath();
  const launchctlFn = opts.launchctlFn || realLaunchctl;
  const existed = fs.existsSync(file);
  const unload = unloadService(launchctlFn);
  if (!unload.unloaded) {
    return {
      ok: false,
      unsupported: false,
      plistPath: file,
      existed,
      launchctl: unload.result,
      loaded: true,
      message: launchctlFailure('bootout', unload.result),
    };
  }
  fs.rmSync(file, { force: true });
  return {
    ok: true,
    unsupported: false,
    plistPath: file,
    existed,
    launchctl: unload.result,
    loaded: false,
  };
}

module.exports = {
  LABEL,
  UNSUPPORTED_MESSAGE,
  launchAgentsDir,
  plistPath,
  isSupportedPlatform,
  xmlEscape,
  buildPlist,
  resolveInstallSpec,
  install,
  uninstall,
};
