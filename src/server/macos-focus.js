import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IDE_APP_MAP = {
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  chatgpt: 'ChatGPT',
  'chatgpt app': 'ChatGPT',
  'codex desktop': 'ChatGPT',
  codex: 'ChatGPT',
  'vs code': 'Visual Studio Code',
  vscode: 'Visual Studio Code',
  windsurf: 'Windsurf',
  zed: 'Zed',
  iterm: 'iTerm2',
  iterm2: 'iTerm2',
  ghostty: 'Ghostty',
  warp: 'Warp',
  terminal: 'Terminal',
  'terminal / claude': 'Terminal',
};

const WORKSPACE_ARG_APPS = new Set(['Cursor', 'Visual Studio Code', 'Windsurf', 'Zed']);

function execFileAsync(execFileFn, cmd, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFileFn(cmd, args, { timeout }, (err, stdout = '', stderr = '') => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: err ? err.message : null,
      });
    });
  });
}

function isUsableWorkspace(ws, existsFn) {
  if (!ws || typeof ws !== 'string') return false;
  const norm = path.resolve(ws);
  if (norm === '/' || norm === os.homedir()) return false;
  try {
    return existsFn(norm);
  } catch {
    return false;
  }
}

/**
 * Focuses the IDE, Terminal window, or exact agent thread associated with an agent on macOS.
 * Priority:
 *  1. ChatGPT / Codex Desktop deep-link (`codex://threads/<threadId>`) — opens the exact agent thread with zero permissions.
 *  2. Workspace-capable editor launch (`open -a <App> <workspace>`) — focuses that exact project window without Accessibility.
 *  3. Native `open -a <App>` + isolated best-effort AppleScript window-title raise (`AXRaise` when Accessibility is granted).
 */
export async function focusAgentWindow(
  agent,
  {
    platform = os.platform(),
    execFileFn = execFile,
    existsSyncFn = fs.existsSync,
  } = {}
) {
  if (platform !== 'darwin') {
    return {
      ok: false,
      reason: `Window focusing is currently supported on macOS (detected ${platform})`,
    };
  }

  const ideKey = String(agent?.ide || agent?.provider || 'Terminal').toLowerCase().trim();
  const appName = String(IDE_APP_MAP[ideKey] || agent?.ide || 'Terminal').slice(0, 80);
  const projectHint = String(agent?.windowHint || agent?.projectName || '').slice(0, 120);
  const threadId = String(agent?.metadata?.threadId || '').trim();

  // 1. Direct ChatGPT / Codex thread deep link -> lands on the exact conversation that asked the question
  if (appName === 'ChatGPT' && /^[a-zA-Z0-9_-]{6,80}$/.test(threadId)) {
    const deepUrl = `codex://threads/${encodeURIComponent(threadId)}`;
    const openRes = await execFileAsync(execFileFn, 'open', [deepUrl], 3000);
    if (openRes.ok) {
      return {
        ok: true,
        appName,
        projectName: agent?.projectName || '',
        deepLinked: true,
        exactTarget: true,
        output: `Opened ${deepUrl}`,
      };
    }
  }

  // 2. Editors that natively focus/reveal a workspace window via LaunchServices `open -a <App> <dir>`
  if (WORKSPACE_ARG_APPS.has(appName) && isUsableWorkspace(agent?.workspace, existsSyncFn)) {
    const openWs = await execFileAsync(execFileFn, 'open', ['-a', appName, path.resolve(agent.workspace)], 3000);
    if (openWs.ok) {
      return {
        ok: true,
        appName,
        projectName: agent?.projectName || path.basename(agent.workspace),
        exactTarget: true,
        output: `Focused ${agent.workspace} in ${appName}`,
      };
    }
  }

  // 3. Always bring the target application to front cleanly without depending on Accessibility permission
  const openApp = await execFileAsync(execFileFn, 'open', ['-a', appName], 3000);

  // 4. Best-effort window-title focus inside an isolated System Events block so AX denial never breaks activation
  const script = `
    on run argv
      set targetApp to item 1 of argv
      set projectHint to item 2 of argv
      try
        tell application targetApp to activate
      end try
      if projectHint is not "" then
        try
          tell application "System Events"
            if exists process targetApp then
              tell process targetApp
                set frontmost to true
                repeat with w in windows
                  if (name of w contains projectHint) then
                    perform action "AXRaise" of w
                    return "MATCHED:" & targetApp
                  end if
                end repeat
              end tell
            end if
          end try
          return "ACTIVATED:" & targetApp
        on error errMsg
          if errMsg contains "assistive access" then
            return "AX_DENIED:" & targetApp
          end if
          return "ACTIVATED:" & targetApp
        end try
      end if
      return "ACTIVATED:" & targetApp
    end run
  `;

  const osa = await execFileAsync(execFileFn, 'osascript', ['-e', script, '--', appName, projectHint], 3000);
  const out = osa.stdout || '';

  if (!openApp.ok && !osa.ok) {
    return {
      ok: false,
      appName,
      error: openApp.error || osa.error || 'Could not focus application',
    };
  }

  const exactTarget = out.startsWith('MATCHED:');
  const needsAccessibility = out.startsWith('AX_DENIED:');
  return {
    ok: true,
    appName,
    projectName: agent?.projectName || '',
    exactTarget,
    needsAccessibility,
    output: out || `Activated ${appName}`,
  };
}

/**
 * Trigger a native macOS Notification Center banner safely via `on run argv`.
 */
export function sendMacNotification({ title, body, subtitle = '' }) {
  if (os.platform() !== 'darwin') return;
  const cleanTitle = String(title || 'InControl').slice(0, 120);
  const cleanBody = String(body || '').slice(0, 240);
  const cleanSub = String(subtitle || '').slice(0, 120);

  const script = `
    on run argv
      set notifTitle to item 1 of argv
      set notifBody to item 2 of argv
      set notifSub to item 3 of argv
      if notifSub is not "" then
        display notification notifBody with title notifTitle subtitle notifSub sound name "Glass"
      else
        display notification notifBody with title notifTitle sound name "Glass"
      end if
    end run
  `;
  execFile('osascript', ['-e', script, '--', cleanTitle, cleanBody, cleanSub], { timeout: 2500 }, () => {});
}
