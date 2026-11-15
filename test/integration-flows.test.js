/**
 * Integration Flow Tests — end-to-end multi-step flows exercising the real InControl Hub,
 * HTTP + WebSocket APIs, spawned CLI hook subprocesses (`bin/incontrol.js hook ...`),
 * and `public/app.js` panel client interaction guards.
 *
 * Each flow documents HOW the pieces connect and WHY each step is asserted.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createInControlHub } from '../src/server/hub.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(ROOT, 'bin', 'incontrol.js');

let flowHome;
let prevIncontrolHome;

before(() => {
  prevIncontrolHome = process.env.INCONTROL_HOME;
  flowHome = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-int-flows-'));
  process.env.INCONTROL_HOME = flowHome;
});

after(() => {
  if (prevIncontrolHome === undefined) delete process.env.INCONTROL_HOME;
  else process.env.INCONTROL_HOME = prevIncontrolHome;
  if (flowHome) fs.rmSync(flowHome, { recursive: true, force: true });
});

function runCliHook(args, stdinObj, envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, 'hook', ...args], {
      cwd: ROOT,
      env: { ...process.env, ...envOverrides },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      let json = null;
      try {
        if (stdout.trim()) json = JSON.parse(stdout.trim());
      } catch {}
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.write(typeof stdinObj === 'string' ? stdinObj : JSON.stringify(stdinObj));
    child.stdin.end();
  });
}

test('flow: Antigravity Security Check + Steer + Stop end-to-end hook pipeline', async () => {
  const hub = await createInControlHub({
    port: 4821,
    macNotifications: false,
    token: 'flow-token-1',
    autoWatch: false,
  });
  const base = 'http://127.0.0.1:4821';
  const ws = new WebSocket('ws://127.0.0.1:4821/ws');
  const wsEvents = [];

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (buf) => {
    try {
      wsEvents.push(JSON.parse(buf.toString()));
    } catch {}
  });

  const hookEnv = { INCONTROL_URL: base };
  const convId = 'flowconv-1111-2222-3333';

  try {
    // STEP 1: Antigravity begins a turn via PreInvocation hook -> registers agent as working
    const startRes = await runCliHook(
      ['agy', 'PreInvocation'],
      { conversationId: convId, workspacePaths: [ROOT], invocationNum: 1, lastUserInput: 'Fix auth bug' },
      hookEnv
    );
    assert.equal(startRes.code, 0);
    assert.deepEqual(startRes.json, {}, 'Initial PreInvocation with no queue returns {}');

    const stateAfterStart = await (await fetch(`${base}/api/state`)).json();
    const agent = stateAfterStart.agents.find((a) => a.id === 'agy-flowconv');
    assert.ok(agent, 'Hub must register agy-flowconv from PreInvocation');
    assert.equal(agent.status, 'working');

    // STEP 2: User clicks "Security Check" custom button + sends a "Steer agent" instruction
    const fnRes = await (
      await fetch(`${base}/api/agents/agy-flowconv/function`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ functionId: 'fn_security' }),
      })
    ).json();
    assert.equal(fnRes.ok, true);
    assert.equal(fnRes.type, 'prompt');

    const steerRes = await (
      await fetch(`${base}/api/agents/agy-flowconv/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'reply',
          text: 'Also verify SSRF protection in webhook settings',
          sourceDevice: 'Mac Panel',
        }),
      })
    ).json();
    assert.equal(steerRes.ok, true);

    // STEP 3: Antigravity runs intermediate tools (PreToolUse + PostToolUse error)
    // WHY: Tool telemetry hooks send drain:false so they MUST NOT wipe the 2 queued prompts
    const preTool = await runCliHook(
      ['agy', 'PreToolUse'],
      {
        conversationId: convId,
        workspacePaths: [ROOT],
        toolCall: { name: 'default_api:run_command', args: { CommandLine: 'npm test', toolSummary: 'Run tests' } },
      },
      hookEnv
    );
    assert.deepEqual(preTool.json, { decision: 'allow' });

    await runCliHook(
      ['agy', 'PostToolUse'],
      {
        conversationId: convId,
        workspacePaths: [ROOT],
        toolCall: { name: 'default_api:run_command' },
        error: 'Exit code 1',
      },
      hookEnv
    );

    const stateMidTurn = await (await fetch(`${base}/api/state`)).json();
    assert.equal(
      stateMidTurn.agents.find((a) => a.id === 'agy-flowconv').queuedMessages.length,
      2,
      'PreToolUse & PostToolUse must preserve both queued prompts'
    );

    // STEP 4: Next model invocation triggers PreInvocation -> injects BOTH prompts in order
    const nextInvoke = await runCliHook(
      ['agy', 'PreInvocation'],
      { conversationId: convId, workspacePaths: [ROOT], invocationNum: 2 },
      hookEnv
    );
    assert.ok(Array.isArray(nextInvoke.json?.injectSteps), 'PreInvocation must inject queued messages');
    const injected = nextInvoke.json.injectSteps[0].userMessage;
    assert.match(injected, /Function · Security Check/);
    assert.match(injected, /Audit recent changes for security risks/);
    assert.match(injected, /Also verify SSRF protection in webhook settings/);

    // STEP 5: Turn ends via Stop with empty queue -> becomes needs_attention, then Dismiss -> idle
    const stopIdle = await runCliHook(
      ['agy', 'Stop'],
      { conversationId: convId, workspacePaths: [ROOT], terminationReason: 'NO_TOOL_CALL' },
      hookEnv
    );
    assert.deepEqual(stopIdle.json, { decision: 'allow' });

    const stateReview = await (await fetch(`${base}/api/state`)).json();
    assert.equal(stateReview.agents.find((a) => a.id === 'agy-flowconv').status, 'needs_attention');

    await fetch(`${base}/api/agents/agy-flowconv/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', sourceDevice: 'Mac Panel' }),
    });
    const stateDismissed = await (await fetch(`${base}/api/state`)).json();
    assert.equal(stateDismissed.agents.find((a) => a.id === 'agy-flowconv').status, 'idle');

    // STEP 6: Follow-up Security Check sent right as Stop fires -> Stop tells AGY to continue!
    await fetch(`${base}/api/agents/agy-flowconv/function`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ functionId: 'fn_security' }),
    });
    const stopContinue = await runCliHook(
      ['agy', 'Stop'],
      { conversationId: convId, workspacePaths: [ROOT], terminationReason: 'NO_TOOL_CALL' },
      hookEnv
    );
    assert.equal(stopContinue.json.decision, 'continue');
    assert.match(stopContinue.json.reason, /Audit recent changes for security risks/);

    // STEP 7: Clicking Stop in panel terminates next PreInvocation loop cleanly
    await fetch(`${base}/api/agents/agy-flowconv/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop', sourceDevice: 'Mac Panel' }),
    });
    const terminateRes = await runCliHook(
      ['agy', 'PreInvocation'],
      { conversationId: convId, workspacePaths: [ROOT], invocationNum: 3 },
      hookEnv
    );
    assert.equal(terminateRes.json.terminationBehavior, 'terminate');

    assert.ok(
      wsEvents.some((ev) => ev.type === 'state_sync' || ev.type === 'agent_updated'),
      'Connected side panel WebSocket must receive live updates throughout the flow'
    );
  } finally {
    ws.close();
    await hub.close();
  }
});

test('flow: Remote command gating blocks PreToolUse until panel approves or denies', async () => {
  const hub = await createInControlHub({
    port: 4822,
    macNotifications: false,
    token: 'flow-token-2',
    autoWatch: false,
  });
  const base = 'http://127.0.0.1:4822';
  const hookEnv = { INCONTROL_URL: base };

  try {
    // FLOW 2A: Antigravity gated run_command denied remotely from panel
    const agyPending = runCliHook(
      ['agy', 'PreToolUse', '--gate'],
      {
        conversationId: 'gateconv-9999',
        workspacePaths: [ROOT],
        toolCall: {
          name: 'default_api:run_command',
          args: { CommandLine: 'rm -rf ./dist', toolSummary: 'Clean dist' },
        },
      },
      hookEnv
    );

    // Poll briefly until hub enters needs_input
    let waitingAgent = null;
    for (let i = 0; i < 30; i += 1) {
      const st = await (await fetch(`${base}/api/state`)).json();
      waitingAgent = st.agents.find((a) => a.id === 'agy-gateconv' && a.status === 'needs_input');
      if (waitingAgent) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(waitingAgent, 'Gated PreToolUse must place agy-gateconv in needs_input');
    assert.equal(waitingAgent.pendingPrompt.command, 'rm -rf ./dist');

    await fetch(`${base}/api/agents/agy-gateconv/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deny', text: 'Keep dist build', sourceDevice: 'iPhone' }),
    });

    const agyDecision = await agyPending;
    assert.equal(agyDecision.code, 0);
    assert.equal(agyDecision.json.decision, 'deny');
    assert.match(agyDecision.json.reason, /Denied via InControl \(iPhone\): Keep dist build/);

    // FLOW 2B: Claude Code gated Bash hook denied -> exit code 2 + stderr reason
    const claudePending = runCliHook(
      ['claude', 'PreToolUse', '--gate'],
      {
        hook_event_name: 'PreToolUse',
        session_id: 'claudegate01',
        cwd: ROOT,
        tool_name: 'Bash',
        tool_input: { command: 'git push --force' },
      },
      hookEnv
    );

    let claudeWaiting = null;
    for (let i = 0; i < 30; i += 1) {
      const st = await (await fetch(`${base}/api/state`)).json();
      claudeWaiting = st.agents.find((a) => a.id === 'claude-claudegate01' && a.status === 'needs_input');
      if (claudeWaiting) break;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(claudeWaiting, 'Gated Claude Bash hook must enter needs_input');

    await fetch(`${base}/api/agents/claude-claudegate01/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'deny', text: 'Never force push', sourceDevice: 'Mac Panel' }),
    });

    const claudeResult = await claudePending;
    assert.equal(claudeResult.code, 2, 'Claude Code PreToolUse block contract requires exit code 2');
    assert.match(claudeResult.stderr, /Blocked via InControl panel: Never force push/);
  } finally {
    await hub.close();
  }
});

test('flow: Panel client (public/app.js) protects clicks/typing during WS updates and shows honest delivery toasts', async () => {
  // WHY: Real WebSocket state_sync ticks arrive while users click Security Check or type in
  // Steer agent. This executes real public/app.js in a lightweight DOM VM to verify:
  //   (1) pointerdown in #agent-list defers innerHTML wipes until after pointerup,
  //   (2) typing in [data-reply-for] preserves drafts and defers destructive re-renders,
  //   (3) Security Check & Steer toasts display server delivery warnings instead of fake success.
  const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

  const docListeners = new Map();
  const toasts = [];
  const fetchCalls = [];
  let wsInstance = null;
  let activeElement = null;

  function makeClassList(initial = []) {
    const set = new Set(initial);
    return {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      toggle: (c, force) => (force === undefined ? (set.has(c) ? (set.delete(c), false) : (set.add(c), true)) : (force ? set.add(c) : set.delete(c), Boolean(force))),
      contains: (c) => set.has(c),
    };
  }

  function makeEl(id = '') {
    let _html = '';
    const el = {
      id,
      value: '',
      checked: false,
      href: '',
      textContent: '',
      selectionStart: 0,
      dataset: {},
      style: { setProperty() {} },
      classList: makeClassList(),
      renderWrites: 0,
      listeners: new Map(),
      addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(fn);
      },
      focus() {
        activeElement = this;
      },
      setSelectionRange(s) {
        this.selectionStart = s;
      },
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      appendChild() {},
      remove() {},
      closest() {
        return null;
      },
    };
    Object.defineProperty(el, 'innerHTML', {
      get: () => _html,
      set: (val) => {
        _html = String(val);
        el.renderWrites += 1;
      },
    });
    return el;
  }

  const els = new Map();
  const getEl = (sel) => {
    if (!els.has(sel)) els.set(sel, makeEl(sel));
    return els.get(sel);
  };
  const agentListEl = getEl('#agent-list');

  // Wire a realistic querySelector for restoring focused draft input after deferred flush
  const replyInputEl = makeEl('reply-input');
  replyInputEl.dataset = { replyFor: 'agy-1' };
  replyInputEl.closest = (s) => (s === '#agent-list' ? agentListEl : null);
  agentListEl.querySelector = (q) => (q.includes('data-reply-for') ? replyInputEl : null);

  const timers = [];
  const fakeWindow = {
    addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    location: { origin: 'http://127.0.0.1:4790', host: '127.0.0.1:4790', protocol: 'http:', search: '' },
  };

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      wsInstance = this;
    }
    send() {}
    close() {
      this.readyState = 3;
    }
  }
  FakeWebSocket.OPEN = 1;

  const sandbox = {
    window: fakeWindow,
    document: {
      documentElement: { dataset: {}, setAttribute() {}, style: { setProperty() {} } },
      body: {
        dataset: {},
        appendChild(node) {
          if (node.className === 'toast') toasts.push(node.textContent);
        },
      },
      get activeElement() {
        return activeElement;
      },
      querySelector: getEl,
      querySelectorAll: () => [],
      createElement: () => makeEl(),
      addEventListener(type, fn) {
        if (!docListeners.has(type)) docListeners.set(type, []);
        docListeners.get(type).push(fn);
      },
    },
    localStorage: {
      _map: new Map(),
      getItem(k) {
        return this._map.get(k) ?? null;
      },
      setItem(k, v) {
        this._map.set(k, String(v));
      },
    },
    navigator: { userAgent: 'InControlPanel/1.0 Macintosh' },
    location: fakeWindow.location,
    WebSocket: FakeWebSocket,
    CSS: { escape: (s) => s },
    URLSearchParams,
    setTimeout: (fn, ms) => {
      const id = timers.length + 1;
      timers.push({ id, fn, ms, cleared: false });
      return id;
    },
    clearTimeout: (id) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async (url, opts) => {
      fetchCalls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.endsWith('/function')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            type: 'prompt',
            delivered: false,
            warning: 'Queued, but Antigravity two-way hooks are not installed yet — click "+ Connect".',
            message: 'Queued, but Antigravity two-way hooks are not installed yet — click "+ Connect".',
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          ok: true,
          delivery: { ready: true, mode: 'plugin', idleNote: 'Queued for next Antigravity turn.' },
        }),
      };
    },
    Date,
    Math,
    JSON,
    console,
  };

  vm.runInNewContext(appSource, sandbox, { filename: 'public/app.js' });

  const dispatchDoc = async (type, eventObj) => {
    for (const fn of docListeners.get(type) || []) {
      await fn(eventObj);
    }
  };

  const sampleState = {
    agents: [
      {
        id: 'agy-1',
        name: 'Antigravity',
        provider: 'antigravity',
        projectName: 'InControl',
        branch: 'main',
        status: 'working',
        currentTask: 'Build tests',
        currentStep: 'Editing files',
        queuedCount: 0,
        logs: [],
        metrics: { updatedAt: Date.now() },
      },
    ],
    counts: { total: 1, needs_input: 0, needs_attention: 0, working: 1, idle: 0 },
    settings: {
      showFunctionBar: true,
      customFunctions: [
        { id: 'fn_security', label: 'Security Check', icon: 'agent', type: 'prompt', payload: 'Audit risks' },
      ],
    },
    integrations: [],
    globalEvents: [],
    network: {},
  };

  // Initial WS state_sync renders the working card cleanly WITH custom functions (Security Check) visible
  wsInstance.onmessage({ data: JSON.stringify({ type: 'state_sync', state: sampleState }) });
  assert.equal(agentListEl.renderWrites, 1);
  assert.ok(
    agentListEl.innerHTML.includes('data-fn="fn_security"'),
    'Active (working) cards must render pinned function bar (Security Check) without needing manual expand'
  );

  // 1) Simulate pointerdown inside #agent-list, THEN incoming WS state_sync mid-click
  const secBtn = {
    dataset: { act: 'run-function', agent: 'agy-1', fn: 'fn_security' },
    classList: makeClassList(),
    closest: (sel) => {
      if (sel === '#agent-list') return agentListEl;
      if (sel.includes('[data-act]')) return secBtn;
      if (sel.includes('[data-card-id]')) return { dataset: { cardId: 'agy-1' } };
      return null;
    },
  };
  await dispatchDoc('pointerdown', { target: secBtn });

  const rendersBeforeWs = agentListEl.renderWrites;
  wsInstance.onmessage({ data: JSON.stringify({ type: 'state_sync', state: sampleState }) });
  assert.equal(
    agentListEl.renderWrites,
    rendersBeforeWs,
    'renderAgents() MUST defer while pointer is pressed in #agent-list so click is not dropped'
  );

  // Click fires on the surviving DOM button, triggering Security Check with honest warning toast
  await dispatchDoc('click', { target: secBtn });
  assert.equal(fetchCalls[0].url, '/api/agents/agy-1/function');
  assert.match(toasts[0], /Antigravity two-way hooks are not installed yet/);

  // Releasing pointer flushes the deferred render after its short settle timer
  await dispatchDoc('pointerup', { target: secBtn });
  for (const t of timers.filter((x) => !x.cleared)) {
    t.cleared = true;
    t.fn();
  }
  assert.equal(agentListEl.renderWrites, rendersBeforeWs + 1, 'Deferred render flushes after pointerup');

  // 2) Simulate active typing in Steer input -> WS state_sync must defer & preserve draft
  activeElement = replyInputEl;
  replyInputEl.value = 'Focus on auth';
  await dispatchDoc('input', { target: replyInputEl });

  const rendersWhileTyping = agentListEl.renderWrites;
  wsInstance.onmessage({ data: JSON.stringify({ type: 'state_sync', state: sampleState }) });
  assert.equal(
    agentListEl.renderWrites,
    rendersWhileTyping,
    'renderAgents() MUST defer right after typing so keystrokes are not wiped'
  );

  // Submit Steer reply -> receives delivery.idleNote and displays honest delivery status
  await sandbox.respond('agy-1', 'reply', 'Focus on auth');
  assert.equal(fetchCalls[1].url, '/api/agents/agy-1/respond');
  assert.equal(toasts[1], 'Queued for next Antigravity turn.');
});

test('flow: MCP incontrol_ask_human correlates with active agy card and panel reply wakes it live without IDE focus', async () => {
  const hub = await createInControlHub({
    port: 4823,
    macNotifications: false,
    token: 'flow-mcp-tok',
    autoWatch: false,
  });
  const base = 'http://127.0.0.1:4823';

  // Register an Antigravity card (as hooks/auto-watcher do)
  await fetch(`${base}/api/agents/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'agy-live9999',
      name: 'Antigravity',
      provider: 'antigravity',
      ide: 'Antigravity',
      workspace: ROOT,
      status: 'working',
      currentTask: 'Deploy check',
      currentStep: 'Waiting before push',
    }),
  });

  // Launch MCP server using a generic cwd (as GUI plugin hosts often do)
  const mcpChild = spawn(process.execPath, [BIN_PATH, 'mcp'], {
    cwd: os.homedir(),
    env: {
      ...process.env,
      INCONTROL_URL: base,
      INCONTROL_DISABLE_HOME_SCAN: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const rl = readline.createInterface({ input: mcpChild.stdout });
  const pendingRpc = new Map();
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pendingRpc.has(msg.id)) {
        pendingRpc.get(msg.id)(msg);
        pendingRpc.delete(msg.id);
      }
    } catch {}
  });

  let rpcId = 1;
  const callRpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = rpcId++;
      const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 5000);
      pendingRpc.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      mcpChild.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    await callRpc('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
    // Should NOT spawn a duplicate "Connected via MCP" idle card
    const stateAfterInit = await (await fetch(`${base}/api/state`)).json();
    assert.equal(stateAfterInit.agents.length, 1, 'Antigravity MCP init from home/generic cwd must not duplicate card');

    // Call incontrol_ask_human -> blocks until user replies in panel on agy-live9999
    const askRpcPromise = callRpc('tools/call', {
      name: 'incontrol_ask_human',
      arguments: {
        question: 'Ready to push 3e91f4e to origin/main?',
        options: ['Commit & Push', 'Wait'],
      },
    });

    let waiting = null;
    for (let i = 0; i < 30; i += 1) {
      const st = await (await fetch(`${base}/api/state`)).json();
      waiting = st.agents.find((a) => a.id === 'agy-live9999' && a.status === 'needs_input');
      if (waiting) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(waiting, 'incontrol_ask_human must promote existing agy-live9999 card into needs_input');
    assert.match(waiting.pendingPrompt.question, /Ready to push/);

    const respondRes = await (
      await fetch(`${base}/api/agents/agy-live9999/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reply', text: 'Push to main now', sourceDevice: 'Mac Panel' }),
      })
    ).json();
    assert.equal(respondRes.deliveredLive, true, 'Live MCP waiter reply must report deliveredLive:true');
    assert.equal(respondRes.requiresWake, false);
    assert.equal(respondRes.agent.status, 'working');
    assert.equal(respondRes.agent.queuedMessages.length, 0, 'Consumed waiter reply must not remain duplicated in queue');

    const askResult = await askRpcPromise;
    assert.match(askResult.result.content[0].text, /reply="Push to main now"/);
  } finally {
    rl.close();
    mcpChild.kill();
    await hub.close();
  }
});
