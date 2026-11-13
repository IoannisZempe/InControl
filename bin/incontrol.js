#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BIN_PATH = path.join(ROOT, 'bin', 'incontrol.js');

const [, , command = 'help', ...args] = process.argv;

function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

async function main() {
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
      if (args.includes('--panel')) launchPanel(n.localUrl);
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
      launchPanel(process.env.INCONTROL_URL || `http://localhost:${flag('--port') || 4747}`);
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
      if (args[0] === 'claude-code') {
        const { getClaudeSettingsSnippet } = await import('../src/connectors/claude-hook.js');
        const hookCmd = `node ${BIN_PATH}`;
        const snippet = getClaudeSettingsSnippet(hookCmd);
        if (args.includes('--install')) {
          const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
          let settings = {};
          if (fs.existsSync(settingsPath)) {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
            fs.copyFileSync(settingsPath, `${settingsPath}.incontrol-backup`);
          }
          settings.hooks = settings.hooks || {};
          for (const [event, entries] of Object.entries(snippet.hooks)) {
            const existing = (settings.hooks[event] || []).filter(
              (e) => !JSON.stringify(e).includes('incontrol')
            );
            settings.hooks[event] = [...existing, ...entries];
          }
          fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
          console.log(`✓ Installed InControl hooks into ${settingsPath} (backup saved as settings.json.incontrol-backup)`);
        } else {
          console.log(JSON.stringify(snippet, null, 2));
          console.log('\nRun with --install to merge this into ~/.claude/settings.json');
        }
      } else if (args[0] === 'mcp') {
        const ide = flag('--ide') || 'Antigravity';
        console.log(
          JSON.stringify(
            { mcpServers: { incontrol: { command: 'node', args: [BIN_PATH, 'mcp', '--ide', ide] } } },
            null,
            2
          )
        );
      } else if (args[0] === 'railway') {
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
      } else {
        console.error('Usage: incontrol setup <claude-code|mcp|railway> [--install] [--ide <Name>] [--with-staging] [--dry-run]');
        process.exit(1);
      }
      break;
    }

    default:
      console.log(`InControl — mission control side panel for AI agents

Usage:
  incontrol start [--port 4747] [--panel] [--no-notify]            Start the hub + web UI
        [--local-only]   bind to 127.0.0.1 (no phone access)
        [--strict]       require the token even from localhost
  incontrol token [--rotate]                                       Show / rotate the device pairing token
  incontrol panel                                                  Open the native macOS side panel
  incontrol setup claude-code [--install]                          Connect Claude Code via hooks
  incontrol setup mcp [--ide Cursor]                               Print MCP config for IDE agents
  incontrol setup railway [--with-staging] [--dry-run]             Auto-deploy Postgres + Daily Archive to Railway
  incontrol mcp [--ide <Name>] [--name <Agent>]                    Run MCP server (stdio)
  incontrol wrap [--name X] [--ide Y] -- <cmd...>                  Wrap a CLI agent (codex, aider…)
  incontrol hook claude <Event> [--gate-bash]                      Claude Code hook handler
`);
  }
}

function launchPanel(url) {
  if (os.platform() !== 'darwin') {
    console.log(`Native panel is macOS-only. Open ${url} in your browser instead.`);
    return;
  }
  const binary = path.join(ROOT, 'macos', 'incontrol-panel');
  const source = path.join(ROOT, 'macos', 'InControlPanel.swift');
  if (!fs.existsSync(binary) || fs.statSync(source).mtimeMs > fs.statSync(binary).mtimeMs) {
    console.log('Compiling native macOS panel (first run)…');
    execFileSync('swiftc', ['-O', source, '-o', binary, '-framework', 'Cocoa', '-framework', 'WebKit'], {
      stdio: 'inherit',
    });
  }
  const child = spawn(binary, [url], { detached: true, stdio: 'ignore' });
  child.unref();
  console.log(`✓ Side panel launched → ${url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
