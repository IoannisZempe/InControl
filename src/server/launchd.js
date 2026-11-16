import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureMacPanelBinary } from './macos-panel.js';
import {
  getCliEntryPath,
  getInControlHome,
  getPackageRoot,
  resolvePersistentInvocation,
} from './runtime-paths.js';

export const HUB_SERVICE_LABEL = 'dev.incontrol.hub';
export const PANEL_SERVICE_LABEL = 'dev.incontrol.panel';

export function getLaunchAgentsDir() {
  return process.env.INCONTROL_LAUNCH_AGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents');
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds an Apple launchd property list XML string.
 */
export function renderPlistXml({
  label,
  programArguments,
  workingDirectory,
  environmentVariables,
  stdoutPath,
  stderrPath,
}) {
  const argsXml = (programArguments || [])
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n');

  const envEntries = Object.entries(environmentVariables || {});
  const envXml = envEntries.length
    ? `  <key>EnvironmentVariables</key>\n  <dict>\n${envEntries
        .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
        .join('\n')}\n  </dict>\n`
    : '';

  const logXml =
    (stdoutPath ? `  <key>StandardOutPath</key>\n  <string>${xmlEscape(stdoutPath)}</string>\n` : '') +
    (stderrPath ? `  <key>StandardErrorPath</key>\n  <string>${xmlEscape(stderrPath)}</string>\n` : '');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
${workingDirectory ? `  <key>WorkingDirectory</key>\n  <string>${xmlEscape(workingDirectory)}</string>\n` : ''}${envXml}  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${logXml}</dict>
</plist>
`;
}

function buildServicePathEnv(extraBinDir) {
  const dirs = [
    extraBinDir,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
  ].filter(Boolean);
  return Array.from(new Set(dirs)).join(':');
}

function tryExecLaunchctl(execFileSyncFn, args) {
  try {
    const out = execFileSyncFn('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout: out || '' };
  } catch (err) {
    return { ok: false, error: err?.stderr?.toString() || err?.message || 'launchctl error' };
  }
}

function loadOrReloadPlist(execFileSyncFn, domainTarget, label, plistPath) {
  tryExecLaunchctl(execFileSyncFn, ['bootout', `${domainTarget}/${label}`]);
  const res = tryExecLaunchctl(execFileSyncFn, ['bootstrap', domainTarget, plistPath]);
  if (!res.ok) {
    // Fallback for older macOS environments where bootout/bootstrap returns EIO when called off-session
    tryExecLaunchctl(execFileSyncFn, ['unload', plistPath]);
    const legacy = tryExecLaunchctl(execFileSyncFn, ['load', '-w', plistPath]);
    if (!legacy.ok) {
      throw new Error(`Failed to load ${label}: ${res.error}`);
    }
  }
}

/**
 * Installs and loads macOS LaunchAgents for the InControl Hub and native Side Panel.
 */
export function installMacServices({
  platform = os.platform(),
  port = 4747,
  strict = false,
  localOnly = false,
  noNotify = false,
  includePanel = true,
  homeDir = getInControlHome(),
  rootDir = getPackageRoot(),
  launchAgentsDir = getLaunchAgentsDir(),
  uid = typeof process.getuid === 'function' ? process.getuid() : 501,
  execFileSyncFn = execFileSync,
  log = console.log,
} = {}) {
  if (platform !== 'darwin') {
    throw new Error('macOS LaunchAgent service installation is only supported on darwin.');
  }

  const safePort = Number(port) || 4747;
  const hubUrl = `http://localhost:${safePort}`;
  const cliPath = getCliEntryPath(rootDir);
  const invocation = resolvePersistentInvocation(cliPath);
  const domainTarget = `gui/${uid}`;

  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(launchAgentsDir, { recursive: true });

  const startArgs = [invocation.command, ...invocation.args, 'start', '--port', String(safePort)];
  if (strict) startArgs.push('--strict');
  if (localOnly) startArgs.push('--local-only');
  if (noNotify) startArgs.push('--no-notify');

  const envVars = {
    PATH: buildServicePathEnv(path.dirname(invocation.command)),
    ...(process.env.INCONTROL_HOME ? { INCONTROL_HOME: homeDir } : {}),
  };

  const hubPlistPath = path.join(launchAgentsDir, `${HUB_SERVICE_LABEL}.plist`);
  const hubPlist = renderPlistXml({
    label: HUB_SERVICE_LABEL,
    programArguments: startArgs,
    workingDirectory: invocation.ephemeral ? homeDir : rootDir,
    environmentVariables: envVars,
    stdoutPath: path.join(homeDir, 'hub.log'),
    stderrPath: path.join(homeDir, 'hub.err.log'),
  });
  fs.writeFileSync(hubPlistPath, hubPlist, 'utf8');
  loadOrReloadPlist(execFileSyncFn, domainTarget, HUB_SERVICE_LABEL, hubPlistPath);

  let panelPlistPath = null;
  let panelBinary = null;
  if (includePanel) {
    const built = ensureMacPanelBinary({
      homeDir,
      rootDir,
      cliPath,
      execFileSyncFn,
      log,
    });
    panelBinary = built.binaryPath;
    panelPlistPath = path.join(launchAgentsDir, `${PANEL_SERVICE_LABEL}.plist`);
    const panelArgs = [panelBinary, hubUrl, ...(invocation.ephemeral ? [] : ['--cli-path', cliPath])];
    const panelPlist = renderPlistXml({
      label: PANEL_SERVICE_LABEL,
      programArguments: panelArgs,
      workingDirectory: homeDir,
      environmentVariables: {
        ...envVars,
        ...(invocation.ephemeral ? {} : { INCONTROL_CLI_PATH: cliPath }),
      },
      stdoutPath: path.join(homeDir, 'panel.log'),
      stderrPath: path.join(homeDir, 'panel.err.log'),
    });
    fs.writeFileSync(panelPlistPath, panelPlist, 'utf8');
    loadOrReloadPlist(execFileSyncFn, domainTarget, PANEL_SERVICE_LABEL, panelPlistPath);
  }

  return {
    ok: true,
    ephemeralWarning: invocation.ephemeral
      ? 'Running from an ephemeral npx cache; install globally with `npm install -g incontrol-agents` for faster offline LaunchAgent startup.'
      : null,
    hubUrl,
    hubPlistPath,
    panelPlistPath,
    panelBinary,
    invocationMode: invocation.mode,
  };
}

/**
 * Restarts installed LaunchAgents via `launchctl kickstart -k`.
 */
export function restartMacServices({
  platform = os.platform(),
  launchAgentsDir = getLaunchAgentsDir(),
  uid = typeof process.getuid === 'function' ? process.getuid() : 501,
  execFileSyncFn = execFileSync,
} = {}) {
  if (platform !== 'darwin') {
    throw new Error('macOS LaunchAgent management is only supported on darwin.');
  }
  const domainTarget = `gui/${uid}`;
  const restarted = [];

  for (const label of [HUB_SERVICE_LABEL, PANEL_SERVICE_LABEL]) {
    const plistPath = path.join(launchAgentsDir, `${label}.plist`);
    if (!fs.existsSync(plistPath)) continue;
    const kick = tryExecLaunchctl(execFileSyncFn, ['kickstart', '-k', `${domainTarget}/${label}`]);
    if (!kick.ok) {
      loadOrReloadPlist(execFileSyncFn, domainTarget, label, plistPath);
    }
    restarted.push(label);
  }

  return { ok: true, restarted };
}

/**
 * Unloads and removes InControl LaunchAgent property lists.
 */
export function uninstallMacServices({
  platform = os.platform(),
  launchAgentsDir = getLaunchAgentsDir(),
  uid = typeof process.getuid === 'function' ? process.getuid() : 501,
  execFileSyncFn = execFileSync,
} = {}) {
  if (platform !== 'darwin') {
    throw new Error('macOS LaunchAgent management is only supported on darwin.');
  }
  const domainTarget = `gui/${uid}`;
  const removed = [];

  for (const label of [PANEL_SERVICE_LABEL, HUB_SERVICE_LABEL]) {
    const plistPath = path.join(launchAgentsDir, `${label}.plist`);
    tryExecLaunchctl(execFileSyncFn, ['bootout', `${domainTarget}/${label}`]);
    if (fs.existsSync(plistPath)) {
      tryExecLaunchctl(execFileSyncFn, ['unload', plistPath]);
      fs.unlinkSync(plistPath);
      removed.push(plistPath);
    }
  }

  return { ok: true, removed };
}

/**
 * Inspects installed LaunchAgent plists, live launchctl state, and panel binary cache.
 */
export function getMacServiceStatus({
  platform = os.platform(),
  homeDir = getInControlHome(),
  launchAgentsDir = getLaunchAgentsDir(),
  execFileSyncFn = execFileSync,
} = {}) {
  if (platform !== 'darwin') {
    return { supported: false, platform, services: [] };
  }

  const listRes = tryExecLaunchctl(execFileSyncFn, ['list']);
  const listLines = (listRes.stdout || '').split('\n');

  const services = [HUB_SERVICE_LABEL, PANEL_SERVICE_LABEL].map((label) => {
    const plistPath = path.join(launchAgentsDir, `${label}.plist`);
    const line = listLines.find((l) => l.endsWith(`\t${label}`) || l.includes(` ${label}`));
    const pidRaw = line ? line.trim().split(/\s+/)[0] : null;
    const pid = pidRaw && pidRaw !== '-' && /^\d+$/.test(pidRaw) ? Number(pidRaw) : null;
    return {
      label,
      plistExists: fs.existsSync(plistPath),
      plistPath,
      loaded: Boolean(line),
      pid,
    };
  });

  const panelBinaryPath = path.join(homeDir, 'bin', 'incontrol-panel');
  return {
    supported: true,
    platform,
    panelBinaryExists: fs.existsSync(panelBinaryPath),
    panelBinaryPath,
    services,
  };
}
