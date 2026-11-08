/**
 * Interactive Multi-Agent Simulator for InControl.
 * Spawns realistic agents across Claude Code, Antigravity, Cursor, Codex CLI, and Custom SDK
 * that respond dynamically when the user approves, denies, or replies from the side panel or phone.
 */
export class AgentSimulator {
  constructor(store) {
    this.store = store;
    this.active = false;
    this.interval = null;
    this.simIds = [
      'sim-claude-payments',
      'sim-agy-incontrol',
      'sim-cursor-mobile',
      'sim-codex-infra',
      'sim-custom-eval',
    ];
  }

  start() {
    if (this.active) return;
    this.active = true;

    // 1. Claude Code — Blocked waiting on Bash tool permission (P0: needs_input)
    this.store.upsertAgent({
      id: 'sim-claude-payments',
      name: 'Claude Code',
      provider: 'claude-code',
      ide: 'iTerm2',
      workspace: '/Users/dev/repos/payments-service',
      projectName: 'payments-service',
      branch: 'fix/stripe-webhook-idempotency',
      status: 'needs_input',
      currentTask: 'Fix Stripe webhook retry race condition & run migration',
      currentStep: 'Waiting on Bash permission',
      isSimulated: true,
      pendingPrompt: {
        requestId: 'req_claude_01',
        question: 'Allow Claude Code to run database migration against local Postgres?',
        toolName: 'Bash',
        command: 'npx prisma migrate dev --name add_webhook_event_lock && npm test',
        options: [
          { id: 'approve', label: 'Approve & Run', style: 'primary' },
          { id: 'approve_dry', label: 'Dry-Run Only', style: 'secondary' },
          { id: 'deny', label: 'Deny', style: 'danger' },
        ],
        allowFreeText: true,
        createdAt: Date.now() - 42_000,
      },
      logType: 'prompt',
      logMessage: 'PreToolUse hook paused: awaiting confirmation for prisma migrate',
    });

    // 2. Cursor Agent — Blocked asking an architectural question (P0: needs_input)
    this.store.upsertAgent({
      id: 'sim-cursor-mobile',
      name: 'Cursor Agent',
      provider: 'cursor',
      ide: 'Cursor',
      workspace: '/Users/dev/repos/ios-companion',
      projectName: 'ios-companion',
      branch: 'feat/offline-sync',
      status: 'needs_input',
      currentTask: 'Implement offline queue sync for mobile client',
      currentStep: 'Clarifying conflict resolution strategy',
      isSimulated: true,
      pendingPrompt: {
        requestId: 'req_cursor_02',
        question: 'How should we resolve offline state conflicts when reconnecting?',
        toolName: 'incontrol_ask_human',
        details: 'Found 2 conflicting mutations in SyncEngine.swift (lines 114-148).',
        options: [
          { id: 'server_wins', label: 'Server Timestamp Wins', style: 'primary' },
          { id: 'client_merge', label: 'Field-Level CRDT Merge', style: 'secondary' },
          { id: 'prompt_user', label: 'Show Diff Sheet', style: 'secondary' },
        ],
        allowFreeText: true,
        createdAt: Date.now() - 18_000,
      },
      logType: 'prompt',
      logMessage: 'Asked human via MCP: conflict resolution strategy',
    });

    // 3. Codex CLI — Needs attention: finished task & test summary ready (P1: needs_attention)
    this.store.upsertAgent({
      id: 'sim-codex-infra',
      name: 'Codex CLI',
      provider: 'codex',
      ide: 'Ghostty',
      workspace: '/Users/dev/repos/cloud-infra',
      projectName: 'cloud-infra',
      branch: 'chore/redis-cluster-tls',
      status: 'needs_attention',
      currentTask: 'Upgrade Redis cluster Terraform module to enforce TLS 1.3',
      currentStep: 'Finished — 4 files modified, terraform plan ready for review',
      attentionReason: 'Task completed (0 errors, +68 / -19 lines). Ready for your review.',
      isSimulated: true,
      logType: 'success',
      logMessage: 'Completed terraform validate & plan. Waiting for human review.',
    });

    // 4. Antigravity — Actively working (P2: working)
    this.store.upsertAgent({
      id: 'sim-agy-incontrol',
      name: 'Antigravity',
      provider: 'antigravity',
      ide: 'Antigravity',
      workspace: '/Users/dev/repos/InControl',
      projectName: 'InControl',
      branch: 'main',
      status: 'working',
      currentTask: 'Build cross-device WebSocket mission control & macOS native side panel',
      currentStep: 'Editing src/server/hub.js — wiring real-time state sync',
      isSimulated: true,
      incrementTools: true,
      logType: 'tool',
      logMessage: 'Running tool: write_file (src/server/hub.js)',
    });

    // 5. Custom Python Agent — Standing by / Idle (P3: idle)
    this.store.upsertAgent({
      id: 'sim-custom-eval',
      name: 'EvalRunner Bot',
      provider: 'custom',
      ide: 'Python SDK',
      workspace: '/Users/dev/repos/llm-eval-suite',
      projectName: 'llm-eval-suite',
      branch: 'main',
      status: 'idle',
      currentTask: 'Benchmarking latency & accuracy on 150 SWE-bench tasks',
      currentStep: 'Idle — Last run scored 78.4% (awaiting next trigger)',
      isSimulated: true,
      logType: 'info',
      logMessage: 'Connected via InControl Python SDK v0.1',
    });

    // Register interactive handlers so when the user clicks Approve/Reply, the simulated agent reacts!
    for (const id of this.simIds) {
      this.store.registerInputHandler(id, ({ action, text, sourceDevice }) => {
        this._handleSimulatedReply(id, action, text, sourceDevice);
      });
    }

    // Periodic realistic activity ticker for working simulated agents
    const workingSteps = [
      'Running test suite: npm test (18/18 passing)',
      'Inspecting AST in src/connectors/mcp-server.js',
      'Verifying WebSocket reconnection backoff on mobile Safari',
      'Compiling macOS floating NSPanel binary via swiftc',
      'Checking git diff --stat across workspace',
    ];
    let tick = 0;

    this.interval = setInterval(() => {
      if (!this.active) return;
      tick += 1;
      const agy = this.store.agents.get('sim-agy-incontrol');
      if (agy && agy.status === 'working') {
        const step = workingSteps[tick % workingSteps.length];
        this.store.upsertAgent({
          id: 'sim-agy-incontrol',
          status: 'working',
          currentStep: step,
          incrementTools: true,
          logType: 'tool',
          logMessage: step,
        });
      }
    }, 6000);
  }

