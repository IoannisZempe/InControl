import { execFile } from 'node:child_process';
import os from 'node:os';

const IDE_APP_MAP = {
  cursor: 'Cursor',
  antigravity: 'Antigravity',
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
    const appName = IDE_APP_MAP[ideKey] || agent.ide || 'Terminal';
    const projectHint = (agent.windowHint || agent.projectName || '').replace(/"/g, '');

    // AppleScript that activates the target IDE/terminal app and attempts to raise the matching project window
    const script = `
      set targetApp to "${appName.replace(/"/g, '')}"
      set projectHint to "${projectHint}"
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
    `;

    execFile('osascript', ['-e', script], { timeout: 3000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, appName, error: err.message });
      } else {
        resolve({ ok: true, appName, output: stdout.trim() });
      }
    });
  });
}

/**
 * Trigger a native macOS Notification Center banner.
 */
export function sendMacNotification({ title, body, subtitle = '' }) {
  if (os.platform() !== 'darwin') return;
  const cleanTitle = String(title || 'InControl').replace(/"/g, '\\"');
  const cleanBody = String(body || '').replace(/"/g, '\\"');
  const cleanSub = String(subtitle || '').replace(/"/g, '\\"');
  const script = `display notification "${cleanBody}" with title "${cleanTitle}"${cleanSub ? ` subtitle "${cleanSub}"` : ''} sound name "Glass"`;
  execFile('osascript', ['-e', script], { timeout: 2500 }, () => {});
}
