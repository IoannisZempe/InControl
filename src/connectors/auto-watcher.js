import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClaudeSettingsSnippet } from './claude-hook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '../../bin/incontrol.js');

const HOME = os.homedir();
const AGY_BRAIN_DIR = path.join(HOME, '.gemini', 'antigravity', 'brain');
const AGY_MCP_CONFIG = path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json');
const CODEX_DIR = path.join(HOME, '.codex');
const CODEX_INDEX = path.join(CODEX_DIR, 'session_index.jsonl');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const CODEX_CONFIG_TOML = path.join(CODEX_DIR, 'config.toml');
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const CURSOR_MCP_CONFIG = path.join(HOME, '.cursor', 'mcp.json');

/**
 * Starts automatic background watching of local Antigravity, Codex, and ChatGPT Desktop sessions
 * so they appear in InControl with zero manual wrapping required.
 */
export function startAutoWatcher(store, intervalMs = 3000) {
  const seenMtimes = new Map();

  function scanAll() {
    try {
      scanAntigravitySessions(store, seenMtimes);
    } catch {}
    try {
      scanCodexAndChatGptSessions(store, seenMtimes);
    } catch {}
  }

  scanAll();
  const timer = setInterval(scanAll, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Watches ~/.gemini/antigravity/brain/<conv-id>/.system_generated/logs/transcript.jsonl
 */
function scanAntigravitySessions(store, seenMtimes) {
  if (!fs.existsSync(AGY_BRAIN_DIR)) return;

  const entries = fs.readdirSync(AGY_BRAIN_DIR, { withFileTypes: true });
  const candidates = [];

  for (const d of entries) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const transcriptPath = path.join(
      AGY_BRAIN_DIR,
      d.name,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
    if (!fs.existsSync(transcriptPath)) continue;
    const stat = fs.statSync(transcriptPath);
    // Include conversations active within the last 12 hours
    if (Date.now() - stat.mtimeMs < 12 * 3600_000) {
      candidates.push({ convId: d.name, transcriptPath, mtimeMs: stat.mtimeMs });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const item of candidates.slice(0, 3)) {
    const key = `agy:${item.convId}`;
    if (seenMtimes.get(key) === item.mtimeMs) continue;
    seenMtimes.set(key, item.mtimeMs);

    const lines = readTailLines(item.transcriptPath, 35);
    if (lines.length === 0) continue;

    let workspace = null;
    let lastUserText = '';
    let lastStep = null;

    for (const raw of lines) {
      try {
        const obj = JSON.parse(raw);
        if (obj.type === 'USER_INPUT' && obj.content) {
          const m = obj.content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
          const clean = (m ? m[1] : obj.content).trim().replace(/\s+/g, ' ');
          if (clean && !clean.startsWith('Error:')) {
            lastUserText = clean.slice(0, 110);
          }
        }
        if (Array.isArray(obj.tool_calls)) {
          for (const tc of obj.tool_calls) {
            const p = tc.arguments?.Path || tc.arguments?.TargetFile;
            if (typeof p === 'string' && p.startsWith('/Users/') && !p.includes('/.gemini/')) {
              const parts = p.split('/');
              if (parts.length >= 5) {
                workspace = '/' + parts.slice(1, 5).join('/');
              }
            }
          }
        }
        if (obj.type === 'PLANNER_RESPONSE' || obj.type === 'USER_INPUT') {
          lastStep = obj;
        }
      } catch {}
    }

    const agentId = `agy-${item.convId.slice(0, 8)}`;
    const wsPath = workspace || '/Users/ioannisz/Repo/InControl';
    const projectName = path.basename(wsPath) || 'Antigravity';
    const ageMs = Date.now() - item.mtimeMs;

    // Determine status from the latest transcript step
    let status = 'idle';
    let currentStep = 'Standing by';
    let pendingPrompt = null;
    let attentionReason = null;

    if (lastStep) {
      const toolCalls = Array.isArray(lastStep.tool_calls) ? lastStep.tool_calls : [];
      const askCall = toolCalls.find((t) => t.name?.includes('ask_question'));

      if (askCall && ageMs < 30 * 60_000) {
        status = 'needs_input';
        const firstQ = askCall.arguments?.questions?.[0];
        const questionText = firstQ?.question || 'Antigravity is waiting for your answer';
        const opts = Array.isArray(firstQ?.options)
          ? firstQ.options.slice(0, 3).map((o, i) => ({
              id: `opt_${i}`,
              label: String(o).replace(/^\(Recommended\)\s*/i, '').slice(0, 28),
              style: i === 0 ? 'primary' : 'secondary',
            }))
          : [{ id: 'acknowledge', label: 'Got it', style: 'primary' }];
        currentStep = 'Waiting on your answer in Antigravity';
        pendingPrompt = {
          requestId: `agy_q_${lastStep.step_index || 0}`,
          question: questionText,
          options: opts,
          allowFreeText: false,
          createdAt: item.mtimeMs,
        };
      } else if (toolCalls.length > 0 && ageMs < 5 * 60_000) {
        status = 'working';
        const tc = toolCalls[toolCalls.length - 1];
        const cleanName = (tc.name || 'tool').replace(/^default_api:/, '');
        const summary =
          tc.arguments?.toolSummary ||
          (tc.arguments?.Path ? path.basename(tc.arguments.Path) : '') ||
          cleanName;
        currentStep = `${cleanName}: ${summary}`;
      } else if (lastStep.type === 'USER_INPUT' && ageMs < 5 * 60_000) {
        status = 'working';
        currentStep = 'Thinking…';
      } else if (lastStep.type === 'PLANNER_RESPONSE' && toolCalls.length === 0) {
        if (ageMs < 20 * 60_000) {
          status = 'needs_attention';
          currentStep = 'Response complete';
          attentionReason = (lastStep.content || 'Finished response — ready for review')
            .replace(/[#*`]/g, '')
            .trim()
            .slice(0, 110);
        } else {
          status = 'idle';
          currentStep = 'Idle';
        }
      }
    }

    // Remove older manual duplicate if present
    if (store.agents.has('antigravity-incontrol') && agentId !== 'antigravity-incontrol') {
      store.removeAgent('antigravity-incontrol');
    }
    if (store.agents.has('live-antigravity-incontrol')) {
      store.removeAgent('live-antigravity-incontrol');
    }

    store.upsertAgent({
      id: agentId,
      name: 'Antigravity',
      provider: 'antigravity',
      ide: 'Antigravity',
      workspace: wsPath,
      projectName,
      branch: 'main',
      status,
      currentTask: lastUserText || 'Active Antigravity session',
      currentStep,
      attentionReason,
      pendingPrompt,
    });
  }
}

/**
 * Watches ~/.codex/session_index.jsonl and ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 * Automatically tracks both OpenAI Codex CLI and the ChatGPT Desktop App (Codex Desktop).
 */
function scanCodexAndChatGptSessions(store, seenMtimes) {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return;

  // Map thread_id -> thread_name from session_index.jsonl
  const threadNames = new Map();
  if (fs.existsSync(CODEX_INDEX)) {
    const idxLines = readTailLines(CODEX_INDEX, 40);
    for (const line of idxLines) {
      try {
        const row = JSON.parse(line);
        if (row.id && row.thread_name) {
          threadNames.set(row.id, row.thread_name);
        }
      } catch {}
    }
  }

  const recentFiles = findRecentJsonlFiles(CODEX_SESSIONS_DIR, 10);
  const seenWorkspaces = new Set();

  for (const file of recentFiles) {
    const headLine = readFirstLine(file.path);
    if (!headLine) continue;

    let meta = {};
    try {
      const parsed = JSON.parse(headLine);
      if (parsed.type === 'session_meta') meta = parsed.payload || {};
    } catch {}

    const cwd = meta.cwd || HOME;
    if (seenWorkspaces.has(cwd)) continue;
    seenWorkspaces.add(cwd);
    if (seenWorkspaces.size > 3) break;

    const threadId = meta.parent_thread_id || meta.session_id || meta.id || path.basename(file.path, '.jsonl');
    const key = `codex:${cwd}`;
    if (seenMtimes.get(key) === file.mtimeMs) continue;
    seenMtimes.set(key, file.mtimeMs);

    const tailLines = readTailLines(file.path, 25);
    const sessionId = threadId;
    const threadTitle =
      threadNames.get(sessionId) ||
      threadNames.get(meta.parent_thread_id) ||
      'Codex / ChatGPT task';
    const projectName = path.basename(cwd) || 'workspace';
    const branch = meta.git?.branch || 'main';
    const originator = String(meta.originator || 'Codex');
    const isDesktopApp =
      originator.toLowerCase().includes('desktop') ||
      originator.toLowerCase().includes('chatgpt');

    const agentName = isDesktopApp ? 'ChatGPT / Codex' : 'Codex CLI';
    const ideName = isDesktopApp ? 'ChatGPT App' : 'Terminal';

    let status = 'idle';
    let currentStep = 'Standing by';
    let attentionReason = null;
    let pendingPrompt = null;
    const ageMs = Date.now() - file.mtimeMs;

    for (const raw of tailLines) {
      try {
        const ev = JSON.parse(raw);
        const p = ev.payload || {};
        if (ev.type === 'event_msg') {
          if (
            p.type === 'exec_approval_request' ||
            p.type === 'apply_patch_approval_request' ||
            p.type === 'request_user_input'
          ) {
            status = 'needs_input';
            const cmd = Array.isArray(p.command) ? p.command.join(' ') : p.command || '';
            currentStep = 'Waiting for approval in ' + ideName;
            pendingPrompt = {
              requestId: `codex_${ev.ordinal || Date.now()}`,
              question: p.reason || `Approve command in ${projectName}?`,
              command: cmd || null,
              options: [{ id: 'acknowledge', label: 'Focus & Approve', style: 'primary' }],
              allowFreeText: false,
              createdAt: file.mtimeMs,
            };
          } else if (p.type === 'task_complete') {
            status = ageMs < 30 * 60_000 ? 'needs_attention' : 'idle';
            currentStep = status === 'needs_attention' ? 'Turn completed' : 'Idle';
            attentionReason = p.last_agent_message
              ? String(p.last_agent_message).slice(0, 110)
              : 'Task completed in ' + agentName;
            pendingPrompt = null;
          } else if (p.type === 'task_started' || p.type === 'exec_command_begin') {
            if (ageMs < 10 * 60_000) {
              status = 'working';
              currentStep = p.command
                ? `Running: ${Array.isArray(p.command) ? p.command.join(' ') : p.command}`
                : 'Executing task…';
              pendingPrompt = null;
            }
          }
        }
      } catch {}
    }

    store.upsertAgent({
      id: `codex-${sessionId.slice(0, 10)}`,
      name: agentName,
      provider: 'codex',
      ide: ideName,
      workspace: cwd,
      projectName,
      branch,
      status,
      currentTask: threadTitle,
      currentStep,
      attentionReason,
      pendingPrompt,
    });
  }
}

/**
 * Returns the live installation status of each supported agent integration on this Mac.
 */
export function getIntegrationsStatus() {
  const agyDetected = fs.existsSync(AGY_BRAIN_DIR);
  const agyMcpInstalled = fileContains(AGY_MCP_CONFIG, 'incontrol');

  const codexDetected = fs.existsSync(CODEX_DIR);
  const codexMcpInstalled = fileContains(CODEX_CONFIG_TOML, 'mcp_servers.incontrol');

  const claudeDetected = fs.existsSync( path.dirname(CLAUDE_SETTINGS));
  const claudeHooksInstalled = fileContains(CLAUDE_SETTINGS, 'incontrol');

  const cursorDetected = fs.existsSync('/Applications/Cursor.app') || fs.existsSync(path.dirname(CURSOR_MCP_CONFIG));
  const cursorMcpInstalled = fileContains(CURSOR_MCP_CONFIG, 'incontrol');

  return [
    {
      id: 'antigravity',
      name: 'Antigravity',
      subtitle: 'Auto-watches live transcripts + MCP tools for two-way prompts',
      detected: agyDetected,
      autoWatched: agyDetected,
      configured: agyMcpInstalled,
      actionLabel: agyMcpInstalled ? 'Reinstall MCP' : 'Enable Two-Way MCP',
      statusText: agyMcpInstalled
        ? 'Live Watcher + MCP Active'
        : agyDetected
        ? 'Live Watcher Active'
        : 'Not detected',
    },
    {
      id: 'codex_chatgpt',
      name: 'Codex + ChatGPT App',
      subtitle: 'Auto-watches ~/.codex sessions (ChatGPT.app & Codex CLI) + MCP server',
      detected: codexDetected,
      autoWatched: codexDetected,
      configured: codexMcpInstalled,
      actionLabel: codexMcpInstalled ? 'Reinstall MCP' : 'Enable Two-Way MCP',
      statusText: codexMcpInstalled
        ? 'Live Watcher + MCP Active'
        : codexDetected
        ? 'Live Watcher Active'
        : 'Not detected',
    },
    {
      id: 'claude',
      name: 'Claude Code',
      subtitle: 'Lifecycle hooks in ~/.claude/settings.json (PreToolUse, Notification, Stop)',
      detected: claudeDetected,
      autoWatched: false,
      configured: claudeHooksInstalled,
      actionLabel: claudeHooksInstalled ? 'Reinstall Hooks' : 'Install Hooks',
      statusText: claudeHooksInstalled ? 'Hooks Active' : 'Click to Connect',
    },
    {
      id: 'cursor',
      name: 'Cursor',
      subtitle: 'MCP server in ~/.cursor/mcp.json for status & human approval prompts',
      detected: cursorDetected,
      autoWatched: false,
      configured: cursorMcpInstalled,
      actionLabel: cursorMcpInstalled ? 'Reinstall MCP' : 'Connect Cursor',
      statusText: cursorMcpInstalled ? 'MCP Active' : 'Click to Connect',
    },
  ];
}

/**
 * One-click installer for any integration directly from the UI.
 */
export function installIntegration(targetId) {
  if (targetId === 'antigravity') {
    upsertJsonMcpConfig(AGY_MCP_CONFIG, 'Antigravity');
    return { ok: true, message: 'Installed InControl MCP into ~/.gemini/antigravity/mcp_config.json' };
  }

  if (targetId === 'codex_chatgpt') {
    fs.mkdirSync(CODEX_DIR, { recursive: true });
    let toml = fs.existsSync(CODEX_CONFIG_TOML) ? fs.readFileSync(CODEX_CONFIG_TOML, 'utf8') : '';
    if (!toml.includes('[mcp_servers.incontrol]')) {
      const block = `\n[mcp_servers.incontrol]\ncommand = "node"\nargs = ["${BIN_PATH}", "mcp", "--ide", "ChatGPT App", "--provider", "codex"]\n`;
      toml = toml.trimEnd() + '\n' + block;
      fs.writeFileSync(CODEX_CONFIG_TOML, toml, 'utf8');
    }
    return { ok: true, message: 'Added [mcp_servers.incontrol] to ~/.codex/config.toml' };
  }

  if (targetId === 'claude') {
    const snippet = getClaudeSettingsSnippet(`node ${BIN_PATH}`);
    let settings = {};
    if (fs.existsSync(CLAUDE_SETTINGS)) {
      try {
        settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
      } catch {}
    }
    settings.hooks = settings.hooks || {};
    for (const [event, entries] of Object.entries(snippet.hooks)) {
      const existing = (settings.hooks[event] || []).filter(
        (e) => !JSON.stringify(e).includes('incontrol')
      );
      settings.hooks[event] = [...existing, ...entries];
    }
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2));
    return { ok: true, message: 'Installed Claude Code hooks into ~/.claude/settings.json' };
  }

  if (targetId === 'cursor') {
    upsertJsonMcpConfig(CURSOR_MCP_CONFIG, 'Cursor');
    return { ok: true, message: 'Installed InControl MCP into ~/.cursor/mcp.json' };
  }

  throw new Error(`Unknown integration target: ${targetId}`);
}

function upsertJsonMcpConfig(filePath, ideName) {
  let cfg = {};
  if (fs.existsSync(filePath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {}
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.incontrol = {
    command: 'node',
    args: [BIN_PATH, 'mcp', '--ide', ideName, '--provider', ideName.toLowerCase()],
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(cfg, null, 2));
}

function fileContains(filePath, substr) {
  try {
    return fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes(substr);
  } catch {
    return false;
  }
}

function readFirstLine(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(131072);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const str = buf.toString('utf8', 0, bytes);
    const nl = str.indexOf('\n');
    return nl !== -1 ? str.slice(0, nl) : str;
  } catch {
    return '';
  }
}

function readTailLines(filePath, maxLines = 25) {
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 262144);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim().startsWith('{'));
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function findRecentJsonlFiles(dir, limit = 4) {
  const results = [];
  function walk(current, depth = 0) {
    if (depth > 4 || !fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const stat = fs.statSync(full);
        if (Date.now() - stat.mtimeMs < 48 * 3600_000) {
          results.push({ path: full, mtimeMs: stat.mtimeMs });
        }
      }
    }
  }
  walk(dir, 0);
  results.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return results.slice(0, limit);
}
