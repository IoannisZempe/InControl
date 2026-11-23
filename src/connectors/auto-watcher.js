import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getClaudeSettingsSnippet } from './claude-hook.js';
import { getAgyHooksConfig } from './agy-hook.js';
import { getCliEntryPath, resolvePersistentInvocation } from '../server/runtime-paths.js';

const BIN_PATH = getCliEntryPath();

const HOME = os.homedir();
const AGY_BRAIN_DIR = path.join(HOME, '.gemini', 'antigravity', 'brain');
const AGY_CONFIG_DIR = path.join(HOME, '.gemini', 'config');
const AGY_HOOKS_CONFIG = path.join(AGY_CONFIG_DIR, 'hooks.json');
const AGY_MCP_CONFIG = path.join(AGY_CONFIG_DIR, 'mcp_config.json');
const AGY_PLUGIN_DIR = path.join(AGY_CONFIG_DIR, 'plugins', 'incontrol');
const AGY_PLUGIN_MANIFEST = path.join(AGY_PLUGIN_DIR, 'plugin.json');
const AGY_PLUGIN_HOOKS = path.join(AGY_PLUGIN_DIR, 'hooks.json');
const AGY_PLUGIN_MCP = path.join(AGY_PLUGIN_DIR, 'mcp_config.json');
const AGY_PLUGIN_SIDECAR_DIR = path.join(AGY_PLUGIN_DIR, 'sidecars', 'bridge');
const AGY_PLUGIN_SIDECAR = path.join(AGY_PLUGIN_SIDECAR_DIR, 'sidecar.json');
const AGY_USER_CONFIG = path.join(AGY_CONFIG_DIR, 'config.json');
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
  const dismissedPrompts = new Set();

  function scanAll() {
    try {
      scanAntigravitySessions(store, seenMtimes, dismissedPrompts);
    } catch {}
    try {
      scanCodexAndChatGptSessions(store, seenMtimes, dismissedPrompts);
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
export function scanAntigravitySessions(store, seenMtimes = new Map(), dismissedPrompts = new Set()) {
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
    const hasFreshUserOrHookState =
      existing &&
      (existing.metrics?.updatedAt || 0) > item.mtimeMs &&
      (existing.status === 'working' ||
        existing.status === 'needs_input' ||
        existing.status === 'needs_attention' ||
        (existing.status === 'idle' && existing.currentStep === 'Acknowledged by user'));

    const activePromptId = existing?.pendingPrompt?.requestId;
    if (existing && !activePromptId && existing._lastAgyPromptId && existing.metrics?.promptsAnswered > (existing._lastAgyAnsweredCount || 0)) {
      dismissedPrompts.add(existing._lastAgyPromptId);
    }

    const shouldExpirePrompt = existing?.status === 'needs_input' && ageMs >= 45 * 60_000;
    const shouldExpireAttention =
      existing?.status === 'needs_attention' && ageMs >= 15 * 60_000 && !hasFreshUserOrHookState;
    const shouldExpireWorking =
      existing?.status === 'working' && ageMs >= 5 * 60_000 && (existing.metrics?.updatedAt || 0) <= item.mtimeMs;

    if (hasFreshUserOrHookState && !shouldExpirePrompt && !shouldExpireAttention && !shouldExpireWorking) {
      seenMtimes.set(`agy:${item.convId}`, item.mtimeMs);
      continue;
    }

    const key = `agy:${item.convId}`;
    if (seenMtimes.get(key) === item.mtimeMs && !shouldExpireAttention && !shouldExpireWorking && !shouldExpirePrompt) {
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
        const reqId = `agy_turn_${item.convId.slice(0, 8)}_${lastStep.step_index ?? Math.round(item.mtimeMs)}`;
        const wasDismissed =
          dismissedPrompts.has(reqId) ||
          (existing?.currentStep === 'Acknowledged by user' &&
            (existing.metrics?.updatedAt || 0) >= item.mtimeMs);
        const actionReq =
          lastStep.content && !wasDismissed
            ? detectActionRequest(lastStep.content, false, 'Antigravity')
            : null;

        if (actionReq && ageMs < 45 * 60_000) {
          status = 'needs_input';
          currentStep = actionReq.step;
          attentionReason = null;
          pendingPrompt = {
            requestId: reqId,
            question: actionReq.question,
            details: actionReq.details,
            options: actionReq.options,
            allowFreeText: true,
            createdAt: item.mtimeMs,
          };
        } else if (!wasDismissed && ageMs < 15 * 60_000) {
          status = 'needs_attention';
          currentStep = 'Response complete';
          attentionReason = (lastStep.content || 'Finished response — ready for review')
            .replace(/[#*`]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 140);
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

    const updatedAgent = store.upsertAgent({
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
      windowHint: projectName !== 'Antigravity' ? projectName : undefined,
      metadata: {
        conversationId: item.convId,
        transcriptPath: item.transcriptPath,
      },
      updatedAt: item.mtimeMs,
    });
    if (pendingPrompt?.requestId) {
      updatedAgent._lastAgyPromptId = pendingPrompt.requestId;
      updatedAgent._lastAgyAnsweredCount = updatedAgent.metrics?.promptsAnswered || 0;
    }
  }

  // Expire stale Antigravity attention/working/input states even after conversations fall out of the top-3 active list
  // (e.g. Stop hooks fired hours earlier). Keeps yesterday's finished sessions from clogging "Needs Review".
  const now = Date.now();
  for (const [id, agent] of store.agents.entries()) {
    if (!id.startsWith('agy-')) continue;
    const ageMs = now - (agent.metrics?.updatedAt || agent.metrics?.startedAt || 0);
    if (agent.status === 'needs_attention' && ageMs >= 15 * 60_000) {
      store.upsertAgent({
        id,
        status: 'idle',
        currentStep: 'Idle',
        attentionReason: null,
        pendingPrompt: null,
        updatedAt: agent.metrics?.updatedAt,
      });
    } else if (agent.status === 'working' && ageMs >= 10 * 60_000) {
      store.upsertAgent({
        id,
        status: 'idle',
        currentStep: 'Idle',
        attentionReason: null,
        updatedAt: agent.metrics?.updatedAt,
      });
    } else if (agent.status === 'needs_input' && ageMs >= 45 * 60_000) {
      store.upsertAgent({
        id,
        status: 'idle',
        currentStep: 'Idle',
        attentionReason: null,
        pendingPrompt: null,
        updatedAt: agent.metrics?.updatedAt,
      });
    } else if (agent.status === 'idle' && ageMs >= 12 * 3600_000) {
      store.removeAgent(id);
    }
  }
}

/**
 * Watches ~/.codex/session_index.jsonl and ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 * Automatically tracks both OpenAI Codex CLI and the ChatGPT Desktop App (Codex Desktop).
 */
export function scanCodexAndChatGptSessions(store, seenMtimes = new Map(), dismissedPrompts = new Set()) {
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
    // Prefer primary user thread over internal guardian_review subthreads for metadata
    items.sort((a, b) => {
      const aGuard = a.meta.thread_source === 'guardian_review' ? 1 : 0;
      const bGuard = b.meta.thread_source === 'guardian_review' ? 1 : 0;
      if (aGuard !== bGuard) return aGuard - bGuard;
      return b.file.mtimeMs - a.file.mtimeMs;
    });
    const primary = items[0];
    const { meta } = primary;
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
      const isGuardian = item.meta.thread_source === 'guardian_review';
      const tailLines = readTailLines(item.file.path, 60);
      const ageMs = Date.now() - item.file.mtimeMs;
      let st = ageMs < 120_000 ? 'working' : 'idle';
      let step = ageMs < 120_000 ? 'Working…' : 'Idle';
      let reason = null;
      let prompt = null;
      let turnHadHandoff = false;

      for (const raw of tailLines) {
        try {
          const ev = JSON.parse(raw);
          const p = ev.payload || {};

          if (ev.type === 'response_item') {
            if (p.type === 'message' && p.role === 'user' && Array.isArray(p.content)) {
              const rawTxt = p.content.find((c) => c.text)?.text || '';
              if (
                rawTxt &&
                !rawTxt.startsWith('The following is the Codex agent history') &&
                !rawTxt.startsWith('<environment_context>')
              ) {
                const cleaned = rawTxt
                  .replace(/<in-app-browser-context[\s\S]*?<\/in-app-browser-context>/gi, '')
                  .replace(/^#+\s*My request:\s*/im, '')
                  .trim()
                  .replace(/\s+/g, ' ');
                if (cleaned) {
                  latestUserPrompt = cleaned.slice(0, 110);
                }
                st = ageMs < 10 * 60_000 ? 'working' : 'idle';
                step = st === 'working' ? 'Thinking…' : 'Idle';
                reason = null;
                turnHadHandoff = false;
                prompt = null;
              }
            } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
              st = 'working';
              reason = null;
              const toolName = p.name || 'tool';
              const rawInput =
                typeof p.input === 'string' ? p.input : JSON.stringify(p.input || p.arguments || '');
              if (rawInput.includes('markHandoff')) {
                turnHadHandoff = true;
              }
              const cmdMatch = rawInput.match(/cmd:\s*"([^"]+)"/);
              const cleanCmd = cmdMatch ? cmdMatch[1] : rawInput.slice(0, 80);
              step = `${toolName}: ${cleanCmd}`;
              prompt = null;
            } else if (p.type === 'reasoning') {
              st = 'working';
              reason = null;
              const summaryText =
                Array.isArray(p.summary) && p.summary[0]?.text
                  ? p.summary[0].text.replace(/\*\*/g, '').trim()
                  : null;
              if (summaryText) step = summaryText;
              else if (step === 'Turn completed' || step === 'Idle') step = 'Thinking…';
              prompt = null;
            } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
              st = 'working';
              reason = null;
              if (step === 'Turn completed' || step === 'Idle') step = 'Working…';
            }
          } else if (ev.type === 'event_msg') {
            if (
              p.type === 'exec_approval_request' ||
              p.type === 'apply_patch_approval_request' ||
              p.type === 'request_user_input'
            ) {
              const reqId = `codex_${ev.ordinal || Date.now()}`;
              if (!dismissedPrompts.has(reqId)) {
                st = 'needs_input';
                const cmd = Array.isArray(p.command) ? p.command.join(' ') : p.command || '';
                step = 'Waiting for approval in ' + ideName;
                prompt = {
                  requestId: reqId,
                  question: p.reason || `Approve command in ${projectName}?`,
                  command: cmd || null,
                  options: [
                    { id: 'focus_and_dismiss', label: 'Focus & Approve', style: 'primary' },
                    { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
                  ],
                  allowFreeText: false,
                  createdAt: item.file.mtimeMs,
                };
              }
            } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
              if (isGuardian) {
                st = 'idle';
                step = 'Idle';
                prompt = null;
                continue;
              }
              const rawMsg = p.last_agent_message ? String(p.last_agent_message).trim() : '';
              const reqId = `codex_turn_${p.turn_id || ev.ordinal || item.file.mtimeMs}`;
              const actionReq =
                rawMsg && !rawMsg.startsWith('{')
                  ? detectActionRequest(rawMsg, turnHadHandoff, ideName)
                  : null;

              if (actionReq && !dismissedPrompts.has(reqId) && ageMs < 45 * 60_000) {
                st = 'needs_input';
                step = actionReq.step;
                reason = null;
                prompt = {
                  requestId: reqId,
                  question: actionReq.question,
                  details: actionReq.details,
                  options: actionReq.options,
                  allowFreeText: true,
                  createdAt: item.file.mtimeMs,
                };
              } else {
                st = ageMs < 15 * 60_000 ? 'needs_attention' : 'idle';
                step = st === 'needs_attention' ? 'Turn completed' : 'Idle';
                const cleanMsg = rawMsg.replace(/\s+/g, ' ');
                if (cleanMsg && !cleanMsg.startsWith('{')) {
                  reason = cleanMsg.slice(0, 110);
                } else {
                  reason = 'Turn completed in ' + agentName;
                }
                prompt = null;
              }
            } else if (
              p.type === 'task_started' ||
              p.type === 'exec_command_begin' ||
              p.type === 'agent_reasoning'
            ) {
              if (p.type === 'task_started') {
                turnHadHandoff = false;
                prompt = null;
              }
              if (ageMs < 10 * 60_000) {
                st = 'working';
                reason = null;
                if (p.command) {
                  step = `Running: ${Array.isArray(p.command) ? p.command.join(' ') : p.command}`;
                } else if (p.type === 'task_started' || step === 'Turn completed' || step === 'Idle') {
                  step = 'Thinking…';
                }
                prompt = null;
              }
            } else if (p.type === 'item_completed' || p.type === 'token_count') {
              // Trailing metadata after task_complete must not flip a completed turn back to working
              if (st !== 'needs_attention' && st !== 'needs_input' && ageMs < 10 * 60_000) {
                st = 'working';
                reason = null;
                if (step === 'Turn completed' || step === 'Idle') {
                  step = 'Working…';
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

    const hasActiveMcpPrompt =
      existing?.status === 'needs_input' &&
      existing?.pendingPrompt &&
      !String(existing.pendingPrompt.requestId || '').startsWith('codex_');
    if (hasActiveMcpPrompt) {
      best = {
        status: existing.status,
        currentStep: existing.currentStep,
        attentionReason: existing.attentionReason,
        pendingPrompt: existing.pendingPrompt,
      };
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
      metadata: {
        threadId: primaryThreadId,
        sessionFile: primary.file.path,
      },
      updatedAt: maxMtime,
    });

    if (primaryThreadId) {
      store.registerInputHandler(agentId, ({ action, text, requestId }) => {
        if (requestId) {
          dismissedPrompts.add(requestId);
        }
        if (action === 'dismiss' || action === 'acknowledge') return;
        let msgText = text?.trim() || '';
        if (!msgText && (action === 'approve' || action === 'yes')) {
          msgText = 'Approved, please proceed.';
        }
        if (msgText) {
          queueCodexThreadMessage(primaryThreadId, msgText, cwd, store, agentId, ideName);
        }
      });
    }
  }

  // Remove any legacy duplicate codex-* entries that aren't in activeIds (unless blocked on MCP needs_input)
  for (const [existingId, existingAgent] of store.agents.entries()) {
    if (
      existingId.startsWith('codex-') &&
      !activeIds.has(existingId) &&
      existingAgent?.status !== 'needs_input'
    ) {
      store.removeAgent(existingId);
    }
  }
}

/**
 * Returns the live installation status of each supported agent integration on this Mac.
 */
export function getIntegrationsStatus() {
  const agyDetected = fs.existsSync(AGY_BRAIN_DIR);
  const agyHooksInstalled =
    fileContains(AGY_PLUGIN_HOOKS, 'incontrol') || fileContains(AGY_HOOKS_CONFIG, 'incontrol');
  const agyMcpInstalled =
    fileContains(AGY_PLUGIN_MCP, 'incontrol') || fileContains(AGY_MCP_CONFIG, 'incontrol');
  const agySidecarInstalled = fileContains(AGY_PLUGIN_SIDECAR, 'sidecar');
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
      iconUrl: '/api/icons/tool/antigravity',
      subtitle: 'Antigravity plugin (~/.gemini/config/plugins/incontrol) + Hooks + MCP + Sidecar Bridge',
      detected: agyDetected,
      autoWatched: agyDetected,
      configured: agyFullyConfigured,
      sidecarConfigured: agySidecarInstalled,
      actionLabel: agyFullyConfigured ? 'Reinstall Hooks, MCP & Sidecar' : 'Enable Two-Way Control',
      statusText: agyFullyConfigured && agySidecarInstalled
        ? 'Hooks + MCP + Sidecar Bridge Active'
        : agyFullyConfigured
        ? 'Hooks + MCP + Watcher Active'
        : agyDetected
        ? 'Live Watcher Active'
        : 'Not detected',
    },
    {
      id: 'codex_chatgpt',
      name: 'Codex + ChatGPT App',
      iconUrl: '/api/icons/tool/chatgpt',
      secondaryIconUrl: '/api/icons/tool/codex',
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
      iconUrl: '/api/icons/tool/claude',
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
      iconUrl: '/api/icons/tool/cursor',
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
function stripLegacyIncontrolHooks() {
  if (!fs.existsSync(AGY_HOOKS_CONFIG)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(AGY_HOOKS_CONFIG, 'utf8'));
    if (!raw || typeof raw !== 'object') return;
    let changed = false;
    if (raw.hooks && typeof raw.hooks === 'object') {
      for (const [eventName, entries] of Object.entries(raw.hooks)) {
        if (!Array.isArray(entries)) continue;
        const filtered = entries.filter((entry) => !JSON.stringify(entry).includes('incontrol'));
        if (filtered.length !== entries.length) {
          changed = true;
          if (filtered.length) raw.hooks[eventName] = filtered;
          else delete raw.hooks[eventName];
        }
      }
    }
    if (changed) {
      fs.writeFileSync(AGY_HOOKS_CONFIG, JSON.stringify(raw, null, 2));
    }
  } catch {}
}

export function installIntegration(targetId) {
  const inv = resolvePersistentInvocation(BIN_PATH);

  if (targetId === 'antigravity') {
    const agyHooks = getAgyHooksConfig(inv.shellCommand);
    const pluginManifest = {
      name: 'incontrol',
      displayName: 'InControl',
      version: '1.0.0',
      description: 'Two-way steering, approvals, and status hooks for InControl Mission Control.',
      hooks: './hooks.json',
      mcpServers: './mcp_config.json',
    };
    const pluginMcp = {
      mcpServers: {
        incontrol: {
          command: inv.command,
          args: [...inv.args, 'mcp'],
        },
      },
    };
    const pluginRulesDir = path.join(AGY_PLUGIN_DIR, 'rules');
    const pluginRuleMd = `# InControl Two-Way Remote Steering

When a user prompt or turn includes \`[From InControl\` (steered from the Mac Side Panel or mobile dashboard), OR when pausing for explicit user approval/confirmation in a session connected to InControl:
- Prefer calling the \`incontrol_ask_human\` MCP tool (with \`question\`, \`options\`, and optional \`command\`) instead of ending the turn in plain prose alone, whenever you expect a follow-up click or command from the panel.
- Holding on \`incontrol_ask_human\` keeps the session alive so clicking Approve/Commit/Send in the InControl panel executes immediately without switching back to the Antigravity IDE.
`;
    const pluginSidecar = {
      display_name: 'InControl Live Bridge',
      description: 'Delivers InControl and TheOne replies directly into Antigravity conversations via agentapi.',
      command: inv.command,
      args: [...inv.args, 'sidecar', 'agy'],
      restart_policy: 'always',
    };
    fs.mkdirSync(pluginRulesDir, { recursive: true });
    fs.mkdirSync(AGY_PLUGIN_SIDECAR_DIR, { recursive: true });
    fs.writeFileSync(AGY_PLUGIN_MANIFEST, JSON.stringify(pluginManifest, null, 2));
    fs.writeFileSync(AGY_PLUGIN_HOOKS, JSON.stringify(agyHooks, null, 2));
    fs.writeFileSync(AGY_PLUGIN_MCP, JSON.stringify(pluginMcp, null, 2));
    fs.writeFileSync(AGY_PLUGIN_SIDECAR, JSON.stringify(pluginSidecar, null, 2));
    fs.writeFileSync(path.join(pluginRulesDir, 'AGENTS.md'), pluginRuleMd);
    enableAgySidecarInConfig('incontrol/bridge');
    upsertJsonMcpConfig(AGY_MCP_CONFIG, 'Antigravity');
    stripLegacyIncontrolHooks();
    return {
      ok: true,
      message:
        'Installed InControl Antigravity plugin (hooks + MCP + sidecar bridge + rule) in ~/.gemini/config/plugins/incontrol/ and enabled sidecar in ~/.gemini/config/config.json',
    };
  }

  if (targetId === 'codex_chatgpt') {
    fs.mkdirSync(CODEX_DIR, { recursive: true });
    let toml = fs.existsSync(CODEX_CONFIG_TOML) ? fs.readFileSync(CODEX_CONFIG_TOML, 'utf8') : '';
    if (!toml.includes('[mcp_servers.incontrol]')) {
      const mcpArgs = [...inv.args, 'mcp', '--ide', 'ChatGPT App', '--provider', 'codex'];
      const block = `\n[mcp_servers.incontrol]\ncommand = ${JSON.stringify(inv.command)}\nargs = ${JSON.stringify(mcpArgs)}\n`;
      toml = toml.trimEnd() + '\n' + block;
      fs.writeFileSync(CODEX_CONFIG_TOML, toml, 'utf8');
    }
    return { ok: true, message: 'Added [mcp_servers.incontrol] to ~/.codex/config.toml' };
  }

  if (targetId === 'claude') {
    const snippet = getClaudeSettingsSnippet(inv.shellCommand);
    let settings = {};
    if (fs.existsSync(CLAUDE_SETTINGS)) {
      try {
        settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
        fs.copyFileSync(CLAUDE_SETTINGS, `${CLAUDE_SETTINGS}.incontrol-backup`);
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

function enableAgySidecarInConfig(sidecarId) {
  let cfg = {};
  if (fs.existsSync(AGY_USER_CONFIG)) {
    try {
      cfg = JSON.parse(fs.readFileSync(AGY_USER_CONFIG, 'utf8'));
    } catch {}
  }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    cfg = {};
  }
  cfg.sidecars = cfg.sidecars && typeof cfg.sidecars === 'object' ? cfg.sidecars : {};
  const existing = cfg.sidecars[sidecarId] && typeof cfg.sidecars[sidecarId] === 'object' ? cfg.sidecars[sidecarId] : {};
  cfg.sidecars[sidecarId] = {
    ...existing,
    enabled: true,
  };
  fs.mkdirSync(path.dirname(AGY_USER_CONFIG), { recursive: true });
  fs.writeFileSync(AGY_USER_CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function upsertJsonMcpConfig(filePath, ideName) {
  const inv = resolvePersistentInvocation(BIN_PATH);
  let cfg = {};
  if (fs.existsSync(filePath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {}
  }
  cfg.mcpServers = cfg.mcpServers || {};
  cfg.mcpServers.incontrol = {
    command: inv.command,
    args: [...inv.args, 'mcp', '--ide', ideName, '--provider', ideName.toLowerCase()],
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

function readTailLines(filePath, maxLines = 60) {
  try {
    const stat = fs.statSync(filePath);
    const readSize = Math.min(stat.size, 1048576);
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

function extractNumberedOptions(boundedMsg) {
  const opts = [];
  const re = /^\s*(\d+)\.\s+(?:\*\*([^*\n]{2,64}?)(?:\s+[—–-]\s*[^*\n]*)?\*\*|([^\n]{2,52}?)(?:\s+[—–-]|[:.]|\s*$))/gm;
  let m;
  while ((m = re.exec(boundedMsg)) !== null) {
    const num = m[1];
    const rawTitle = (m[2] || m[3] || '').replace(/[—–.:]+$/, '').trim();
    if (!rawTitle || opts.some((o) => o.num === num)) continue;
    opts.push({ num, label: rawTitle });
  }
  return opts.length >= 2 && opts.length <= 5 ? opts : [];
}

function trimOptionButtonLabel(num, title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim();
  const short = clean.length > 18 ? `${clean.slice(0, 17).trimEnd()}…` : clean;
  return short ? `Option ${num}: ${short}` : `Option ${num}`;
}

/**
 * Detects when an agent turn (Codex, ChatGPT Desktop, or Antigravity) ends with a message
 * asking the user to confirm an action, complete a browser sign-in/handoff, or reply with a phrase.
 */
export function detectActionRequest(rawMsg, turnHadHandoff = false, ideName = 'ChatGPT App') {
  if (!rawMsg) return null;
  const boundedMsg = String(rawMsg).slice(-4000);

  const stripMd = (s) =>
    String(s)
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[*`]/g, '')
      .trim();

  const paragraphs = boundedMsg
    .split(/\n\s*\n/)
    .map((p) => stripMd(p.replace(/\s+/g, ' ')))
    .filter(Boolean);

  if (paragraphs.length === 0) return null;

  const promptCueRe =
    /\b(?:confirm|say|reply|respond|tell me|sign in|log in|approve|authorize|should i|would you|do you|choose|pick|select|which option|let me know|\?)/i;

  // Pick the paragraph that contains the actual action request (usually the last or second-to-last paragraph)
  let actionIdx = paragraphs.length - 1;
  if (
    paragraphs.length > 1 &&
    !promptCueRe.test(paragraphs[actionIdx]) &&
    promptCueRe.test(paragraphs[actionIdx - 1])
  ) {
    actionIdx = actionIdx - 1;
  }

  const questionPara = paragraphs[actionIdx];
  const otherParas = paragraphs.filter((_, i) => i !== actionIdx);
  const prevParas = otherParas.join('\n• ').slice(0, 280) || null;
  const tailText = paragraphs.slice(-2).join(' ');

  // 1. Explicit quoted/bolded phrase requested: e.g. Say **“approve quote”**, Reply **"commit and push to main"**, reply with "yes"
  const phraseMatch = boundedMsg.match(
    /\b(?:say|reply(?:\s+with)?|respond(?:\s+with)?|type|tell\s+me)\s+(?:\*\*["“'‘`]?|["“'‘`])([^*"”'’`\n.,!]{1,48})(?:["”'’`]?\*\*|["”'’`])/i
  );
  const candidatePhrase = phraseMatch ? phraseMatch[1].trim() : null;
  const isSpecificPhrase =
    candidatePhrase &&
    !/^(when|once|if|whether|that|what|how|why|where)\b/i.test(candidatePhrase);

  if (isSpecificPhrase) {
    return {
      step: `Waiting for "${candidatePhrase}" in ${ideName}`,
      question: questionPara,
      details: prevParas,
      options: [
        {
          id: 'quick_reply',
          label: `Reply "${candidatePhrase}"`,
          style: 'primary',
          replyText: candidatePhrase,
        },
        { id: 'focus_and_dismiss', label: `Open ${ideName}`, style: 'secondary' },
        { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
      ],
    };
  }

  // 2. Explicit confirmation or option-approval prompt:
  // e.g. "Confirm that you want me to...", "Approve option 1 and I'll write the design...", "Pick an option"
  if (
    /\b(?:confirm that|confirm whether|please confirm|confirm before|want me to|should i|would you like me to|do you want me to|shall i|approve\s+(?:launch|option|approach|plan|step|this|that)\b|approve\s+[^.\n]{1,36}\band\s+i['’]?ll\b|click authorize|choose\s+(?:an?\s+)?(?:option|approach)|pick\s+(?:an?\s+)?(?:option|approach)|select\s+(?:an?\s+)?(?:option|approach)|let me know which|which\s+(?:option|approach)\b)/i.test(
      tailText
    )
  ) {
    const numbered = extractNumberedOptions(boundedMsg);
    const preferredMatch = tailText.match(/\b(?:approve|recommend|prefer|pick|choose)\s+option\s+(\d+)\b/i)
      || tailText.match(/\boption\s+(\d+)\b/i);
    const preferredNum = preferredMatch ? preferredMatch[1] : null;

    let actionButtons;
    if (numbered.length >= 2) {
      const ordered = preferredNum
        ? [
            ...numbered.filter((o) => o.num === preferredNum),
            ...numbered.filter((o) => o.num !== preferredNum),
          ]
        : numbered;
      actionButtons = ordered.slice(0, 3).map((o, idx) => ({
        id: 'quick_reply',
        label: trimOptionButtonLabel(o.num, o.label),
        style: idx === 0 ? 'primary' : 'secondary',
        replyText: preferredMatch && o.num === preferredNum
          ? `Approve option ${o.num}`
          : `Option ${o.num}`,
      }));
    } else if (preferredNum) {
      actionButtons = [
        {
          id: 'quick_reply',
          label: `Approve Option ${preferredNum}`,
          style: 'primary',
          replyText: `Approve option ${preferredNum}`,
        },
      ];
    } else {
      actionButtons = [
        {
          id: 'quick_reply',
          label: 'Confirm & Proceed',
          style: 'primary',
          replyText: 'Confirmed, please proceed.',
        },
      ];
    }

    return {
      step: `Waiting for your confirmation in ${ideName}`,
      question: questionPara,
      details: prevParas,
      options: [
        ...actionButtons,
        { id: 'focus_and_dismiss', label: `Open ${ideName}`, style: 'secondary' },
        { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
      ],
    };
  }

  // 3. Browser handoff / OAuth sign-in / "Tell me when you reach..."
  if (
    turnHadHandoff ||
    /\b(?:tell me when|let me know when|once you(?:'ve| have)|when it finishes|please sign in|sign in directly|complete [^.\n]{0,40}sign-in|complete [^.\n]{0,40}verification|log in to)\b/i.test(
      tailText
    )
  ) {
    return {
      step: `Waiting on your browser / sign-in step in ${ideName}`,
      question: questionPara,
      details: prevParas,
      options: [
        {
          id: 'quick_reply',
          label: 'Done — Continue',
          style: 'primary',
          replyText: 'Done, please continue.',
        },
        { id: 'focus_and_dismiss', label: `Open ${ideName}`, style: 'secondary' },
        { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
      ],
    };
  }

  // 4. Direct question at the end of the turn
  if (/\?\s*$/.test(questionPara)) {
    return {
      step: `Waiting for your answer in ${ideName}`,
      question: questionPara,
      details: prevParas,
      options: [
        {
          id: 'quick_reply',
          label: 'Yes, Proceed',
          style: 'primary',
          replyText: 'Yes, please proceed.',
        },
        { id: 'focus_and_dismiss', label: `Open ${ideName}`, style: 'secondary' },
        { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
      ],
    };
  }

  return null;
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

const codexBinsWithoutResume = new Set();

export function resolveCodexBin(ideName = 'ChatGPT App', exists = fs.existsSync) {
  const desktopBundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const standaloneCandidates = [
    path.join(HOME, '.local', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ];
  const candidates =
    ideName === 'ChatGPT App'
      ? [desktopBundled, ...standaloneCandidates]
      : [...standaloneCandidates, desktopBundled];
  for (const bin of candidates) {
    if (exists(bin)) return bin;
  }
  return 'codex';
}

export function inspectAgentDelivery(store, agent, respondResult = null) {
  if (!agent) {
    return { ready: false, mode: 'missing', warning: 'Agent not found.' };
  }
  if (store?.stdinHandlers?.has?.(agent.id)) {
    return { ready: true, mode: 'stdin' };
  }
  const tool = (agent.provider || agent.tool || agent.toolKey || '').toLowerCase();
  const isTurnEnded = agent.status === 'idle' || agent.status === 'needs_attention';

  if (respondResult?.deliveredViaBridge) {
    return { ready: true, mode: 'sidecar-bridge' };
  }

  if (respondResult?.deliveredLive) {
    return { ready: true, mode: tool === 'antigravity' ? 'plugin' : 'live' };
  }

  if (tool === 'antigravity') {
    if (store?.hasProviderBridge?.('antigravity') && agent.metadata?.conversationId) {
      return {
        ready: true,
        mode: 'sidecar-bridge',
      };
    }
    const hooksReady =
      fileContains(AGY_PLUGIN_HOOKS, 'incontrol') || fileContains(AGY_HOOKS_CONFIG, 'incontrol');
    const mcpReady =
      fileContains(AGY_PLUGIN_MCP, 'incontrol') || fileContains(AGY_MCP_CONFIG, 'incontrol');
    if (!hooksReady) {
      return {
        ready: false,
        mode: 'unconfigured',
        warning:
          'Queued, but Antigravity two-way hooks are not installed yet — click "+ Connect" -> Setup Antigravity so Security Check & Steer reach your session.',
      };
    }
    if (respondResult?.requiresWake || isTurnEnded) {
      return {
        ready: false,
        requiresWake: true,
        mode: 'queued-needs-wake',
        idleNote:
          'Queued — this Antigravity turn has ended. Click Copy + Focus & paste/send in Antigravity (or have the agent ask via incontrol_ask_human).',
        warning:
          'Queued in InControl, but this Antigravity turn already ended — Antigravity plugins cannot wake an ended IDE turn from outside. Click Copy + Focus to submit it in Antigravity.',
      };
    }
    return {
      ready: true,
      mode: mcpReady ? 'plugin' : 'hook',
    };
  }

  if (tool === 'codex') {
    const hasThread = Boolean(agent.metadata?.threadId || agent.metadata?.sessionFile);
    const hasMcp = fileContains(CODEX_CONFIG_TOML, 'incontrol');
    if (hasThread || hasMcp) {
      return {
        ready: true,
        mode: hasThread ? 'codex-thread' : 'mcp',
      };
    }
    return {
      ready: false,
      mode: 'unconfigured',
      warning:
        'Queued, but Codex CLI / MCP delivery is not configured yet — click "+ Connect" -> Setup Codex.',
    };
  }

  if (tool === 'claude-code') {
    if (fileContains(CLAUDE_SETTINGS, 'incontrol')) {
      return { ready: true, mode: 'hook' };
    }
    return {
      ready: false,
      mode: 'unconfigured',
      warning:
        'Queued, but Claude Code hooks are not installed yet — click "+ Connect" -> Setup Claude Code.',
    };
  }

  if (tool === 'cursor') {
    if (fileContains(CURSOR_MCP_CONFIG, 'incontrol')) {
      return { ready: true, mode: 'mcp' };
    }
    return {
      ready: false,
      mode: 'unconfigured',
      warning:
        'Queued, but Cursor MCP is not installed yet — click "+ Connect" -> Setup Cursor.',
    };
  }

  return { ready: true, mode: 'queue' };
}

export function queueCodexThreadMessage(
  threadId,
  text,
  cwd,
  store,
  agentId,
  ideName = 'ChatGPT App',
  { spawnFn = spawn, binOverride = null, useResume = true } = {}
) {
  const bin = binOverride || resolveCodexBin(ideName);
  const resumeFlag = useResume && !codexBinsWithoutResume.has(bin);
  const queueArgs = resumeFlag
    ? ['queue', '--resume', '--thread', threadId, '--message', text]
    : ['queue', '--thread', threadId, '--message', text];

  const child = spawnFn(bin, queueArgs, {
    cwd: fs.existsSync(cwd) ? cwd : HOME,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d) => {
    stderr += d.toString();
  });
  child.on('error', (err) => {
    const agent = store.agents.get(agentId);
    if (!agent) return;
    store._appendLog(agent, {
      type: 'error',
      message: `[InControl] Failed to run "${bin} queue": ${err.message}`,
      timestamp: Date.now(),
    });
    agent.queuedMessages.push({
      id: `msg_${Date.now().toString(36)}`,
      action: 'reply',
      text,
      sourceDevice: 'Panel',
      timestamp: Date.now(),
    });
    agent.status = 'needs_attention';
    agent.currentStep = `Queued for MCP inbox (CLI unavailable): "${text.slice(0, 48)}"`;
    store.emit('change', { type: 'agent_updated', agent: store.serializeAgent(agent) });
  });
  child.on('close', (code) => {
    if (code !== 0 && resumeFlag && /unexpected argument ['"`]?--resume/i.test(stderr)) {
      codexBinsWithoutResume.add(bin);
      queueCodexThreadMessage(threadId, text, cwd, store, agentId, ideName, {
        spawnFn,
        binOverride: bin,
        useResume: false,
      });
      return;
    }

    const agent = store.agents.get(agentId);
    if (!agent) return;
    if (code === 0) {
      agent.status = 'working';
      agent.currentStep = `Sent to ${ideName}: "${text.slice(0, 48)}"`;
      agent.attentionReason = null;
    } else {
      const detail = stderr.trim().split('\n').pop() || `exit ${code}`;
      store._appendLog(agent, {
        type: 'info',
        message: `[InControl] codex queue exited (${detail}); left in MCP inbox`,
        timestamp: Date.now(),
      });
      agent.queuedMessages.push({
        id: `msg_${Date.now().toString(36)}`,
        action: 'reply',
        text,
        sourceDevice: 'Panel',
        timestamp: Date.now(),
      });
      agent.status = 'needs_attention';
      agent.currentStep = `Queued for MCP inbox: "${text.slice(0, 48)}"`;
      agent.attentionReason = `codex queue failed (${detail.slice(0, 64)}); left in MCP inbox.`;
    }
    store.emit('change', { type: 'agent_updated', agent: store.serializeAgent(agent) });
  });
}
