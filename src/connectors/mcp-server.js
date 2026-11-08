import path from 'node:path';
import readline from 'node:readline';

const DEFAULT_HUB_URL = process.env.INCONTROL_URL || 'http://localhost:4747';

/**
 * Starts a standards-compliant JSON-RPC 2.0 Model Context Protocol (MCP) server over stdio.
 * Compatible with Antigravity, Cursor, Windsurf, VS Code, Claude Desktop, and Zed.
 */
export function runMcpServer(args = []) {
  const hubUrl = process.env.INCONTROL_URL || DEFAULT_HUB_URL;
  const provider = getFlagValue(args, '--provider') || process.env.INCONTROL_PROVIDER || 'antigravity';
  const ide = getFlagValue(args, '--ide') || process.env.INCONTROL_IDE || 'Antigravity / IDE';
  const agentName = getFlagValue(args, '--name') || process.env.INCONTROL_NAME || `${ide} Agent`;
  const workspace = process.cwd();
  const agentId = `${provider}-${path.basename(workspace)}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  function sendResponse(id, result) {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
    process.stdout.write(`${msg}\n`);
  }

  function sendError(id, code, message) {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    process.stdout.write(`${msg}\n`);
  }

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }

    const { id, method, params } = req;

    try {
      if (method === 'initialize') {
        // Auto-register the IDE agent with the InControl Hub on MCP initialization
        fetch(`${hubUrl}/api/agents/event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: agentId,
            name: agentName,
            provider,
            ide,
            workspace,
            status: 'idle',
            currentTask: 'Connected via MCP',
            currentStep: 'Standing by in IDE',
          }),
        }).catch(() => {});

        return sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'incontrol-mcp',
            version: '0.1.0',
          },
        });
      }

      if (method === 'notifications/initialized') {
        return;
      }

      if (method === 'tools/list') {
        return sendResponse(id, {
          tools: [
            {
              name: 'incontrol_status',
              description:
                'Update this agent’s live status in the user’s InControl side panel and mobile dashboard. Also returns any queued messages sent by the user.',
              inputSchema: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['working', 'needs_attention', 'idle'],
                    description: 'Current agent attention status.',
                  },
                  currentTask: {
                    type: 'string',
                    description: 'High-level task summary being worked on.',
                  },
                  currentStep: {
                    type: 'string',
                    description: 'Current specific step, file, or tool being executed.',
                  },
                },
                required: ['status', 'currentStep'],
              },
            },
            {
              name: 'incontrol_ask_human',
              description:
                'Request human input, approval, or a decision via the InControl Side Panel / Mobile App and wait for the user’s response.',
              inputSchema: {
                type: 'object',
                properties: {
                  question: {
                    type: 'string',
                    description: 'Clear question or confirmation prompt for the user.',
                  },
                  command: {
                    type: 'string',
                    description: 'Optional command or code snippet associated with the prompt.',
                  },
                  options: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional quick-choice buttons (e.g. ["Approve", "Deny"]).',
                  },
                },
                required: ['question'],
              },
            },
            {
              name: 'incontrol_check_inbox',
              description: 'Check if the user sent any remote instructions from the InControl panel or phone.',
              inputSchema: {
                type: 'object',
                properties: {},
              },
            },
          ],
        });
      }

      if (method === 'tools/call') {
        const toolName = params?.name;
        const argsObj = params?.arguments || {};

        if (toolName === 'incontrol_status') {
          const res = await fetch(`${hubUrl}/api/agents/event`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: agentId,
              name: agentName,
              provider,
              ide,
              workspace,
              status: argsObj.status || 'working',
              currentTask: argsObj.currentTask,
              currentStep: argsObj.currentStep,
              incrementTools: true,
              logType: 'tool',
              logMessage: argsObj.currentStep,
            }),
          });
          const data = await res.json();
          const inboxNote =
            data.queuedMessages?.length > 0
              ? `\nUser queued messages: ${JSON.stringify(data.queuedMessages)}`
              : '';
          return sendResponse(id, {
            content: [
              {
                type: 'text',
                text: `InControl status updated to '${argsObj.status}'.${inboxNote}`,
              },
            ],
          });
        }

        if (toolName === 'incontrol_ask_human') {
          const formattedOptions = Array.isArray(argsObj.options) && argsObj.options.length > 0
            ? argsObj.options.map((label, idx) => ({
                id: String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_') || `opt_${idx}`,
                label: String(label),
                style: idx === 0 ? 'primary' : 'secondary',
              }))
            : [
                { id: 'approve', label: 'Approve', style: 'primary' },
                { id: 'deny', label: 'Deny', style: 'danger' },
              ];

          const res = await fetch(`${hubUrl}/api/agents/ask`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: agentId,
              name: agentName,
              provider,
              ide,
              workspace,
              wait: true,
              question: argsObj.question,
              command: argsObj.command || null,
              options: formattedOptions,
              allowFreeText: true,
            }),
          });
          const decision = await res.json();
          return sendResponse(id, {
            content: [
              {
                type: 'text',
                text: `User responded from ${decision.sourceDevice || 'InControl'}: action="${decision.action}"${
                  decision.text ? `, reply="${decision.text}"` : ''
                }`,
              },
            ],
          });
        }

        if (toolName === 'incontrol_check_inbox') {
          const res = await fetch(`${hubUrl}/api/agents/${encodeURIComponent(agentId)}/messages`);
          const data = await res.json();
          return sendResponse(id, {
            content: [
              {
                type: 'text',
                text:
                  data.messages?.length > 0
                    ? `Messages from user: ${JSON.stringify(data.messages)}`
                    : 'No pending messages from user.',
              },
            ],
          });
        }

        return sendError(id, -32601, `Unknown tool: ${toolName}`);
      }

      if (id !== undefined) {
        return sendResponse(id, {});
      }
    } catch (err) {
      if (id !== undefined) {
        sendError(id, -32603, err.message || 'Internal MCP error');
      }
    }
  });
}

function getFlagValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) {
    return args[idx + 1];
  }
  return null;
}
