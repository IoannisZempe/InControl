#!/usr/bin/env node
import {
  getCliEntryPath,
  getPackageRoot,
  getPackageVersion,
  resolvePersistentInvocation,
} from '../src/server/runtime-paths.js';
import { launchMacPanel } from '../src/server/macos-panel.js';

const ROOT = getPackageRoot();
const BIN_PATH = getCliEntryPath(ROOT);

const [, , command = 'help', ...args] = process.argv;

function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

async function handleSetup(target) {
  const inv = resolvePersistentInvocation(BIN_PATH);

  if (target === 'claude-code' || target === 'claude') {
    if (args.includes('--install')) {
      const { installIntegration } = await import('../src/connectors/auto-watcher.js');
      const res = installIntegration('claude');
      console.log(`✓ ${res.message} (backup saved as settings.json.incontrol-backup if present)`);
      if (inv.ephemeral) {
        console.log('Tip: run `npm install -g incontrol-agents` so hooks execute immediately without npx lookup.');
      }
      return;
    }
    const { getClaudeSettingsSnippet } = await import('../src/connectors/claude-hook.js');
    console.log(JSON.stringify(getClaudeSettingsSnippet(inv.shellCommand), null, 2));
    console.log('\nRun with --install to merge this into ~/.claude/settings.json');
    return;
  }

  if (target === 'antigravity' || target === 'agy') {
    const { installIntegration } = await import('../src/connectors/auto-watcher.js');
    const res = installIntegration('antigravity');
    console.log(`✓ ${res.message}`);
    return;
  }

  if (target === 'codex' || target === 'codex_chatgpt' || target === 'chatgpt') {
    const { installIntegration } = await import('../src/connectors/auto-watcher.js');
    const res = installIntegration('codex_chatgpt');
    console.log(`✓ ${res.message}`);
    return;
  }

  if (target === 'cursor') {
    const { installIntegration } = await import('../src/connectors/auto-watcher.js');
    const res = installIntegration('cursor');
    console.log(`✓ ${res.message}`);
    return;
  }

  if (target === 'mcp') {
    const ide = flag('--ide') || 'Antigravity';
    console.log(
      JSON.stringify(
        {
          mcpServers: {
            incontrol: {
              command: inv.command,
              args: [...inv.args, 'mcp', '--ide', ide],
            },
          },
        },
        null,
        2
      )
    );
    return;
  }

  if (target === 'railway') {
    const { setupRailwayArchive } = await import('../src/server/railway-setup.js');
    const res = await setupRailwayArchive({
      projectName: flag('--project') || 'incontrol-archive',
      environment: flag('--env') || flag('--environment') || 'production',
      serviceName: flag('--service') || 'daily-archive',
      withStaging: args.includes('--with-staging'),
      dryRun: args.includes('--dry-run'),
      allowInstall: !args.includes('--no-install'),
      rotateToken: args.includes('--rotate-token'),
    });
    if (res.dryRun) {
      console.log('InControl Railway Setup — Dry Run Plan:\n');
      res.steps.forEach((s, idx) => console.log(`  ${idx + 1}. ${s}`));
      console.log('\nRe-run without --dry-run to provision Postgres + Daily Archive automatically.');
    } else {
      console.log(`
  ✓ InControl Railway Daily Archive is live!
  Collector URL: ${res.railwayUrl}${res.stagingUrl ? `\n  Staging URL:   ${res.stagingUrl}` : ''}${res.railwayProjectUrl ? `\n  Dashboard:     ${res.railwayProjectUrl}` : ''}
  Local config:  saved to ~/.incontrol/settings.json (token masked on disk as 0600)

  Next: Open InControl and click "Save Day" to archive today's context.
`);
    }
    return;
  }

  console.error(
    'Usage: incontrol setup <antigravity|claude-code|codex|cursor|mcp|railway> [--install] [--ide <Name>] [--with-staging] [--dry-run]'
  );
  process.exit(1);
}

async function handleService(action) {
  const {
    installMacServices,
    uninstallMacServices,
    restartMacServices,
    getMacServiceStatus,
  } = await import('../src/server/launchd.js');

  switch (action) {
    case 'install': {
      const res = installMacServices({
        port: flag('--port') || 4747,
        strict: args.includes('--strict'),
        localOnly: args.includes('--local-only'),
        noNotify: args.includes('--no-notify'),
        includePanel: !args.includes('--no-panel'),
        rootDir: ROOT,
      });
      console.log(`✓ Installed & started LaunchAgent: ${res.hubPlistPath}`);
      if (res.panelPlistPath) {
        console.log(`✓ Installed & started LaunchAgent: ${res.panelPlistPath}`);
        console.log(`  Native panel binary: ${res.panelBinary}`);
      }
      if (res.ephemeralWarning) {
        console.log(`\nNote: ${res.ephemeralWarning}`);
      }
      break;
    }

    case 'restart': {
      const res = restartMacServices();
      if (res.restarted.length === 0) {
        console.log('No InControl LaunchAgents installed yet. Run `incontrol service install` first.');
      } else {
        console.log(`✓ Restarted LaunchAgents: ${res.restarted.join(', ')}`);
      }
      break;
    }

    case 'uninstall': {
      const res = uninstallMacServices();
      if (res.removed.length === 0) {
        console.log('No InControl LaunchAgents found.');
      } else {
        for (const p of res.removed) {
          console.log(`✓ Removed ${p}`);
        }
      }
      break;
    }

    case 'status': {
      const st = getMacServiceStatus();
      if (!st.supported) {
        console.log(`LaunchAgents are macOS-only (current OS: ${st.platform}).`);
        return;
      }
      console.log(`Native panel binary: ${st.panelBinaryPath} (${st.panelBinaryExists ? 'present' : 'not built'})`);
      for (const svc of st.services) {
        const stateLabel = svc.loaded ? (svc.pid ? `running (pid ${svc.pid})` : 'loaded') : 'not loaded';
        console.log(`  ${svc.label}: ${stateLabel}${svc.plistExists ? ` [${svc.plistPath}]` : ' [no plist]'}`);
      }
      break;
    }

    default:
      console.error('Usage: incontrol service <install|status|restart|uninstall> [--port 4747] [--no-panel] [--strict] [--local-only]');
      process.exit(1);
  }
}

