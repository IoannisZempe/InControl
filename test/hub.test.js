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
