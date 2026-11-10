import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClaudeSettingsSnippet } from './claude-hook.js';
import { getAgyHooksConfig } from './agy-hook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.resolve(__dirname, '../../bin/incontrol.js');

const HOME = os.homedir();
const AGY_BRAIN_DIR = path.join(HOME, '.gemini', 'antigravity', 'brain');
const AGY_CONFIG_DIR = path.join(HOME, '.gemini', 'config');
const AGY_HOOKS_CONFIG = path.join(AGY_CONFIG_DIR, 'hooks.json');
const AGY_MCP_CONFIG = path.join(AGY_CONFIG_DIR, 'mcp_config.json');
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
export function startAutoWatcher(store, intervalMs = 1500) {
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
    const agentId = `agy-${item.convId.slice(0, 8)}`;
    const existing = store.agents.get(agentId);
    const ageMs = Date.now() - item.mtimeMs;
    const shouldExpireAttention = existing?.status === 'needs_attention' && ageMs >= 45_000;
    const shouldExpireWorking = existing?.status === 'working' && ageMs >= 5 * 60_000;
    const key = `agy:${item.convId}`;
    if (seenMtimes.get(key) === item.mtimeMs && !shouldExpireAttention && !shouldExpireWorking) {
      continue;
    }
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

    const wsPath = workspace || process.cwd();
    const projectName = path.basename(wsPath) || 'Antigravity';

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
        if (ageMs < 45_000) {
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

  const recentFiles = findRecentJsonlFiles(CODEX_SESSIONS_DIR, 12);
  const byWorkspace = new Map();

  for (const file of recentFiles) {
    const headLine = readFirstLine(file.path);
    if (!headLine) continue;

    let meta = {};
    try {
      const parsed = JSON.parse(headLine);
      if (parsed.type === 'session_meta') meta = parsed.payload || {};
    } catch {}

    const cwd = meta.cwd || HOME;
    // Skip internal review-only threads if we already have a newer file, or group all files for this cwd
    if (!byWorkspace.has(cwd)) {
      byWorkspace.set(cwd, []);
    }
    byWorkspace.get(cwd).push({ file, meta });
  }

  const activeIds = new Set();

  for (const [cwd, items] of byWorkspace.entries()) {
    if (activeIds.size >= 4) break;
    // Primary file is the most recently modified file in this workspace
    const primary = items[0];
    const { file, meta } = primary;
    const projectName = path.basename(cwd) || 'workspace';
    const agentId = `codex-${projectName.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`;
    activeIds.add(agentId);

    const maxMtime = Math.max(...items.map((i) => i.file.mtimeMs));
    const existing = store.agents.get(agentId);
    const maxAgeMs = Date.now() - maxMtime;
    const shouldExpireAttention = existing?.status === 'needs_attention' && maxAgeMs >= 45_000;
    const shouldExpireWorking = existing?.status === 'working' && maxAgeMs >= 5 * 60_000;
    const key = `codex:${cwd}`;
    if (
      seenMtimes.get(key) === maxMtime &&
      existing &&
      !shouldExpireAttention &&
      !shouldExpireWorking
    ) {
      continue;
    }
    seenMtimes.set(key, maxMtime);

    // Find primary thread ID and title from main thread ID or parent_thread_id
    let primaryThreadId = meta.parent_thread_id || meta.session_id || meta.id || null;
    let threadTitle = null;
    for (const item of items) {
      const tid = item.meta.parent_thread_id || item.meta.session_id || item.meta.id;
      if (tid && !primaryThreadId) primaryThreadId = tid;
      if (tid && threadNames.has(tid)) {
        primaryThreadId = tid;
        threadTitle = threadNames.get(tid);
        break;
      }
    }
    threadTitle = threadTitle || 'Codex / ChatGPT task';

    const branch = meta.git?.branch || 'main';
    const originator = String(meta.originator || 'Codex Desktop');
    const isDesktopApp =
      originator.toLowerCase().includes('desktop') ||
      originator.toLowerCase().includes('chatgpt') ||
      items.some((i) => String(i.meta.originator || '').toLowerCase().includes('desktop'));

    const agentName = isDesktopApp ? 'ChatGPT / Codex' : 'Codex CLI';
    const ideName = isDesktopApp ? 'ChatGPT App' : 'Terminal';

    // Evaluate up to 4 recent rollout files in this workspace (main thread + any subagents)
    // Priority: needs_input (0) > working (1) > needs_attention (2) > idle (3)
    const RANK = { needs_input: 0, working: 1, needs_attention: 2, idle: 3 };
    let best = {
      status: 'idle',
      currentStep: 'Idle',
      attentionReason: null,
      pendingPrompt: null,
    };
    let latestUserPrompt = null;

    for (const item of items.slice(0, 4)) {
      const tailLines = readTailLines(item.file.path, 40);
      const ageMs = Date.now() - item.file.mtimeMs;
      let st = ageMs < 120_000 ? 'working' : 'idle';
      let step = ageMs < 120_000 ? 'Working…' : 'Idle';
      let reason = null;
      let prompt = null;

      for (const raw of tailLines) {
        try {
          const ev = JSON.parse(raw);
          const p = ev.payload || {};

          if (ev.type === 'response_item') {
            if (p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
              const txt = p.content.find((c) => c.text)?.text || '';
              if (
                txt &&
                !txt.startsWith('The following is the Codex agent history') &&
                !txt.startsWith('<environment_context>')
              ) {
                latestUserPrompt = latestUserPrompt || txt.trim().replace(/\s+/g, ' ').slice(0, 110);
              }
            } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
              st = 'working';
              const toolName = p.name || 'tool';
              const rawInput =
                typeof p.input === 'string' ? p.input : JSON.stringify(p.input || p.arguments || '');
              const cmdMatch = rawInput.match(/cmd:\s*"([^"]+)"/);
              const cleanCmd = cmdMatch ? cmdMatch[1] : rawInput.slice(0, 80);
              step = `${toolName}: ${cleanCmd}`;
              prompt = null;
            } else if (p.type === 'reasoning') {
              st = 'working';
              const summaryText =
                Array.isArray(p.summary) && p.summary[0]?.text
                  ? p.summary[0].text.replace(/\*\*/g, '').trim()
                  : null;
              if (summaryText) step = summaryText;
              prompt = null;
            } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
              st = 'working';
            }
          } else if (ev.type === 'event_msg') {
            if (
              p.type === 'exec_approval_request' ||
              p.type === 'apply_patch_approval_request' ||
              p.type === 'request_user_input'
            ) {
              st = 'needs_input';
              const cmd = Array.isArray(p.command) ? p.command.join(' ') : p.command || '';
              step = 'Waiting for approval in ' + ideName;
              prompt = {
                requestId: `codex_${ev.ordinal || Date.now()}`,
                question: p.reason || `Approve command in ${projectName}?`,
                command: cmd || null,
                options: [{ id: 'acknowledge', label: 'Focus & Approve', style: 'primary' }],
                allowFreeText: false,
                createdAt: item.file.mtimeMs,
              };
            } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
              st = ageMs < 45_000 ? 'needs_attention' : 'idle';
              step = st === 'needs_attention' ? 'Turn completed' : 'Idle';
              const msg = p.last_agent_message
                ? String(p.last_agent_message).replace(/\s+/g, ' ').trim()
                : '';
              // Ignore internal approval reviewer JSON verdicts as attentionReason
              if (msg && !msg.startsWith('{')) {
                reason = msg.slice(0, 110);
              } else {
                reason = 'Turn completed in ' + agentName;
              }
              prompt = null;
            } else if (
              p.type === 'task_started' ||
              p.type === 'exec_command_begin' ||
              p.type === 'agent_reasoning' ||
              p.type === 'item_completed' ||
              p.type === 'token_count'
            ) {
              if (ageMs < 10 * 60_000) {
                st = 'working';
                if (p.command) {
                  step = `Running: ${Array.isArray(p.command) ? p.command.join(' ') : p.command}`;
                }
                prompt = null;
              }
            }
          }
        } catch {}
      }

      if (st === 'working' && ageMs > 5 * 60_000) {
        st = 'idle';
        step = 'Idle';
      }

      if ((RANK[st] ?? 9) < (RANK[best.status] ?? 9)) {
        best = { status: st, currentStep: step, attentionReason: reason, pendingPrompt: prompt };
      }
    }

    store.upsertAgent({
      id: agentId,
      name: agentName,
      provider: 'codex',
      ide: ideName,
      workspace: cwd,
      projectName,
      branch,
      status: best.status,
      currentTask: latestUserPrompt || threadTitle,
      currentStep: best.currentStep,
      attentionReason: best.attentionReason,
      pendingPrompt: best.pendingPrompt,
    });

    if (primaryThreadId) {
      store.registerInputHandler(agentId, ({ action, text }) => {
        if ((action === 'reply' || action === 'steer') && text?.trim()) {
          queueCodexThreadMessage(primaryThreadId, text.trim(), cwd, store, agentId);
        }
      });
    }
  }

  // Remove any legacy duplicate codex-* entries that aren't in activeIds
  for (const existingId of store.agents.keys()) {
    if (existingId.startsWith('codex-') && !activeIds.has(existingId)) {
      store.removeAgent(existingId);
    }
  }
}

