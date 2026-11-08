import { execFile } from 'node:child_process';
import os from 'node:os';

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

/**
 * Focus the IDE or Terminal window associated with an agent on macOS.
 * Uses `on run argv` positional arguments so user/agent strings are never interpolated into AppleScript code.
 */
export function focusAgentWindow(agent) {
  return new Promise((resolve) => {
    if (os.platform() !== 'darwin') {
      resolve({
        ok: false,
        reason: `Window focusing is currently supported on macOS (detected ${os.platform()})`,
      });
      return;
    }

    const ideKey = String(agent.ide || agent.provider || 'Terminal').toLowerCase().trim();
    const appName = String(IDE_APP_MAP[ideKey] || agent.ide || 'Terminal').slice(0, 80);
    const projectHint = String(agent.windowHint || agent.projectName || '').slice(0, 120);

    const script = `
      on run argv
        set targetApp to item 1 of argv
        set projectHint to item 2 of argv
        try
          tell application targetApp to activate
          if projectHint is not "" then
            tell application "System Events"
              if exists process targetApp then
                tell process targetApp
                  set frontmost to true
                  repeat with w in windows
                    if (name of w contains projectHint) then
                      perform action "AXRaise" of w
                      exit repeat
                    end if
                  end repeat
                end tell
              end if
            end tell
          end if
          return "Focused " & targetApp
        on error errMsg
          return "Error: " & errMsg
        end try
      end run
    `;

    execFile('osascript', ['-e', script, '--', appName, projectHint], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, appName, error: err.message });
      } else {
        resolve({ ok: true, appName, output: stdout.trim() });
      }
    });
  });
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
