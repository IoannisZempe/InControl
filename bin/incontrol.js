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
        demo: args.includes('--demo'),
        macNotifications: !args.includes('--no-notify'),
      });
      const n = hub.network;
      console.log(`
  ╭───────────────────────────────────────────────╮
  │  InControl hub running                        │
  ╰───────────────────────────────────────────────╯
  Local:      ${n.localUrl}
  Phone/LAN:  ${n.lanUrl || '(no LAN interface found)'}
  Tailscale:  ${n.tailscaleUrl || '(not detected)'}
  Demo:       ${hub.simulator.active ? 'on' : 'off'}

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

    case 'panel': {
      launchPanel(process.env.INCONTROL_URL || `http://localhost:${flag('--port') || 4747}`);
      break;
    }

    case 'hook': {
      const target = args[0];
      if (target !== 'claude') {
        console.error('Usage: incontrol hook claude <EventName> [--gate-bash]');
        process.exit(1);
      }
      const { runClaudeHook } = await import('../src/connectors/claude-hook.js');
      await runClaudeHook(args.slice(1));
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
      } else {
        console.error('Usage: incontrol setup <claude-code|mcp> [--install] [--ide <Name>]');
        process.exit(1);
      }
      break;
    }

    default:
      console.log(`InControl — mission control side panel for AI agents

Usage:
  incontrol start [--port 4747] [--demo] [--panel] [--no-notify]   Start the hub + web UI
  incontrol panel                                                  Open the native macOS side panel
  incontrol setup claude-code [--install]                          Connect Claude Code via hooks
  incontrol setup mcp [--ide Cursor]                               Print MCP config for IDE agents
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
