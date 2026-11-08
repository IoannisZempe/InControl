import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_HUB_URL = process.env.INCONTROL_URL || 'http://localhost:4747';

/**
 * Processes a Claude Code hook invocation from stdin and reports to the InControl Hub.
 * Supports: PreToolUse, PostToolUse, Notification, Stop, UserPromptSubmit
 */
export async function runClaudeHook(args = []) {
  const hubUrl = process.env.INCONTROL_URL || DEFAULT_HUB_URL;
  const gateBash = args.includes('--gate-bash') || args.includes('--gate');

  const rawStdin = await readStdinWithTimeout(1500);
  let payload = {};
  if (rawStdin.trim()) {
    try {
      payload = JSON.parse(rawStdin);
    } catch {
      payload = { message: rawStdin.trim() };
    }
  }

  const eventName = payload.hook_event_name || args[0] || 'Notification';
  const cwd = payload.cwd || process.cwd();
  const sessionId = payload.session_id ? `claude-${payload.session_id.slice(0, 12)}` : `claude-${path.basename(cwd)}`;
  const projectName = path.basename(cwd) || 'workspace';
  const ide = process.env.TERM_PROGRAM || 'Terminal';

  const baseAgent = {
    id: sessionId,
    name: 'Claude Code',
    provider: 'claude-code',
    ide,
    workspace: cwd,
    projectName,
  };

  try {
    if (eventName === 'PreToolUse') {
      const toolName = payload.tool_name || 'Tool';
      const cmdPreview =
        payload.tool_input?.command ||
        payload.tool_input?.file_path ||
        JSON.stringify(payload.tool_input || {}).slice(0, 100);

      // Optional remote permission gate for Bash commands
      if (gateBash && toolName === 'Bash' && payload.tool_input?.command) {
        const res = await fetch(`${hubUrl}/api/agents/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...baseAgent,
            wait: true,
            question: `Allow Claude Code to run Bash command in ${projectName}?`,
            toolName: 'Bash',
            command: payload.tool_input.command,
            options: [
              { id: 'approve', label: 'Approve', style: 'primary' },
              { id: 'deny', label: 'Deny', style: 'danger' },
            ],
          }),
        });
        const decision = await res.json();
        if (decision.action === 'deny') {
          // Claude Code PreToolUse exit code 2 blocks the tool call and feeds stderr back to Claude
          process.stderr.write(
            `Blocked via InControl panel${decision.text ? `: ${decision.text}` : '.'}\n`
          );
          process.exit(2);
        }
        return;
      }

      await fetch(`${hubUrl}/api/agents/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseAgent,
          status: 'working',
          currentStep: `${toolName}: ${cmdPreview}`,
          incrementTools: true,
          logType: 'tool',
          logMessage: `Running ${toolName}: ${cmdPreview}`,
        }),
      });
    } else if (eventName === 'Notification') {
      const message = payload.message || payload.title || 'Claude Code is waiting for your input in terminal';
      await fetch(`${hubUrl}/api/agents/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseAgent,
          wait: false,
          question: message,
          toolName: 'Terminal Prompt',
          options: [
            { id: 'acknowledge', label: 'Mark Handled', style: 'primary' },
          ],
          allowFreeText: false,
        }),
      });
    } else if (eventName === 'Stop') {
      await fetch(`${hubUrl}/api/agents/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseAgent,
          status: 'needs_attention',
          currentStep: 'Finished response — ready for your review',
          attentionReason: 'Claude Code completed its turn.',
          logType: 'success',
          logMessage: 'Turn complete (Stop hook triggered)',
        }),
      });
    } else if (eventName === 'UserPromptSubmit') {
      const promptText = payload.prompt || 'Executing user prompt';
      await fetch(`${hubUrl}/api/agents/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseAgent,
          status: 'working',
          currentTask: promptText.slice(0, 120),
          currentStep: 'Thinking & planning...',
          logType: 'info',
          logMessage: `Prompt submitted: ${promptText.slice(0, 80)}`,
        }),
      });
    } else {
      await fetch(`${hubUrl}/api/agents/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...baseAgent,
          status: 'working',
          currentStep: `Event: ${eventName}`,
        }),
      });
    }
  } catch {
    // Never break Claude Code if the InControl hub isn't running
  }
}

/**
 * Generates or installs the Claude Code hook snippet into ~/.claude/settings.json
 */
export function getClaudeSettingsSnippet(binPath = 'npx incontrol-agents') {
  return {
    hooks: {
      UserPromptSubmit: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: `${binPath} hook claude UserPromptSubmit` }],
        },
      ],
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: `${binPath} hook claude PreToolUse` }],
        },
      ],
      Notification: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: `${binPath} hook claude Notification` }],
        },
      ],
      Stop: [
        {
          matcher: '',
          hooks: [{ type: 'command', command: `${binPath} hook claude Stop` }],
        },
      ],
    },
  };
}

function readStdinWithTimeout(timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    const timer = setTimeout(() => {
      resolve(data);
    }, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}
