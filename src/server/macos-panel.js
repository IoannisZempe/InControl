import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCliEntryPath, getInControlHome, getPackageRoot } from './runtime-paths.js';

/**
 * Returns paths for the user-cached native macOS side panel binary (~/.incontrol/bin/).
 * Storing the compiled binary under INCONTROL_HOME keeps global npm / npx installs writable and persistent.
 */
export function getPanelBinaryPaths({
  homeDir = getInControlHome(),
  rootDir = getPackageRoot(),
} = {}) {
  const binDir = path.join(homeDir, 'bin');
  return {
    binDir,
    binaryPath: path.join(binDir, 'incontrol-panel'),
    hashPath: path.join(binDir, 'incontrol-panel.sha256'),
    cliRecordPath: path.join(binDir, 'cli-path'),
    sourcePath: path.join(rootDir, 'macos', 'InControlPanel.swift'),
    legacyBinaryPath: path.join(rootDir, 'macos', 'incontrol-panel'),
  };
}

/**
 * Computes a SHA-256 hex digest of a file for deterministic cache invalidation across npm upgrades.
 */
export function computeFileSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Records the active CLI path so standalone launches of the panel binary can still auto-start the hub.
 */
export function recordCliPath(cliRecordPath, cliPath) {
  if (!cliRecordPath || !cliPath) return;
  try {
    fs.mkdirSync(path.dirname(cliRecordPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cliRecordPath, `${cliPath}\n`, { mode: 0o600 });
  } catch {
    // Non-fatal: --cli-path and INCONTROL_CLI_PATH also carry the path at runtime.
  }
}

/**
 * Ensures ~/.incontrol/bin/incontrol-panel exists and matches the current InControlPanel.swift source.
 */
export function ensureMacPanelBinary({
  homeDir = getInControlHome(),
  rootDir = getPackageRoot(),
  cliPath = getCliEntryPath(rootDir),
  execFileSyncFn = execFileSync,
  log = console.log,
} = {}) {
  const paths = getPanelBinaryPaths({ homeDir, rootDir });
  fs.mkdirSync(paths.binDir, { recursive: true, mode: 0o700 });
  recordCliPath(paths.cliRecordPath, cliPath);

  if (!fs.existsSync(paths.sourcePath)) {
    if (fs.existsSync(paths.legacyBinaryPath)) {
      fs.copyFileSync(paths.legacyBinaryPath, paths.binaryPath);
      fs.chmodSync(paths.binaryPath, 0o755);
      return { binaryPath: paths.binaryPath, built: true, cached: false, sourceHash: null };
    }
    throw new Error(`macOS panel source not found at ${paths.sourcePath}`);
  }

  const sourceHash = computeFileSha256(paths.sourcePath);
  let cachedHash = '';
  try {
    cachedHash = fs.readFileSync(paths.hashPath, 'utf8').trim();
  } catch {}

  if (fs.existsSync(paths.binaryPath) && cachedHash === sourceHash) {
    return { binaryPath: paths.binaryPath, built: false, cached: true, sourceHash };
  }

  log(`Compiling native macOS panel into ${paths.binaryPath}…`);
  try {
    execFileSyncFn(
      'swiftc',
      [
        '-O',
        paths.sourcePath,
        '-o',
        paths.binaryPath,
        '-framework',
        'Cocoa',
        '-framework',
        'WebKit',
      ],
      { stdio: 'inherit' }
    );
    fs.chmodSync(paths.binaryPath, 0o755);
    fs.writeFileSync(paths.hashPath, `${sourceHash}\n`, { mode: 0o600 });
    return { binaryPath: paths.binaryPath, built: true, cached: false, sourceHash };
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new Error(
        'Cannot compile native macOS panel because `swiftc` is missing. Install Xcode Command Line Tools (`xcode-select --install`), or open the web UI directly at http://localhost:4747.'
      );
    }
    throw err;
  }
}

/**
 * Compiles (if needed) and launches the native macOS side panel pointing at `url`.
 */
export function launchMacPanel(
  url,
  {
    platform = os.platform(),
    homeDir = getInControlHome(),
    rootDir = getPackageRoot(),
    cliPath = getCliEntryPath(rootDir),
    execFileSyncFn = execFileSync,
    spawnFn = spawn,
    log = console.log,
  } = {}
) {
  if (platform !== 'darwin') {
    log(`Native panel is macOS-only. Open ${url} in your browser instead.`);
    return { launched: false, reason: 'non-darwin' };
  }

  const { binaryPath } = ensureMacPanelBinary({
    homeDir,
    rootDir,
    cliPath,
    execFileSyncFn,
    log,
  });

  const spawnArgs = [url, ...(cliPath ? ['--cli-path', cliPath] : [])];
  const child = spawnFn(binaryPath, spawnArgs, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...(cliPath ? { INCONTROL_CLI_PATH: cliPath } : {}),
    },
  });
  child.unref?.();
  log(`✓ Side panel launched → ${url}`);
  return { launched: true, binaryPath, url };
}
