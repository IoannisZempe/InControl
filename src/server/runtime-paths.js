import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = path.resolve(__dirname, '../..');

/**
 * Returns InControl's per-user runtime/state directory (~/.incontrol or INCONTROL_HOME).
 */
export function getInControlHome() {
  return process.env.INCONTROL_HOME || path.join(os.homedir(), '.incontrol');
}

/**
 * Returns the installed package or repository root directory.
 */
export function getPackageRoot() {
  return DEFAULT_PACKAGE_ROOT;
}

/**
 * Returns the path to bin/incontrol.js for a package root.
 */
export function getCliEntryPath(root = DEFAULT_PACKAGE_ROOT) {
  return path.join(root, 'bin', 'incontrol.js');
}

/**
 * Reads version from package.json.
 */
export function getPackageVersion(root = DEFAULT_PACKAGE_ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return pkg.version || '0.1.0';
  } catch {
    return '0.1.0';
  }
}

/**
 * True when running out of an ephemeral `npx` cache directory whose path can disappear later.
 */
export function isEphemeralNpxPath(targetPath = '') {
  const normalized = String(targetPath).replace(/\\/g, '/');
  return normalized.includes('/_npx/');
}

/**
 * Looks for a persistently installed global `incontrol` CLI binary outside ephemeral npx caches.
 */
export function findGlobalIncontrolBin({
  pathEnv = process.env.PATH || '',
  extraCandidates = ['/opt/homebrew/bin/incontrol', '/usr/local/bin/incontrol'],
  exists = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
} = {}) {
  const pathDirs = String(pathEnv)
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, process.platform === 'win32' ? 'incontrol.cmd' : 'incontrol'));

  const seen = new Set();
  for (const candidate of [...pathDirs, ...extraCandidates]) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (isEphemeralNpxPath(candidate)) continue;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolves a durable command invocation suitable for IDE configs, hooks, and background services.
 * Avoids writing ephemeral `_npx/<hash>/...` paths into persistent config files.
 */
export function resolvePersistentInvocation(
  cliPath = getCliEntryPath(),
  { nodeExecPath = process.execPath, pathEnv = process.env.PATH || '', exists } = {}
) {
  if (!isEphemeralNpxPath(cliPath)) {
    return {
      command: nodeExecPath,
      args: [cliPath],
      shellCommand: `${JSON.stringify(nodeExecPath)} ${JSON.stringify(cliPath)}`,
      ephemeral: false,
      mode: 'node-script',
    };
  }

  const globalBin = findGlobalIncontrolBin({ pathEnv, ...(exists ? { exists } : {}) });
  if (globalBin) {
    return {
      command: globalBin,
      args: [],
      shellCommand: JSON.stringify(globalBin),
      ephemeral: false,
      mode: 'global-bin',
    };
  }

  return {
    command: 'npx',
    args: ['-y', 'incontrol-agents'],
    shellCommand: 'npx -y incontrol-agents',
    ephemeral: true,
    mode: 'npx',
  };
}
