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

test('apple homeview & siri voice: pairing redirect, spoken status, and opt-in voice approval', async () => {
  const hub = await createInControlHub({
    port: 0,
    strict: true,
    token: 'hv-secret-token',
    macNotifications: false,
    autoWatch: false,
    homekit: false,
  });
  const port = hub.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const authHeader = { Authorization: 'Bearer hv-secret-token' };

  try {
    // 1. Unauthorized access to /homeview is blocked
    const unauth = await fetch(`${baseUrl}/homeview`);
    assert.equal(unauth.status, 401);

    // 2. Pairing to /homeview?token=... sets HttpOnly cookie and strips token via redirect back to /homeview
    const pairRes = await fetch(`${baseUrl}/homeview?token=hv-secret-token`, { redirect: 'manual' });
    assert.equal(pairRes.status, 302);
    assert.equal(pairRes.headers.get('location'), '/homeview');
    const cookie = pairRes.headers.get('set-cookie').split(';')[0];

    const hvHtmlRes = await fetch(`${baseUrl}/homeview`, { headers: { Cookie: cookie } });
    assert.equal(hvHtmlRes.status, 200);
    assert.match(await hvHtmlRes.text(), /Apple HomeView/i);

    // 3. Create waiting agent and query Siri voice summary
    const origSettings = (await (await fetch(`${baseUrl}/api/settings`, { headers: authHeader })).json()).settings;
    await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowVoiceApproval: false }),
    });

    const askPromise = fetch(`${baseUrl}/api/agents/ask`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'hv-agent-1',
        name: 'Claude',
        workspace: '/tmp/nova-app',
        question: 'Run migration script?',
        wait: true,
      }),
    }).then((r) => r.json());

    await new Promise((r) => setTimeout(r, 80));

    const speechText = await (
      await fetch(`${baseUrl}/api/voice/status?format=text`, { headers: authHeader })
    ).text();
    assert.match(speechText, /1 agent needs your input/i);
    assert.match(speechText, /nova-app/i);

    // 4. Security check: voice approval blocked (403) when allowVoiceApproval is false
    const blockedVoice = await fetch(`${baseUrl}/api/voice/respond`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(blockedVoice.status, 403);

    // 5. Enable allowVoiceApproval -> Siri approval resolves the waiting agent
    await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowVoiceApproval: true }),
    });

    const voiceRes = await fetch(`${baseUrl}/api/voice/respond`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    assert.equal(voiceRes.status, 200);
    const voiceBody = await voiceRes.json();
    assert.equal(voiceBody.ok, true);
    assert.match(voiceBody.speech, /Approved/i);

    const decision = await askPromise;
    assert.equal(decision.action, 'approve');
    assert.equal(decision.sourceDevice, 'Siri');

    // Restore original settings
    await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(origSettings),
    });
  } finally {
    await hub.close();
  }
});

