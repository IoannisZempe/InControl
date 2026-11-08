import path from 'node:path';
import { hubHeaders } from './http.js';

const DEFAULT_HUB_URL = process.env.INCONTROL_URL || 'http://localhost:4747';

/**
 * Native Antigravity (AGY) lifecycle hook handler (`~/.gemini/config/hooks.json`).
 * Reads camelCase JSON from stdin and writes the hook contract JSON to stdout.
 *
 * Supported events:
 * - PreInvocation: injects any queued messages sent from InControl into the agent loop
 * - PreToolUse: updates live tool status, and gates `ask_question` (or `run_command` with --gate)
 * - PostToolUse: logs tool completion/errors
 * - Stop: marks turn ready for review, or continues immediately if user queued a follow-up in InControl
 */
export async function runAgyHook(args = []) {
  const hubUrl = process.env.INCONTROL_URL || DEFAULT_HUB_URL;
  const eventName = args[0] || 'PreToolUse';
  const gateCommands = args.includes('--gate-commands') || args.includes('--gate');

  const rawStdin = await readStdinWithTimeout(1500);
  let payload = {};
  if (rawStdin.trim()) {
    try {
      payload = JSON.parse(rawStdin);
    } catch {}
  }

  const convId = payload.conversationId || 'default';
  const workspace =
    (Array.isArray(payload.workspacePaths) && payload.workspacePaths[0]) || process.cwd();
  const projectName = path.basename(workspace) || 'Antigravity';
  const agentId = `agy-${convId.slice(0, 8)}`;
  const lastUserInput = cleanUserRequest(payload.lastUserInput || '');

  const baseAgent = {
    id: agentId,
    name: 'Antigravity',
    provider: 'antigravity',
    ide: 'Antigravity',
    workspace,
    projectName,
    ...(lastUserInput ? { currentTask: lastUserInput } : {}),
  };

  try {
    // 1. PreInvocation — Check if user queued a steering message or stop command from InControl
    if (eventName === 'PreInvocation') {
      const res = await fetch(`${hubUrl}/api/agents/event`, {
        method: 'POST',
        headers: hubHeaders(),
        body: JSON.stringify({
          ...baseAgent,
          status: 'working',
          currentStep: `Thinking (step ${payload.invocationNum || 1})…`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      const messages = Array.isArray(data.queuedMessages) ? data.queuedMessages : [];

      const stopMsg = messages.find((m) => m.action === 'stop' || m.action === 'terminate');
      if (stopMsg) {
        return writeStdout({
          terminationBehavior: 'terminate',
          injectSteps: [
            {
              errorMessage: {
                userMessage: `Stopped from InControl (${stopMsg.sourceDevice || 'Panel'}).`,
              },
            },
          ],
        });
      }

      const textMessages = messages.filter((m) => m.text && m.text.trim());
      if (textMessages.length > 0) {
        const combined = textMessages
          .map((m) => `[From InControl (${m.sourceDevice || 'Panel'})]: ${m.text}`)
          .join('\n');
        return writeStdout({
          injectSteps: [{ userMessage: combined }],
        });
      }

      return writeStdout({});
    }

    // 2. PreToolUse — Report tool call, and optionally gate commands or remote-answer ask_question
    if (eventName === 'PreToolUse') {
      const toolName = (payload.toolCall?.name || 'tool').replace(/^default_api:/, '');
      const toolArgs = payload.toolCall?.args || {};
      const summary =
        toolArgs.toolSummary ||
        toolArgs.CommandLine ||
        (toolArgs.Path ? path.basename(toolArgs.Path) : '') ||
        toolName;

      // If Antigravity is calling ask_question, surface it in InControl so user can answer remotely
      if (toolName === 'ask_question' && Array.isArray(toolArgs.questions) && toolArgs.questions[0]) {
        const q = toolArgs.questions[0];
        const options = (q.options || []).map((opt, idx) => ({
          id: String(opt).replace(/^\(Recommended\)\s*/i, ''),
          label: String(opt).replace(/^\(Recommended\)\s*/i, '').slice(0, 32),
          style: idx === 0 ? 'primary' : 'secondary',
        }));

        await fetch(`${hubUrl}/api/agents/ask`, {
          method: 'POST',
          headers: hubHeaders(),
          body: JSON.stringify({
            ...baseAgent,
            wait: false,
            question: q.question || 'Antigravity is asking a question',
            toolName: 'ask_question',
            options,
            allowFreeText: true,
          }),
        }).catch(() => {});

        return writeStdout({ decision: 'allow' });
      }

      // If command gating is enabled, hold run_command until approved in InControl
      if (gateCommands && toolName === 'run_command' && toolArgs.CommandLine) {
        const res = await fetch(`${hubUrl}/api/agents/ask`, {
          method: 'POST',
          headers: hubHeaders(),
          body: JSON.stringify({
            ...baseAgent,
            wait: true,
            question: toolArgs.toolSummary || `Allow command in ${projectName}?`,
            toolName: 'run_command',
            command: toolArgs.CommandLine,
            options: [
              { id: 'approve', label: 'Approve', style: 'primary' },
              { id: 'deny', label: 'Deny', style: 'danger' },
            ],
            allowFreeText: true,
          }),
        });
        const decision = await res.json();
        if (decision.action === 'deny') {
          return writeStdout({
            decision: 'deny',
            reason: `Denied via InControl (${decision.sourceDevice || 'Panel'})${
              decision.text ? `: ${decision.text}` : ''
            }`,
          });
        }
        // If user typed a modified command or note when replying
        return writeStdout({ decision: 'allow' });
      }

      await fetch(`${hubUrl}/api/agents/event`, {
        method: 'POST',
        headers: hubHeaders(),
        body: JSON.stringify({
          ...baseAgent,
          status: 'working',
          currentStep: `${toolName}: ${String(summary).slice(0, 90)}`,
          incrementTools: true,
          logType: 'tool',
          logMessage: `${toolName}: ${String(summary).slice(0, 90)}`,
        }),
      });

      return writeStdout({ decision: 'allow' });
    }

    // 3. PostToolUse
    if (eventName === 'PostToolUse') {
      const toolName = (payload.toolCall?.name || 'tool').replace(/^default_api:/, '');
      if (payload.error) {
        await fetch(`${hubUrl}/api/agents/event`, {
          method: 'POST',
          headers: hubHeaders(),
          body: JSON.stringify({
            ...baseAgent,
            status: 'working',
            currentStep: `${toolName} failed: ${String(payload.error).slice(0, 80)}`,
            logType: 'error',
            logMessage: `${toolName} error: ${String(payload.error).slice(0, 80)}`,
          }),
        });
      }
      return writeStdout({});
    }

    // 4. Stop — If user queued a follow-up instruction in InControl, continue automatically!
    if (eventName === 'Stop') {
      const res = await fetch(`${hubUrl}/api/agents/event`, {
        method: 'POST',
        headers: hubHeaders(),
        body: JSON.stringify({
          ...baseAgent,
          status: 'needs_attention',
          currentStep: 'Turn complete — ready for review',
          attentionReason:
            payload.terminationReason && payload.terminationReason !== 'NO_TOOL_CALL'
              ? `Stopped (${payload.terminationReason})`
              : 'Response complete — send a follow-up or dismiss',
          logType: 'success',
          logMessage: `Finished turn (${payload.terminationReason || 'NO_TOOL_CALL'})`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      const messages = Array.isArray(data.queuedMessages) ? data.queuedMessages : [];
      const textMessages = messages.filter((m) => m.text && m.text.trim());

      if (textMessages.length > 0) {
        const combined = textMessages
          .map((m) => `User instruction from InControl (${m.sourceDevice || 'Panel'}): ${m.text}`)
          .join('\n');
        return writeStdout({
          decision: 'continue',
          reason: combined,
        });
      }

      return writeStdout({ decision: 'allow' });
    }

    return writeStdout({});
  } catch {
    // Always output valid JSON so Antigravity never blocks if hub is offline
    if (eventName === 'PreToolUse') return writeStdout({ decision: 'allow' });
    return writeStdout({});
  }
}

export function getAgyHooksConfig(binCmd) {
  return {
    incontrol: {
      enabled: true,
      PreInvocation: [
        {
          type: 'command',
          command: `${binCmd} hook agy PreInvocation`,
          timeout: 10,
        },
      ],
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `${binCmd} hook agy PreToolUse`,
              timeout: 300,
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `${binCmd} hook agy PostToolUse`,
              timeout: 10,
            },
          ],
        },
      ],
      Stop: [
        {
          type: 'command',
          command: `${binCmd} hook agy Stop`,
          timeout: 15,
        },
      ],
    },
  };
}

function cleanUserRequest(raw) {
  const m = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  const text = (m ? m[1] : raw).trim().replace(/\s+/g, ' ');
  return text.slice(0, 110);
}

function writeStdout(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function readStdinWithTimeout(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
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
