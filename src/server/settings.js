import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { validateRailwayUrl } from './context-collector.js';

const CONFIG_DIR = process.env.INCONTROL_HOME || path.join(os.homedir(), '.incontrol');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');

// Strict allowlist of built-in read-only/safe workspace commands (prevents arbitrary command execution via API)
export const SAFE_WORKSPACE_COMMANDS = Object.freeze({
  'git status -sb': { bin: 'git', args: ['status', '-sb'] },
  'git diff --stat': { bin: 'git', args: ['diff', '--stat'] },
  'git log -n 5 --oneline': { bin: 'git', args: ['log', '-n', '5', '--oneline'] },
  'git branch --show-current': { bin: 'git', args: ['branch', '--show-current'] },
  'npm test': { bin: 'npm', args: ['test', '--ignore-scripts'] },
});

export const DEFAULT_FUNCTIONS = [
  {
    id: 'fn_tests',
    label: 'Run Tests',
    icon: 'agent',
    type: 'prompt',
    payload: 'Run the test suite and fix any failing tests.',
    pinned: true,
  },
  {
    id: 'fn_security',
    label: 'Security Check',
    icon: 'agent',
    type: 'prompt',
    payload: 'Audit recent changes for security risks, exposed secrets, or regressions.',
    pinned: true,
  },
  {
    id: 'fn_commit',
    label: 'Commit & Push',
    icon: 'agent',
    type: 'prompt',
    payload: 'Stage all changes, write a concise commit message, and push to origin.',
    pinned: true,
  },
  {
    id: 'fn_git_status',
    label: 'Git Status',
    icon: 'project',
    type: 'shell',
    payload: 'git status -sb',
    pinned: true,
  },
];

export const DEFAULT_SETTINGS = {
  logoStyle: 'orbit', // 'orbit' | 'reticle' | 'sliders'
  iconMode: 'both', // 'both' (Project + Tool badge) | 'tool' (ChatGPT/Claude/Codex/AG) | 'project'
  theme: 'obsidian', // 'obsidian' | 'raycast' | 'hud' | 'titanium'
  dockSide: 'right', // 'right' | 'left'
  panelWidth: 386, // 348 | 386 | 436
  popupMode: 'needs_input', // 'needs_input' | 'urgent_and_review' | 'always'
  showFunctionBar: true,
  allowVoiceApproval: false, // Siri / voice shortcuts can read status by default; approvals are opt-in
  homekitEnabled: false, // Apple Home (HomeKit HAP bridge)
  allowHomekitApproval: true, // HomeKit "Approve Waiting Agent" switch
  railwayUrl: '', // Railway Collector service base URL (e.g. https://incontrol-archive.up.railway.app)
  railwayToken: '', // Bearer token for Railway Collector (masked on public API responses)
  railwayProjectUrl: '', // Optional Railway dashboard URL for quick linking
  customFunctions: DEFAULT_FUNCTIONS,
};

export function getPublicUserSettings() {
  const full = loadUserSettings();
  return {
    ...full,
    hasRailwayToken: Boolean(full.railwayToken),
    railwayToken: full.railwayToken ? '••••••••' : '',
  };
}

export function loadUserSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
      return normalizeSettings(parsed);
    }
  } catch {}
  return normalizeSettings({});
}

export function saveUserSettings(patch = {}) {
  const current = loadUserSettings();
  const cleanPatch = { ...patch };
  if (cleanPatch.railwayToken === '••••••••' || cleanPatch.railwayToken === undefined) {
    delete cleanPatch.railwayToken;
  }
  if (typeof cleanPatch.railwayUrl === 'string') {
    const check = validateRailwayUrl(cleanPatch.railwayUrl);
    if (!check.ok) {
      throw new Error(check.error);
    }
    cleanPatch.railwayUrl = check.url;
  }
  const merged = normalizeSettings({ ...current, ...cleanPatch });
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2) + '\n', { mode: 0o600 });
  } catch {}
  return merged;
}