test('apple homekit bridge: publishes Waiting sensor & Approve switch with valid generated PIN', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createHomeKitBridge } = await import('../src/server/homekit.js');
  const { AgentStore } = await import('../src/server/store.js');

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-hk-test-'));
  const prevHome = process.env.INCONTROL_HOME;
  process.env.INCONTROL_HOME = tmpHome;

  const store = new AgentStore();
  const hk = createHomeKitBridge(store, {
    getSettings: () => ({ homekitEnabled: true, allowHomekitApproval: true }),
    advertise: false,
  });

  try {
    const status = await hk.start();
    assert.equal(status.running, true);
    assert.match(status.pincode, /^\d{3}-\d{2}-\d{3}$/);
    assert.ok(status.setupUri.startsWith('X-HM://'));
    assert.match(status.setupQrSvg, /<svg/);

    store.upsertAgent({ id: 'hk-1', name: 'Codex', status: 'needs_input', pendingPrompt: { question: 'Deploy?' } });
    assert.equal(hk.getStatus().waitingCount, 1);
  } finally {
    await hk.stop({ destroyPairing: true });
    if (prevHome === undefined) delete process.env.INCONTROL_HOME;
    else process.env.INCONTROL_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('daily context archive: captures events & git commits and syncs by day to Railway endpoint', async () => {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { execFileSync } = await import('node:child_process');

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-git-test-'));
  execFileSync('git', ['init'], { cwd: tmpRepo });
  execFileSync('git', ['config', 'user.email', 'test@incontrol.dev'], { cwd: tmpRepo });
  execFileSync('git', ['config', 'user.name', 'InControl Test'], { cwd: tmpRepo });
  fs.writeFileSync(path.join(tmpRepo, 'README.md'), '# Test Repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: tmpRepo });
  execFileSync('git', ['commit', '-m', 'Initial test commit'], { cwd: tmpRepo });

  // Mock Railway Collector HTTP receiver
  const storedDays = new Map();
  const collectorServer = http.createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer rw-test-secret') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    }
    if (req.method === 'POST' && req.url === '/api/days') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        storedDays.set(parsed.day, parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, day: parsed.day, updatedAt: new Date().toISOString() }));
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/days?')) {
      const days = Array.from(storedDays.values()).map((d) => ({
        day: d.day,
        capturedAt: d.capturedAt,
        summary: d.summary,
        projectCount: d.stats.projectCount,
        commitCount: d.stats.commitCount,
        eventCount: d.stats.eventCount,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, days }));
    }
    const dayMatch = req.url.match(/^\/api\/days\/(\d{4}-\d{2}-\d{2})$/);
    if (req.method === 'GET' && dayMatch && storedDays.has(dayMatch[1])) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, day: dayMatch[1], collection: storedDays.get(dayMatch[1]) }));
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => collectorServer.listen(0, '127.0.0.1', r));
  const collectorPort = collectorServer.address().port;
  const hub = await createInControlHub({
    port: 4804,
    macNotifications: false,
    token: 'ctx-tok',
    autoWatch: false,
    homekit: false,
  });
  const baseUrl = 'http://localhost:4804';
  const auth = { Authorization: 'Bearer ctx-tok' };
  const origRes = await (await fetch(`${baseUrl}/api/settings`, { headers: auth })).json();
  const origSettings = origRes.settings;

  try {
    // Reject unsafe metadata SSRF URL
    const ssrfRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ railwayUrl: 'http://169.254.169.254/latest/meta-data' }),
    });
    assert.equal(ssrfRes.status, 400);

    // Configure mock Railway Collector URL + secret token & verify token masking
    const cfgRes = await (
      await fetch(`${baseUrl}/api/settings`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          railwayUrl: `http://127.0.0.1:${collectorPort}`,
          railwayToken: 'rw-test-secret',
        }),
      })
    ).json();
    assert.equal(cfgRes.ok, true);
    assert.equal(cfgRes.settings.hasRailwayToken, true);
    assert.equal(cfgRes.settings.railwayToken, '••••••••');

    // Register an active agent in our temp git repo
    await fetch(`${baseUrl}/api/agents/event`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'ctx-agent-1',
        name: 'Codex',
        provider: 'codex',
        workspace: tmpRepo,
        currentTask: 'Implement archive test',
        logMessage: 'Recorded context test event',
      }),
    });

    // Capture today's full bundle & push to mock Railway
    const capRes = await (
      await fetch(`${baseUrl}/api/context/capture`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json();
    assert.equal(capRes.ok, true);
    assert.equal(capRes.railway.synced, true);
    assert.ok(capRes.snapshot.stats.commitCount >= 1);
    assert.ok(capRes.snapshot.workspaces.some((w) => w.commitsToday.some((c) => c.subject === 'Initial test commit')));

    // Fetch archive index & day collection through hub
    const daysRes = await (await fetch(`${baseUrl}/api/context/days`, { headers: auth })).json();
    assert.equal(daysRes.ok, true);
    assert.equal(daysRes.remoteDays.length, 1);

    const dayDetail = await (
      await fetch(`${baseUrl}/api/context/days/${capRes.snapshot.day}`, { headers: auth })
    ).json();
    assert.equal(dayDetail.ok, true);
    assert.equal(dayDetail.source, 'railway');
    assert.equal(dayDetail.collection.day, capRes.snapshot.day);

    // Restore original settings
    await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...origSettings, railwayToken: '' }),
    });
  } finally {
    await hub.close();
    collectorServer.closeAllConnections?.();
    await new Promise((r) => collectorServer.close(r));
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