/**
 * Returns the live installation status of each supported agent integration on this Mac.
 */
export function getIntegrationsStatus() {
  const agyDetected = fs.existsSync(AGY_BRAIN_DIR);
  const agyHooksInstalled = fileContains(AGY_HOOKS_CONFIG, 'incontrol');
  const agyMcpInstalled = fileContains(AGY_MCP_CONFIG, 'incontrol');
  const agyFullyConfigured = agyHooksInstalled && agyMcpInstalled;

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
      subtitle: 'Lifecycle hooks (~/.gemini/config/hooks.json) + MCP + live transcript watcher',
      detected: agyDetected,
      autoWatched: agyDetected,
      configured: agyFullyConfigured,
      actionLabel: agyFullyConfigured ? 'Reinstall Hooks & MCP' : 'Enable Two-Way Control',
      statusText: agyFullyConfigured
        ? 'Hooks + MCP + Watcher Active'
        : agyDetected
        ? 'Live Watcher Active'
        : 'Not detected',
    },
    {
      id: 'codex_chatgpt',
      name: 'Codex + ChatGPT App',
      subtitle: 'Auto-watches ~/.codex sessions + queues messages via codex queue & MCP',
      detected: codexDetected,
      autoWatched: codexDetected,
      configured: codexMcpInstalled,
      actionLabel: codexMcpInstalled ? 'Reinstall MCP' : 'Enable Two-Way MCP',
      statusText: codexMcpInstalled
        ? 'Live Queue + MCP Active'
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
    const agyHooks = getAgyHooksConfig(`node ${BIN_PATH}`);
    let existingHooks = {};
    if (fs.existsSync(AGY_HOOKS_CONFIG)) {
      try {
        existingHooks = JSON.parse(fs.readFileSync(AGY_HOOKS_CONFIG, 'utf8'));
      } catch {}
    }
    Object.assign(existingHooks, agyHooks);
    fs.mkdirSync(AGY_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(AGY_HOOKS_CONFIG, JSON.stringify(existingHooks, null, 2));
    return {
      ok: true,
      message: 'Installed Antigravity hooks.json & mcp_config.json into ~/.gemini/config/',
    };
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

function resolveCodexBin() {
  const candidates = [
    path.join(HOME, '.local', 'bin', 'codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ];
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return 'codex';
}

function queueCodexThreadMessage(threadId, text, cwd, store, agentId) {
  const bin = resolveCodexBin();
  const child = spawn(bin, ['queue', '--thread', threadId, '--message', text], {
    cwd: fs.existsSync(cwd) ? cwd : HOME,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  child.on('close', (code) => {
    const agent = store.agents.get(agentId);
    if (!agent) return;
    if (code === 0) {
      agent.currentStep = `Queued in ChatGPT/Codex: "${text.slice(0, 48)}"`;
    } else if (stderr.trim()) {
      agent.currentStep = `Queued for MCP inbox: "${text.slice(0, 48)}"`;
    }
    store.emit('change', { type: 'agent_updated', agent: store.serializeAgent(agent) });
  });
}