function normalizeSettings(raw = {}) {
  const logoStyle = ['orbit', 'reticle', 'sliders'].includes(raw.logoStyle)
    ? raw.logoStyle
    : DEFAULT_SETTINGS.logoStyle;
  const iconMode = ['both', 'tool', 'project'].includes(raw.iconMode)
    ? raw.iconMode
    : DEFAULT_SETTINGS.iconMode;
  const mappedTheme = raw.theme === 'sapphire' ? 'hud' : raw.theme;
  const theme = ['obsidian', 'raycast', 'hud', 'titanium'].includes(mappedTheme)
    ? mappedTheme
    : DEFAULT_SETTINGS.theme;
  const dockSide = ['right', 'left'].includes(raw.dockSide)
    ? raw.dockSide
    : DEFAULT_SETTINGS.dockSide;
  const panelWidth = Math.max(320, Math.min(520, Number(raw.panelWidth) || DEFAULT_SETTINGS.panelWidth));
  const popupMode = ['needs_input', 'urgent_and_review', 'always'].includes(raw.popupMode)
    ? raw.popupMode
    : DEFAULT_SETTINGS.popupMode;
  const showFunctionBar =
    typeof raw.showFunctionBar === 'boolean' ? raw.showFunctionBar : DEFAULT_SETTINGS.showFunctionBar;
  const allowVoiceApproval =
    typeof raw.allowVoiceApproval === 'boolean' ? raw.allowVoiceApproval : DEFAULT_SETTINGS.allowVoiceApproval;
  const homekitEnabled =
    typeof raw.homekitEnabled === 'boolean' ? raw.homekitEnabled : DEFAULT_SETTINGS.homekitEnabled;
  const allowHomekitApproval =
    typeof raw.allowHomekitApproval === 'boolean'
      ? raw.allowHomekitApproval
      : DEFAULT_SETTINGS.allowHomekitApproval;
  const railwayUrlCheck = validateRailwayUrl(raw.railwayUrl);
  const railwayUrl = railwayUrlCheck.ok ? railwayUrlCheck.url : DEFAULT_SETTINGS.railwayUrl;
  const railwayToken =
    typeof raw.railwayToken === 'string' ? raw.railwayToken.trim().slice(0, 256) : DEFAULT_SETTINGS.railwayToken;
  const railwayProjectUrl =
    typeof raw.railwayProjectUrl === 'string' && raw.railwayProjectUrl.startsWith('https://railway.com/')
      ? raw.railwayProjectUrl.trim().slice(0, 256)
      : '';

  let customFunctions = DEFAULT_FUNCTIONS;
  if (Array.isArray(raw.customFunctions)) {
    customFunctions = raw.customFunctions
      .filter((f) => f && typeof f.label === 'string' && f.label.trim() && typeof f.payload === 'string')
      .slice(0, 20)
      .map((f) => {
        const type = ['prompt', 'shell', 'webhook'].includes(f.type) ? f.type : 'prompt';
        let rawIcon = String(f.icon || '').trim().slice(0, 24);
        if (!rawIcon || ['⚡', '🛡️', '🚀'].includes(rawIcon)) {
          rawIcon = type === 'shell' ? 'project' : 'agent';
        } else if (rawIcon === '🌿') {
          rawIcon = 'project';
        }
        return {
          id: String(f.id || `fn_${crypto.randomUUID().slice(0, 8)}`),
          label: String(f.label).trim().slice(0, 32),
          icon: rawIcon,
          type,
          payload: String(f.payload).trim().slice(0, 500),
          pinned: f.pinned !== false,
        };
      });
  }

  return {
    logoStyle,
    iconMode,
    theme,
    dockSide,
    panelWidth,
    popupMode,
    showFunctionBar,
    allowVoiceApproval,
    homekitEnabled,
    allowHomekitApproval,
    railwayUrl,
    railwayToken,
    railwayProjectUrl,
    customFunctions,
  };
}

/**
 * Executes a user-configured function against a specific agent.
 */
export async function executeCustomFunction(store, agentId, fnId) {
  const agent = store.agents.get(agentId);
  if (!agent) {
    return { ok: false, error: `Agent '${agentId}' not found` };
  }

  const settings = loadUserSettings();
  const fn = settings.customFunctions.find((f) => f.id === fnId);
  if (!fn) {
    return { ok: false, error: `Function '${fnId}' not found` };
  }

  if (fn.type === 'prompt') {
    const res = store.respondToAgent(agentId, {
      action: 'reply',
      text: fn.payload,
      sourceDevice: `Function · ${fn.label}`,
    });
    return {
      ok: res.ok,
      type: 'prompt',
      message: `Sent "${fn.label}" to ${agent.projectName}`,
    };
  }

  if (fn.type === 'shell') {
    const allowed = SAFE_WORKSPACE_COMMANDS[fn.payload.trim()];
    if (!allowed) {
      return {
        ok: false,
        error: `Command not in safe allowlist. Allowed commands: ${Object.keys(SAFE_WORKSPACE_COMMANDS).join(', ')}`,
      };
    }
    const cwd = agent.workspace && fs.existsSync(agent.workspace) ? agent.workspace : os.homedir();
    return new Promise((resolve) => {
      execFile(
        allowed.bin,
        allowed.args,
        { cwd, timeout: 15_000, maxBuffer: 256 * 1024, shell: false },
        (err, stdout, stderr) => {
          const out = String(stdout || stderr || (err ? err.message : 'Done'))
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 180);
          store.upsertAgent({
            id: agent.id,
            currentStep: `${fn.label}: ${out || 'Completed (exit 0)'}`,
            logType: err ? 'error' : 'tool',
            logMessage: `[${fn.label}] $ ${fn.payload} → ${out || 'OK'}`,
          });
          resolve({
            ok: !err,
            type: 'shell',
            output: out,
            message: `${fn.label}: ${out || 'Completed'}`,
          });
        }
      );
    });
  }

  if (fn.type === 'webhook') {
    let parsedUrl;
    try {
      parsedUrl = new URL(fn.payload);
    } catch {
      return { ok: false, error: 'Invalid webhook URL' };
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return { ok: false, error: 'Webhook URL must use http:// or https://' };
    }
    const host = parsedUrl.hostname.toLowerCase();
    if (host === '169.254.169.254' || host === 'metadata.google.internal' || host === '0.0.0.0') {
      return { ok: false, error: 'Webhook URL host is not permitted' };
    }
    const resp = await fetch(parsedUrl.href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'incontrol.custom_function',
        function: { id: fn.id, label: fn.label },
        agent: store.serializeAgent(agent),
        timestamp: Date.now(),
      }),
    });
    store.upsertAgent({
      id: agent.id,
      logType: 'info',
      logMessage: `[${fn.label}] Webhook POST → HTTP ${resp.status}`,
    });
    return {
      ok: resp.ok,
      type: 'webhook',
      message: `Triggered "${fn.label}" (HTTP ${resp.status})`,
    };
  }

  return { ok: false, error: `Unsupported function type: ${fn.type}` };
}

