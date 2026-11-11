import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInControlHub } from '../src/server/hub.js';

test('hub: register agent, blocking ask resolved by panel reply', async () => {
  const hub = await createInControlHub({ port: 4799, macNotifications: false, token: 't', autoWatch: false });
  const base = 'http://localhost:4799';
  try {
    let res = await fetch(`${base}/api/agents/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 't1', name: 'Test', status: 'working', currentStep: 'x' }),
    });
    assert.equal((await res.json()).agent.status, 'working');

    const askPromise = fetch(`${base}/api/agents/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 't1', question: 'OK?', wait: true }),
    }).then((r) => r.json());

    await new Promise((r) => setTimeout(r, 100));
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.counts.needs_input, 1);
    assert.equal(state.agents[0].pendingPrompt.question, 'OK?');

    await fetch(`${base}/api/agents/t1/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', text: 'go', sourceDevice: 'test' }),
    });
    const decision = await askPromise;
    assert.equal(decision.action, 'approve');
    assert.equal(decision.text, 'go');
  } finally {
    await hub.close();
  }
});

test('store: agents sorted by attention priority', async () => {
  const hub = await createInControlHub({ port: 4798, macNotifications: false, token: 't', autoWatch: false });
  try {
    hub.store.upsertAgent({ id: 'a1', name: 'IdleBot', status: 'idle' });
    hub.store.upsertAgent({ id: 'a2', name: 'WorkBot', status: 'working' });
    hub.store.upsertAgent({ id: 'a3', name: 'InputBot', status: 'needs_input' });
    hub.store.upsertAgent({ id: 'a4', name: 'ReviewBot', status: 'needs_attention' });
    const statuses = hub.store.getSortedAgents().map((a) => a.status);
    assert.deepEqual(statuses, ['needs_input', 'needs_attention', 'working', 'idle']);
  } finally {
    await hub.close();
  }
});

test('antigravity hook: PreInvocation injects queued panel message & Stop continues on follow-up', async () => {
  const { spawn } = await import('node:child_process');
  const runHook = (args, stdinObj) =>
    new Promise((resolve, reject) => {
      const child = spawn('node', ['./bin/incontrol.js', ...args], {
        env: { ...process.env, INCONTROL_URL: 'http://localhost:4797' },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('error', reject);
      child.on('close', () => resolve(JSON.parse(out.trim() || '{}')));
      child.stdin.end(JSON.stringify(stdinObj));
    });

  const hub = await createInControlHub({ port: 4797, macNotifications: false, token: 't', autoWatch: false });
  try {
    // 1. PreToolUse registers agent as working
    const preToolOut = await runHook(['hook', 'agy', 'PreToolUse'], {
      conversationId: 'abcd1234-5678',
      workspacePaths: ['/repos/demo-app'],
      lastUserInput: 'Build API',
      toolCall: { name: 'run_command', args: { CommandLine: 'npm test', toolSummary: 'Run unit tests' } },
    });
    assert.deepEqual(preToolOut, { decision: 'allow' });

    // 2. User sends a steering instruction from InControl panel
    await fetch('http://localhost:4797/api/agents/agy-abcd1234/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reply', text: 'Also add rate limiting', sourceDevice: 'iPhone' }),
    });

    // 3. Next PreInvocation receives the injected userMessage step
    const preInvOut = await runHook(['hook', 'agy', 'PreInvocation'], {
      conversationId: 'abcd1234-5678',
      workspacePaths: ['/repos/demo-app'],
      invocationNum: 2,
    });
    assert.equal(preInvOut.injectSteps.length, 1);
    assert.match(preInvOut.injectSteps[0].userMessage, /Also add rate limiting/);
  } finally {
    await hub.close();
  }
});

test('whatsapp: incoming webhook reply resolves waiting agent', async () => {
  const hub = await createInControlHub({ port: 4796, macNotifications: false, token: 't', autoWatch: false });
  const base = 'http://localhost:4796';
  try {
    const askPromise = fetch(`${base}/api/agents/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'wa-agent', name: 'Claude', question: 'Deploy to prod?', wait: true }),
    }).then((r) => r.json());

    await new Promise((r) => setTimeout(r, 80));

    // Simulate incoming Twilio WhatsApp reply "1" (Approve)
    const whRes = await fetch(`${base}/api/webhooks/whatsapp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'From=whatsapp%3A%2B15551234567&Body=1',
    });
    assert.equal(whRes.status, 200);

    const decision = await askPromise;
    assert.equal(decision.action, 'approve');
    assert.equal(decision.sourceDevice, 'WhatsApp');
  } finally {
    await hub.close();
  }
});

test('settings & custom functions: configure logo/theme and execute prompt function', async () => {
  const hub = await createInControlHub({ port: 0, localOnly: true, macNotifications: false, autoWatch: false });
  const port = hub.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    await fetch(`${baseUrl}/api/agents/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'fn-test-agent',
        name: 'Codex',
        provider: 'codex',
        workspace: process.cwd(),
        status: 'idle',
      }),
    });

    const getRes = await fetch(`${baseUrl}/api/settings`);
    const getBody = await getRes.json();
    assert.equal(getBody.ok, true);
    assert.ok(Array.isArray(getBody.settings.customFunctions));

    const runRes = await fetch(`${baseUrl}/api/agents/fn-test-agent/function`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ functionId: 'fn_tests' }),
    });
    const runBody = await runRes.json();
    assert.equal(runBody.ok, true);

    const msgsRes = await fetch(`${baseUrl}/api/agents/fn-test-agent/messages`);
    const msgsBody = await msgsRes.json();
    assert.equal(msgsBody.messages.length, 1);
    assert.match(msgsBody.messages[0].text, /test suite/i);

    // Security check: arbitrary shell command outside SAFE_WORKSPACE_COMMANDS allowlist is blocked
    await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customFunctions: [
          { id: 'fn_unsafe', label: 'Unsafe', icon: '⚡', type: 'shell', payload: 'node -e "process.exit(1)"' },
        ],
      }),
    });
    const blockedRes = await fetch(`${baseUrl}/api/agents/fn-test-agent/function`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ functionId: 'fn_unsafe' }),
    });
    assert.equal(blockedRes.status, 400);

    // Restore original settings
    await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getBody.settings),
    });

    // Verify tool & project icon endpoints
    const toolIconRes = await fetch(`${baseUrl}/api/icons/tool/claude`);
    assert.equal(toolIconRes.status, 200);
    assert.match(toolIconRes.headers.get('content-type') || '', /image\/(png|svg\+xml)/);

    const projIconRes = await fetch(`${baseUrl}/api/icons/project/fn-test-agent`);
    assert.equal(projIconRes.status, 200);
    assert.match(projIconRes.headers.get('content-type') || '', /image\/(png|svg\+xml)/);
  } finally {
    await hub.close();
  }
});
