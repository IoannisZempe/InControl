import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInControlHub } from '../src/server/hub.js';

test('hub: register agent, blocking ask resolved by panel reply', async () => {
  const hub = await createInControlHub({ port: 4799, macNotifications: false });
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
  const hub = await createInControlHub({ port: 4798, macNotifications: false, demo: true });
  try {
    const statuses = hub.store.getSortedAgents().map((a) => a.status);
    const order = ['needs_input', 'needs_attention', 'working', 'idle'];
    const ranks = statuses.map((s) => order.indexOf(s));
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  } finally {
    await hub.close();
  }
});