  _handleSimulatedReply(agentId, action, text, sourceDevice) {
    const agent = this.store.agents.get(agentId);
    if (!agent || !this.active) return;

    if (action === 'deny' || action === 'reject') {
      return;
    }

    // Simulate the agent doing work after receiving your input, then following up
    setTimeout(() => {
      if (!this.active || !this.store.agents.has(agentId)) return;
      const customNote = text ? `with instruction "${text}"` : `(${action})`;
      this.store.upsertAgent({
        id: agentId,
        status: 'working',
        currentStep: `Executing step ${customNote}...`,
        incrementTools: true,
        logType: 'tool',
        logMessage: `Resumed execution after ${sourceDevice} approval ${customNote}`,
      });

      setTimeout(() => {
        if (!this.active || !this.store.agents.has(agentId)) return;
        this.store.upsertAgent({
          id: agentId,
          status: 'needs_attention',
          currentStep: 'Step completed — all unit & integration tests passed',
          attentionReason: `Finished executing ${customNote}. Ready for your final sign-off.`,
          incrementTools: true,
          logType: 'success',
          logMessage: 'All checks passed (12/12 specs green). Marked as Needs Attention.',
        });
      }, 4500);
    }, 800);
  }

  stop() {
    this.active = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    for (const id of this.simIds) {
      this.store.removeAgent(id);
    }
  }
}
