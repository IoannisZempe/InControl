import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  getPackageRoot,
  getPackageVersion,
  isEphemeralNpxPath,
  resolvePersistentInvocation,
} from '../src/server/runtime-paths.js';
import {
  ensureMacPanelBinary,
  getPanelBinaryPaths,
  launchMacPanel,
} from '../src/server/macos-panel.js';
import {
  HUB_SERVICE_LABEL,
  PANEL_SERVICE_LABEL,
  getMacServiceStatus,
  installMacServices,
  renderPlistXml,
  restartMacServices,
  uninstallMacServices,
} from '../src/server/launchd.js';

test('packaging: resolvePersistentInvocation handles repo, global bin, and ephemeral npx paths', () => {
  assert.equal(isEphemeralNpxPath('/Users/u/.npm/_npx/1234/node_modules/incontrol-agents/bin/incontrol.js'), true);
  assert.equal(isEphemeralNpxPath('/opt/homebrew/lib/node_modules/incontrol-agents/bin/incontrol.js'), false);

  const repoInv = resolvePersistentInvocation('/tmp/repo/bin/incontrol.js', {
    nodeExecPath: '/opt/homebrew/bin/node',
  });
  assert.equal(repoInv.mode, 'node-script');
  assert.equal(repoInv.ephemeral, false);
  assert.equal(repoInv.command, '/opt/homebrew/bin/node');
  assert.deepEqual(repoInv.args, ['/tmp/repo/bin/incontrol.js']);

  const npxWithGlobal = resolvePersistentInvocation(
    '/Users/u/.npm/_npx/abcd/node_modules/incontrol-agents/bin/incontrol.js',
    {
      pathEnv: '/opt/homebrew/bin:/usr/bin',
      exists: (p) => p === '/opt/homebrew/bin/incontrol',
    }
  );
  assert.equal(npxWithGlobal.mode, 'global-bin');
  assert.equal(npxWithGlobal.ephemeral, false);
  assert.equal(npxWithGlobal.command, '/opt/homebrew/bin/incontrol');
  assert.deepEqual(npxWithGlobal.args, []);

  const npxOnly = resolvePersistentInvocation(
    '/Users/u/.npm/_npx/abcd/node_modules/incontrol-agents/bin/incontrol.js',
    {
      pathEnv: '/Users/u/.npm/_npx/abcd/node_modules/.bin:/usr/bin',
      exists: () => false,
    }
  );
  assert.equal(npxOnly.mode, 'npx');
  assert.equal(npxOnly.ephemeral, true);
  assert.equal(npxOnly.command, 'npx');
  assert.deepEqual(npxOnly.args, ['-y', 'incontrol-agents']);
});