async function main() {
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(`incontrol-agents v${getPackageVersion(ROOT)}`);
    return;
  }

  switch (command) {
    case 'start':
    case 'serve': {
      const { createInControlHub } = await import('../src/server/hub.js');
      const hub = await createInControlHub({
        port: flag('--port'),
        macNotifications: !args.includes('--no-notify'),
        localOnly: args.includes('--local-only'),
        strict: args.includes('--strict'),
      });
      const n = hub.network;
      console.log(`
  ╭───────────────────────────────────────────────╮
  │  InControl hub running                        │
  ╰───────────────────────────────────────────────╯
  Local:      ${n.localUrl}
  Phone/LAN:  ${args.includes('--local-only') ? '(disabled: --local-only)' : n.lanUrl || '(no LAN interface found)'}
  Tailscale:  ${n.tailscaleUrl || '(not detected)'}
  Auth:       pairing token required for other devices${args.includes('--strict') ? ' (and localhost: --strict)' : ''}

  Pair a phone: tap 📱 in the panel and scan the QR code, or run \`incontrol token\`
  Open the native macOS side panel:  incontrol panel
`);
      if (args.includes('--panel')) {
        launchMacPanel(n.localUrl, { rootDir: ROOT, cliPath: BIN_PATH });
      }
      const shutdown = async () => {
        await hub.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }

    case 'token': {
      const { loadOrCreateToken } = await import('../src/server/auth.js');
      const { discoverNetworkUrls } = await import('../src/server/hub.js');
      const rotate = args.includes('--rotate');
      const token = loadOrCreateToken({ rotate });
      const n = discoverNetworkUrls(Number(flag('--port') || 4747));
      console.log(`${rotate ? '✓ Token rotated. Restart the hub; paired devices must re-pair.\n\n' : ''}Token:        ${token}
Pairing link: ${n.primaryProjectionUrl}/?token=${token}${n.tailscaleUrl ? `\nTailscale:    ${n.tailscaleUrl}/?token=${token}` : ''}

Remote agents: export INCONTROL_URL=${n.primaryProjectionUrl} INCONTROL_TOKEN=${token}
Keep this secret — anyone with it can answer your agents.`);
      break;
    }

    case 'panel': {
      launchMacPanel(process.env.INCONTROL_URL || `http://localhost:${flag('--port') || 4747}`, {
        rootDir: ROOT,
        cliPath: BIN_PATH,
      });
      break;
    }

    case 'service': {
      await handleService(args[0] || 'status');
      break;
    }

    case 'hook': {
      const target = args[0];
      if (target === 'claude') {
        const { runClaudeHook } = await import('../src/connectors/claude-hook.js');
        await runClaudeHook(args.slice(1));
      } else if (target === 'agy' || target === 'antigravity') {
        const { runAgyHook } = await import('../src/connectors/agy-hook.js');
        await runAgyHook(args.slice(1));
      } else {
        console.error('Usage: incontrol hook <claude|agy> <EventName> [--gate]');
        process.exit(1);
      }
      break;
    }

    case 'mcp': {
      const { runMcpServer } = await import('../src/connectors/mcp-server.js');
      runMcpServer(args);
      break;
    }

    case 'wrap': {
      const { runCliWrapper } = await import('../src/connectors/cli-wrapper.js');
      await runCliWrapper(args);
      break;
    }

    case 'setup': {
      await handleSetup(args[0]);
      break;
    }

    default:
      console.log(`InControl v${getPackageVersion(ROOT)} — mission control side panel for AI agents

Usage:
  incontrol start [--port 4747] [--panel] [--no-notify]            Start the hub + web UI
        [--local-only]   bind to 127.0.0.1 (no phone access)
        [--strict]       require the token even from localhost
  incontrol panel [--port 4747]                                    Open the native macOS side panel
  incontrol service <install|status|restart|uninstall>             Manage macOS background LaunchAgents
  incontrol token [--rotate]                                       Show / rotate the device pairing token
  incontrol setup <antigravity|claude-code|codex|cursor|mcp|railway> [--install]
                                                                   Connect IDEs, agents, or Railway archive
  incontrol mcp [--ide <Name>] [--name <Agent>]                    Run MCP server (stdio)
  incontrol wrap [--name X] [--ide Y] -- <cmd...>                  Wrap a CLI agent (codex, aider…)
  incontrol hook <claude|agy> <Event> [--gate]                     Agent hook handler
  incontrol --version                                              Show package version
`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
