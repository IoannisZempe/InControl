import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * Priority order for agent attention states:
 * 0: needs_input     (Red    - Blocking on human decision/input)
 * 1: needs_attention (Amber  - Finished, errored, or needs review)
 * 2: working         (Green  - Actively executing tools/tasks)
 * 3: idle            (Slate  - Connected and standing by)
 */
export const STATUS_PRIORITY = {
  needs_input: 0,
  needs_attention: 1,
  working: 2,
  idle: 3,
};

export class AgentStore extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, any>} */
    this.agents = new Map();
    /** @type {Map<string, { resolve: Function, timer: NodeJS.Timeout, agentId: string }>} */
    this.pendingWaiters = new Map();
    /** @type {Map<string, Function>} */
    this.stdinHandlers = new Map();
    /** @type {Array<any>} */
    this.globalEvents = [];
  }

  /**
   * Register or update an agent in the store.
   */
  upsertAgent(payload) {
    const now = Date.now();
    const id = payload.id || this._deriveId(payload);
    const existing = this.agents.get(id);

    const workspace = payload.workspace || existing?.workspace || process.cwd();
    const projectName = payload.projectName || existing?.projectName || path.basename(workspace) || 'workspace';

    const agent = {
      id,
      name: payload.name || existing?.name || 'AI Agent',
      provider: payload.provider || existing?.provider || 'custom',
      ide: payload.ide || existing?.ide || this._defaultIdeForProvider(payload.provider || existing?.provider),
      workspace,
      projectName,
      branch: payload.branch ?? existing?.branch ?? 'main',
      status: payload.status || existing?.status || 'idle',
      currentTask: payload.currentTask ?? existing?.currentTask ?? 'Ready for instructions',
      currentStep: payload.currentStep ?? existing?.currentStep ?? '',
      attentionReason: payload.attentionReason ?? existing?.attentionReason ?? null,
      pendingPrompt: payload.pendingPrompt !== undefined ? payload.pendingPrompt : (existing?.pendingPrompt || null),
      windowHint: payload.windowHint ?? existing?.windowHint ?? null,
      pid: payload.pid ?? existing?.pid ?? null,
      queuedMessages: existing?.queuedMessages || [],
      logs: existing?.logs || [],
      metrics: {
        toolsRun: (existing?.metrics?.toolsRun || 0) + (payload.incrementTools ? 1 : 0),
        promptsAnswered: existing?.metrics?.promptsAnswered || 0,
        startedAt: existing?.metrics?.startedAt || now,
        updatedAt: now,
      },
    };

    // Clear pendingPrompt if transitioning away from needs_input unless explicitly provided
    if (agent.status !== 'needs_input' && payload.pendingPrompt === undefined) {
      agent.pendingPrompt = null;
    }

    if (payload.logMessage) {
      this._appendLog(agent, {
        type: payload.logType || 'info',
        message: payload.logMessage,
        timestamp: now,
      });
    } else if (!existing) {
      this._appendLog(agent, {
        type: 'connect',
        message: `Connected ${agent.name} (${agent.ide}) in ${agent.projectName}`,
        timestamp: now,
      });
    }

    this.agents.set(id, agent);
    this.emit('change', { type: 'agent_updated', agent: this.serializeAgent(agent) });
    return agent;
  }

  /**
   * Put an agent into `needs_input` state and optionally wait for user response.
   */
  requestInput(agentId, promptPayload, waitTimeoutMs = 300_000) {
    const requestId = promptPayload.requestId || `req_${crypto.randomUUID().slice(0, 8)}`;
    const options = promptPayload.options || [
      { id: 'approve', label: 'Approve', style: 'primary' },
      { id: 'deny', label: 'Deny', style: 'danger' },
    ];

    const pendingPrompt = {
      requestId,
      question: promptPayload.question || 'Agent requires your confirmation to proceed.',
      toolName: promptPayload.toolName || null,
      command: promptPayload.command || null,
      details: promptPayload.details || null,
      options,
      allowFreeText: promptPayload.allowFreeText !== false,
      createdAt: Date.now(),
    };

    const agent = this.upsertAgent({
      ...(promptPayload.agentMeta || {}),
      id: agentId,
      status: 'needs_input',
      currentStep: promptPayload.toolName ? `Waiting on ${promptPayload.toolName}` : 'Waiting for your input',
      pendingPrompt,
      logType: 'prompt',
      logMessage: `Requested input: ${pendingPrompt.question}`,
    });

    this.emit('notification', {
      level: 'urgent',
      title: `${agent.name} (${agent.projectName}) needs input`,
      body: pendingPrompt.question,
      agentId: agent.id,
      requestId,
    });

    if (!promptPayload.wait) {
      return Promise.resolve({ queued: true, requestId });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWaiters.delete(requestId);
        resolve({
          requestId,
          action: 'timeout',
          text: null,
          timedOut: true,
        });
      }, waitTimeoutMs);

      this.pendingWaiters.set(requestId, {
        agentId: agent.id,
        resolve,
        timer,
      });
    });
  }

  /**
   * Resolve a pending prompt or send direct input to an agent from any device.
   */
  respondToAgent(agentId, responsePayload) {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { ok: false, error: `Agent '${agentId}' not found` };
    }

    const now = Date.now();
    const action = responsePayload.action || 'reply';
    const text = responsePayload.text ?? '';
    const requestId = responsePayload.requestId || agent.pendingPrompt?.requestId || null;
    const sourceDevice = responsePayload.sourceDevice || 'Panel';

    const answerSummary = text
      ? `${action === 'reply' ? '' : `[${action}] `}${text}`
      : `[${action.toUpperCase()}]`;

    agent.metrics.promptsAnswered += 1;
    agent.metrics.updatedAt = now;
    agent.pendingPrompt = null;

    if (action === 'deny' || action === 'reject') {
      agent.status = 'needs_attention';
      agent.currentStep = 'Action denied by user';
      agent.attentionReason = 'Tool/action rejected — awaiting next instruction';
    } else if (action === 'dismiss' || action === 'acknowledge') {
      agent.status = 'idle';
      agent.currentStep = 'Acknowledged by user';
      agent.attentionReason = null;
    } else {
      agent.status = 'working';
      agent.currentStep = text ? `Received reply: "${text.slice(0, 50)}"` : `Approved (${action})`;
      agent.attentionReason = null;
    }

    this._appendLog(agent, {
      type: 'user_reply',
      message: `You (${sourceDevice}): ${answerSummary}`,
      timestamp: now,
    });

    // 1. If a blocking HTTP/hook request is waiting, resolve it immediately
    if (requestId && this.pendingWaiters.has(requestId)) {
      const waiter = this.pendingWaiters.get(requestId);
      clearTimeout(waiter.timer);
      this.pendingWaiters.delete(requestId);
      waiter.resolve({
        ok: true,
        requestId,
        action,
        text,
        sourceDevice,
        timestamp: now,
      });
    } else {
      // Also check if any waiter belongs to this agentId
      for (const [reqId, waiter] of this.pendingWaiters.entries()) {
        if (waiter.agentId === agentId) {
          clearTimeout(waiter.timer);
          this.pendingWaiters.delete(reqId);
          waiter.resolve({
            ok: true,
            requestId: reqId,
            action,
            text,
            sourceDevice,
            timestamp: now,
          });
          break;
        }
      }
    }

    // 2. If a live stdin handler is registered (e.g. CLI wrapper or simulator), invoke it
    const stdinHandler = this.stdinHandlers.get(agentId);
    if (stdinHandler) {
      stdinHandler({ action, text, requestId, sourceDevice });
    } else {
      // Queue for polling/MCP agents
      agent.queuedMessages.push({
        id: `msg_${crypto.randomUUID().slice(0, 8)}`,
        action,
        text,
        requestId,
        sourceDevice,
        timestamp: now,
      });
    }

    this.emit('change', { type: 'agent_responded', agent: this.serializeAgent(agent) });
    return { ok: true, agent: this.serializeAgent(agent) };
  }

  /**
   * Register an in-process callback for when user sends input to a specific agent.
   */
  registerInputHandler(agentId, fn) {
    this.stdinHandlers.set(agentId, fn);
  }

  unregisterInputHandler(agentId) {
    this.stdinHandlers.delete(agentId);
  }

  /**
   * Pop queued messages for an agent (used by MCP or polling custom agents).
   */
  drainQueuedMessages(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent || !agent.queuedMessages.length) return [];
    const messages = [...agent.queuedMessages];
    agent.queuedMessages = [];
    return messages;
  }

  removeAgent(agentId) {
    const existed = this.agents.delete(agentId);
    this.stdinHandlers.delete(agentId);
    for (const [reqId, waiter] of this.pendingWaiters.entries()) {
      if (waiter.agentId === agentId) {
        clearTimeout(waiter.timer);
        this.pendingWaiters.delete(reqId);
      }
    }
    if (existed) {
      this.emit('change', { type: 'agent_removed', agentId });
    }
    return existed;
  }

  /**
   * Return all agents sorted by priority (Needs Input -> Needs Attention -> Working -> Idle).
   */
  getSortedAgents() {
    const list = Array.from(this.agents.values()).map((a) => this.serializeAgent(a));
    return list.sort((a, b) => {
      const pa = STATUS_PRIORITY[a.status] ?? 99;
      const pb = STATUS_PRIORITY[b.status] ?? 99;
      if (pa !== pb) return pa - pb;
      return (b.metrics?.updatedAt || 0) - (a.metrics?.updatedAt || 0);
    });
  }

  getSummaryCounts() {
    const counts = {
      total: this.agents.size,
      needs_input: 0,
      needs_attention: 0,
      working: 0,
      idle: 0,
    };
    for (const agent of this.agents.values()) {
      if (counts[agent.status] !== undefined) {
        counts[agent.status] += 1;
      }
    }
    return counts;
  }

  serializeAgent(agent) {
    return {
      ...agent,
      priority: STATUS_PRIORITY[agent.status] ?? 99,
    };
  }

  _appendLog(agent, entry) {
    agent.logs.unshift(entry);
    if (agent.logs.length > 35) {
      agent.logs.length = 35;
    }
    this.globalEvents.unshift({
      agentId: agent.id,
      agentName: agent.name,
      projectName: agent.projectName,
      ...entry,
    });
    if (this.globalEvents.length > 60) {
      this.globalEvents.length = 60;
    }
  }

  _deriveId(payload) {
    const raw = `${payload.provider || 'agent'}-${payload.name || 'default'}-${payload.workspace || process.cwd()}`;
    return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  }

  _defaultIdeForProvider(provider) {
    switch (provider) {
      case 'claude-code':
        return 'Terminal / Claude';
      case 'antigravity':
        return 'Antigravity';
      case 'cursor':
        return 'Cursor';
      case 'vscode':
        return 'VS Code';
      case 'windsurf':
        return 'Windsurf';
      case 'codex':
      case 'aider':
      case 'opencode':
        return 'Terminal';
      default:
        return 'Custom Runtime';
    }
  }
}