test('packaging: ensureMacPanelBinary caches compiled binary under INCONTROL_HOME/bin by SHA-256', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-pkg-root-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-pkg-home-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'macos'), { recursive: true });
    const swiftPath = path.join(tmpRoot, 'macos', 'InControlPanel.swift');
    fs.writeFileSync(swiftPath, '// v1\nprint("hi")\n');

    let compileCount = 0;
    const fakeExec = (cmd, args) => {
      assert.equal(cmd, 'swiftc');
      const outIdx = args.indexOf('-o');
      assert.ok(outIdx !== -1);
      compileCount += 1;
      fs.writeFileSync(args[outIdx + 1], `binary-build-${compileCount}`);
    };

    const first = ensureMacPanelBinary({
      homeDir: tmpHome,
      rootDir: tmpRoot,
      cliPath: path.join(tmpRoot, 'bin', 'incontrol.js'),
      execFileSyncFn: fakeExec,
      log: () => {},
    });
    assert.equal(first.built, true);
    assert.equal(first.cached, false);
    assert.equal(compileCount, 1);

    const paths = getPanelBinaryPaths({ homeDir: tmpHome, rootDir: tmpRoot });
    assert.equal(first.binaryPath, paths.binaryPath);
    assert.equal(
      fs.readFileSync(paths.cliRecordPath, 'utf8').trim(),
      path.join(tmpRoot, 'bin', 'incontrol.js')
    );

    // Second invocation must hit SHA-256 cache without invoking swiftc
    const second = ensureMacPanelBinary({
      homeDir: tmpHome,
      rootDir: tmpRoot,
      cliPath: path.join(tmpRoot, 'bin', 'incontrol.js'),
      execFileSyncFn: fakeExec,
      log: () => {},
    });
    assert.equal(second.built, false);
    assert.equal(second.cached, true);
    assert.equal(compileCount, 1);

    // Modifying Swift source invalidates hash and recompiles cleanly
    fs.writeFileSync(swiftPath, '// v2\nprint("updated")\n');
    const third = ensureMacPanelBinary({
      homeDir: tmpHome,
      rootDir: tmpRoot,
      cliPath: path.join(tmpRoot, 'bin', 'incontrol.js'),
      execFileSyncFn: fakeExec,
      log: () => {},
    });
    assert.equal(third.built, true);
    assert.equal(compileCount, 2);

    // Missing swiftc gives an actionable error message
    fs.unlinkSync(paths.binaryPath);
    assert.throws(
      () =>
        ensureMacPanelBinary({
          homeDir: tmpHome,
          rootDir: tmpRoot,
          execFileSyncFn: () => {
            const e = new Error('not found');
            e.code = 'ENOENT';
            throw e;
          },
          log: () => {},
        }),
      /xcode-select --install/
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('packaging: launchMacPanel passes url and --cli-path when cached binary launches', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-launch-root-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-launch-home-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'macos'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'macos', 'InControlPanel.swift'), '// swift');

    const spawned = [];
    const res = launchMacPanel('http://localhost:4747', {
      platform: 'darwin',
      homeDir: tmpHome,
      rootDir: tmpRoot,
      cliPath: '/tmp/custom/bin/incontrol.js',
      execFileSyncFn: (_cmd, args) => {
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'bin');
      },
      spawnFn: (bin, args, opts) => {
        spawned.push({ bin, args, opts });
        return { unref() {} };
      },
      log: () => {},
    });

    assert.equal(res.launched, true);
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args, ['http://localhost:4747', '--cli-path', '/tmp/custom/bin/incontrol.js']);
    assert.equal(spawned[0].opts.env.INCONTROL_CLI_PATH, '/tmp/custom/bin/incontrol.js');

    const linuxRes = launchMacPanel('http://localhost:4747', {
      platform: 'linux',
      log: () => {},
    });
    assert.equal(linuxRes.launched, false);
    assert.equal(linuxRes.reason, 'non-darwin');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('packaging: launchd service install, status, restart, and uninstall work in isolated dirs', () => {
  const xml = renderPlistXml({
    label: 'dev.incontrol.test',
    programArguments: ['/opt/node', '/Users/A & B/incontrol.js', 'start'],
    workingDirectory: '/Users/A & B',
  });
  assert.ok(xml.includes('/Users/A &amp; B/incontrol.js'), 'Plist XML must escape & characters');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-svc-root-'));
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-svc-home-'));
  const tmpAgents = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-svc-agents-'));

  try {
    fs.mkdirSync(path.join(tmpRoot, 'macos'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'macos', 'InControlPanel.swift'), '// swift');
    fs.writeFileSync(path.join(tmpRoot, 'bin', 'incontrol.js'), '#!/usr/bin/env node\n');

    const calls = [];
    const fakeExec = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'swiftc') {
        fs.writeFileSync(args[args.indexOf('-o') + 1], 'panel-bin');
        return '';
      }
      if (cmd === 'launchctl' && args[0] === 'list') {
        return `12345\t0\t${HUB_SERVICE_LABEL}\n-\t0\t${PANEL_SERVICE_LABEL}\n`;
      }
      return '';
    };

    const installed = installMacServices({
      platform: 'darwin',
      port: 4848,
      strict: true,
      homeDir: tmpHome,
      rootDir: tmpRoot,
      launchAgentsDir: tmpAgents,
      uid: 501,
      execFileSyncFn: fakeExec,
      log: () => {},
    });

    assert.equal(installed.ok, true);
    assert.ok(fs.existsSync(installed.hubPlistPath));
    assert.ok(fs.existsSync(installed.panelPlistPath));

    const hubPlist = fs.readFileSync(installed.hubPlistPath, 'utf8');
    assert.match(hubPlist, /<string>start<\/string>/);
    assert.match(hubPlist, /<string>4848<\/string>/);
    assert.match(hubPlist, /<string>--strict<\/string>/);

    const panelPlist = fs.readFileSync(installed.panelPlistPath, 'utf8');
    assert.match(panelPlist, /http:\/\/localhost:4848/);
    assert.match(panelPlist, /<string>--cli-path<\/string>/);

    const status = getMacServiceStatus({
      platform: 'darwin',
      homeDir: tmpHome,
      launchAgentsDir: tmpAgents,
      execFileSyncFn: fakeExec,
    });
    assert.equal(status.panelBinaryExists, true);
    assert.equal(status.services[0].pid, 12345);
    assert.equal(status.services[1].loaded, true);

    const restarted = restartMacServices({
      platform: 'darwin',
      launchAgentsDir: tmpAgents,
      uid: 501,
      execFileSyncFn: fakeExec,
    });
    assert.deepEqual(restarted.restarted, [HUB_SERVICE_LABEL, PANEL_SERVICE_LABEL]);
    assert.ok(calls.some((c) => c[0] === 'launchctl' && c[1] === 'kickstart' && c[3] === `gui/501/${HUB_SERVICE_LABEL}`));

    const removed = uninstallMacServices({
      platform: 'darwin',
      launchAgentsDir: tmpAgents,
      uid: 501,
      execFileSyncFn: fakeExec,
    });
    assert.equal(removed.removed.length, 2);
    assert.equal(fs.existsSync(installed.hubPlistPath), false);
    assert.equal(fs.existsSync(installed.panelPlistPath), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpAgents, { recursive: true, force: true });
  }
});

test('packaging: CLI --version, setup mcp, and package.json SDK exports work cleanly', async () => {
  const root = getPackageRoot();
  const version = getPackageVersion(root);
  const verOut = execFileSync(process.execPath, [path.join(root, 'bin', 'incontrol.js'), '--version'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(verOut, `incontrol-agents v${version}`);

  const mcpOut = execFileSync(
    process.execPath,
    [path.join(root, 'bin', 'incontrol.js'), 'setup', 'mcp', '--ide', 'Cursor'],
    { encoding: 'utf8' }
  );
  const parsed = JSON.parse(mcpOut);
  assert.ok(parsed.mcpServers.incontrol.args.includes('Cursor'));

  const sdkMod = await import('incontrol-agents/sdk');
  assert.equal(typeof sdkMod.InControlAgent, 'function');
});
