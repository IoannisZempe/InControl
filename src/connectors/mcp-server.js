import { hubHeaders } from './http.js';
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
          headers: hubHeaders(),
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
            {
              name: 'incontrol_list_context',
              description:
                'List available AI agent sessions, touched Git workspaces, handoff checkpoints, and archived daily collections across Antigravity, Codex, Claude Code, and Railway.',
              inputSchema: {
                type: 'object',
                properties: {
                  day: {
                    type: 'string',
                    description: 'Optional calendar day in YYYY-MM-DD format (defaults to today).',
                  },
                  project: {
                    type: 'string',
                    description: 'Optional project name filter.',
                  },
                  provider: {
                    type: 'string',
                    description: 'Optional agent provider filter (e.g. "antigravity", "codex", "claude").',
                  },
                },
              },
            },
            {
              name: 'incontrol_get_context',
              description:
                'Fetch the full portable context handoff brief (prompts, last summary, handoff checkpoints, commits today, modified files, artifacts) from another agent, IDE session, workspace, or archived day so this agent can continue seamlessly.',
              inputSchema: {
                type: 'object',
                properties: {
                  day: {
                    type: 'string',
                    description: 'Optional YYYY-MM-DD date (defaults to today; past dates load from Railway Postgres or local archive).',
                  },
                  project: {
                    type: 'string',
                    description: 'Optional project name filter (e.g. "InControl", "dialed", "GymW").',
                  },
                  workspace: {
                    type: 'string',
                    description: 'Optional absolute workspace path filter (defaults to matching all if omitted).',
                  },
                  provider: {
                    type: 'string',
                    description: 'Optional source provider filter ("antigravity", "codex", "claude").',
                  },
                  sessionId: {
                    type: 'string',
                    description: 'Optional specific session ID (from incontrol_list_context).',
                  },
                  agentId: {
                    type: 'string',
                    description: 'Optional InControl agent ID.',
                  },
                },
              },
            },
            {
              name: 'incontrol_save_handoff',
              description:
                'Save an explicit context handoff checkpoint (goal, summary, next steps) into InControl so another IDE or agent can pick up exactly where this agent left off.',
              inputSchema: {
                type: 'object',
                properties: {
                  goal: {
                    type: 'string',
                    description: 'Short description of the overall goal.',
                  },
                  summary: {
                    type: 'string',
                    description: 'What was accomplished, key decisions made, and important file/API context.',
                  },
                  nextSteps: {
                    type: 'string',
                    description: 'Recommended next steps for the receiving IDE or agent.',
                  },
                  project: {
                    type: 'string',
                    description: 'Optional project name (defaults to current workspace directory name).',
                  },
                },
                required: ['summary'],
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
            headers: hubHeaders(),
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
            headers: hubHeaders(),
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
          const res = await fetch(`${hubUrl}/api/agents/${encodeURIComponent(agentId)}/messages`, { headers: hubHeaders(false) });
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

        if (toolName === 'incontrol_list_context') {
          const q = new URLSearchParams();
          if (argsObj.day) q.set('day', String(argsObj.day));
          if (argsObj.project) q.set('project', String(argsObj.project));
          if (argsObj.provider) q.set('provider', String(argsObj.provider));

          const [exportRes, daysRes] = await Promise.all([
            fetch(`${hubUrl}/api/context/export?${q.toString()}`, { headers: hubHeaders(false) }),
            fetch(`${hubUrl}/api/context/days`, { headers: hubHeaders(false) }),
          ]);
          const exportData = await exportRes.json().catch(() => ({}));
          const daysData = await daysRes.json().catch(() => ({}));

          if (!exportRes.ok || !exportData.ok) {
            return sendResponse(id, {
              isError: true,
              content: [{ type: 'text', text: exportData.error || 'Failed to list InControl context.' }],
            });
          }

          const b = exportData.brief || {};
          const payload = {
            day: exportData.day,
            source: exportData.source,
            summary: exportData.summary,
            handoffs: (b.handoffs || []).map((h) => ({
              id: h.id,
              projectName: h.projectName,
              fromAgent: h.fromAgent,
              goal: h.goal,
              createdAt: h.createdAt,
            })),
            workspaces: (b.workspaces || []).map((w) => ({
              projectName: w.projectName,
              workspace: w.workspace,
              branch: w.branch,
              commitsToday: w.commitsToday?.length || 0,
              changedFiles: w.changedFiles?.length || 0,
            })),
            aiSessions: (b.aiSessions || []).map((s) => ({
              provider: s.provider,
              sessionId: s.sessionId,
              title: s.title,
              workspace: s.workspace,
              promptCount: s.userPrompts?.length || 0,
              hasSummary: Boolean(s.lastSummary),
              updatedAt: s.updatedAt,
            })),
            archivedDays: Array.from(
              new Set([
                ...(daysData.remoteDays || []).map((d) => `${d.day} (railway)`),
                ...(daysData.localDays || []).map((d) => `${d.day} (local)`),
              ])
            ),
          };
          return sendResponse(id, {
            content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          });
        }

        if (toolName === 'incontrol_get_context') {
          const q = new URLSearchParams();
          for (const key of ['day', 'project', 'workspace', 'provider', 'sessionId', 'agentId']) {
            if (argsObj[key]) q.set(key, String(argsObj[key]));
          }
          const res = await fetch(`${hubUrl}/api/context/export?${q.toString()}`, { headers: hubHeaders(false) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            return sendResponse(id, {
              isError: true,
              content: [{ type: 'text', text: data.error || 'No context found for the requested filters.' }],
            });
          }
          return sendResponse(id, {
            content: [{ type: 'text', text: data.markdown || JSON.stringify(data.brief, null, 2) }],
          });
        }

        if (toolName === 'incontrol_save_handoff') {
          const res = await fetch(`${hubUrl}/api/context/handoff`, {
            method: 'POST',
            headers: hubHeaders(),
            body: JSON.stringify({
              agentId,
              fromAgent: agentName,
              provider,
              workspace: argsObj.workspace || workspace,
              project: argsObj.project || path.basename(argsObj.workspace || workspace),
              goal: argsObj.goal || '',
              summary: argsObj.summary || '',
              nextSteps: argsObj.nextSteps || '',
            }),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok || !data.ok) {
            return sendResponse(id, {
              isError: true,
              content: [{ type: 'text', text: data.error || 'Failed to save handoff checkpoint.' }],
            });
          }
          return sendResponse(id, {
            content: [
              {
                type: 'text',
                text: `Saved InControl handoff checkpoint (${data.handoff.id}) for ${data.handoff.projectName || 'workspace'}. Any other IDE can now pull it via incontrol_get_context.`,
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
