/**
 * Unit Flow Tests — fast, isolated checks for core InControl invariants:
 *   1. AgentStore priority sorting, single-drain FIFO queues, & blocking prompt resolution
 *   2. Antigravity plugin installer + inspectAgentDelivery() diagnostics (in isolated HOME)
 *   3. Custom function execution (prompt delivery metadata + shell/webhook guardrails)
 *
 * Each test documents HOW the mechanism works and WHY the invariant matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AgentStore } from '../src/server/store.js';
import { executeCustomFunction, saveUserSettings } from '../src/server/settings.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('unit: AgentStore priority sorting, FIFO queue drain, and prompt resolution', async () => {
  // WHY: Attention-first sorting ensures blocked/waiting agents always surface at the top
  // of the Mac Side Panel & PWA even when background agents are active or idle.
  const store = new AgentStore();
  const baseTs = 1_700_000_000_000;

  store.upsertAgent({ id: 'idle-old', name: 'A', status: 'idle', updatedAt: baseTs + 1 });
  store.upsertAgent({ id: 'work-new', name: 'B', status: 'working', updatedAt: baseTs + 50 });
  store.upsertAgent({ id: 'attn-1', name: 'C', status: 'needs_attention', updatedAt: baseTs + 10 });
  store.upsertAgent({ id: 'input-1', name: 'D', status: 'needs_input', updatedAt: baseTs + 5 });

  assert.deepEqual(
    store.getSortedAgents().map((a) => a.id),
    ['input-1', 'attn-1', 'work-new', 'idle-old'],
    'Sorted order must be needs_input -> needs_attention -> working -> idle'
  );

  // WHY: Steering / Security Check messages push onto a FIFO queue while working,
  // and draining once clears them so a second drain never duplicates instructions.
  store.respondToAgent('work-new', { action: 'reply', text: 'First steer', sourceDevice: 'Mac Panel' });
  store.respondToAgent('work-new', { action: 'reply', text: 'Second steer', sourceDevice: 'Mac Panel' });
  assert.equal(store.agents.get('work-new').queuedMessages.length, 2);

  const drained = store.drainQueuedMessages('work-new');
  assert.deepEqual(
    drained.map((m) => m.text),
    ['First steer', 'Second steer']
  );
  assert.deepEqual(store.drainQueuedMessages('work-new'), [], 'Second drain must be empty');

  // WHY: requestInput holds a Promise until respondToAgent supplies the human decision,
  // clears pendingPrompt, and transitions status back to working.
  const waiter = store.requestInput('work-new', {
    wait: true,
    question: 'Allow migration?',
    toolName: 'run_command',
    command: 'npm run migrate',
  });
  assert.equal(store.agents.get('work-new').status, 'needs_input');
  assert.equal(store.agents.get('work-new').pendingPrompt.question, 'Allow migration?');

  store.respondToAgent('work-new', { action: 'approve', text: 'Proceed', sourceDevice: 'iPhone' });
  const decision = await waiter;
  assert.equal(decision.action, 'approve');
  assert.equal(decision.text, 'Proceed');
  assert.equal(store.agents.get('work-new').pendingPrompt, null);
  assert.equal(store.agents.get('work-new').status, 'working');

  // WHY: Dismiss moves a needs_attention card into idle and clears attentionReason.
  store.respondToAgent('attn-1', { action: 'dismiss', sourceDevice: 'Mac Panel' });
  assert.equal(store.agents.get('attn-1').status, 'idle');
  assert.equal(store.agents.get('attn-1').attentionReason, null);
});

test('unit: Antigravity plugin installer & inspectAgentDelivery() in isolated HOME', async () => {
  // WHY: auto-watcher.js captures HOME at module load, and we must never touch the user's
  // real ~/.gemini directory in tests. Running inside a child Node process with temp HOME
  // verifies both real on-disk plugin creation AND legacy duplicate hook cleanup.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-unit-agy-'));
  const fakeConfigDir = path.join(fakeHome, '.gemini', 'config');
  fs.mkdirSync(path.join(fakeHome, '.gemini', 'antigravity', 'brain'), { recursive: true });
  fs.mkdirSync(fakeConfigDir, { recursive: true });

  // Seed legacy hooks.json containing a third-party hook PLUS a stale 'incontrol' hook entry
  fs.writeFileSync(
    path.join(fakeConfigDir, 'hooks.json'),
    JSON.stringify({
      hooks: {
        PreInvocation: [
          { command: 'echo incontrol legacy' },
          { command: 'echo keep-third-party-hook' },
        ],
      },
    })
  );

  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { AgentStore } from './src/server/store.js';
    import {
      getIntegrationsStatus,
      installIntegration,
      inspectAgentDelivery,
    } from './src/connectors/auto-watcher.js';

    const home = process.env.HOME;
    const store = new AgentStore();
    const workingAgy = store.upsertAgent({
      id: 'agy-1',
      name: 'Antigravity',
      provider: 'antigravity',
      status: 'working',
    });
    const idleAgy = store.upsertAgent({
      id: 'agy-idle',
      name: 'Antigravity',
      provider: 'antigravity',
      status: 'idle',
    });

    // Note: legacy hooks.json had "incontrol" string so simulate clean unconfigured HOME first
    fs.unlinkSync(path.join(home, '.gemini', 'config', 'hooks.json'));
    const before = inspectAgentDelivery(store, workingAgy);
    assert.equal(before.ready, false, 'Without hooks, Antigravity delivery must report ready:false');
    assert.equal(before.mode, 'unconfigured');
    assert.match(before.warning, /Enable|Setup Antigravity/i);

    // Restore legacy hooks.json to verify duplicate stripping during install
    fs.writeFileSync(
      path.join(home, '.gemini', 'config', 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreInvocation: [
            { command: 'incontrol hook agy PreInvocation' },
            { command: 'keep-other-hook' },
          ],
        },
      })
    );

    const installed = installIntegration('antigravity');
    assert.equal(installed.ok, true);

    const pluginDir = path.join(home, '.gemini', 'config', 'plugins', 'incontrol');
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
    const hooks = JSON.parse(fs.readFileSync(path.join(pluginDir, 'hooks.json'), 'utf8'));
    const mcp = JSON.parse(fs.readFileSync(path.join(pluginDir, 'mcp_config.json'), 'utf8'));

    assert.equal(manifest.name, 'incontrol');
    assert.equal(hooks.incontrol.enabled, true);
    assert.ok(
      hooks.incontrol.PreInvocation[0].command.includes(JSON.stringify(process.execPath)),
      'Hook command must quote absolute process.execPath for GUI PATH independence'
    );
    assert.equal(mcp.mcpServers.incontrol.command, process.execPath);

    // Verify legacy incontrol hook entry was removed while third-party hook was preserved
    const legacyAfter = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'hooks.json'), 'utf8'));
    assert.equal(legacyAfter.hooks.PreInvocation.length, 1);
    assert.equal(legacyAfter.hooks.PreInvocation[0].command, 'keep-other-hook');

    const status = getIntegrationsStatus().find((s) => s.id === 'antigravity');
    assert.equal(status.configured, true);

    const afterWorking = inspectAgentDelivery(store, workingAgy);
    assert.equal(afterWorking.ready, true);
    assert.equal(afterWorking.mode, 'plugin');
    assert.equal(afterWorking.idleNote, undefined);

    const afterIdle = inspectAgentDelivery(store, idleAgy);
    assert.equal(afterIdle.ready, true);
    assert.match(afterIdle.idleNote, /next Antigravity turn/i);

    // Verify scanAntigravitySessions() promotes confirmation questions into needs_input
    // and keeps completed responses in needs_attention well past 45s (2 minutes old)
    const { scanAntigravitySessions } = await import('./src/connectors/auto-watcher.js');
    const seen = new Map();
    const dismissed = new Set();
    const twoMinsAgo = new Date(Date.now() - 120_000);

    const convPromptDir = path.join(home, '.gemini', 'antigravity', 'brain', 'convprompt1234', '.system_generated', 'logs');
    fs.mkdirSync(convPromptDir, { recursive: true });
    const promptTranscript = path.join(convPromptDir, 'transcript.jsonl');
    fs.writeFileSync(
      promptTranscript,
      JSON.stringify({
        step_index: 4,
        type: 'USER_INPUT',
        content: '<USER_REQUEST>Push them</USER_REQUEST>',
      }) +
        '\\n' +
        JSON.stringify({
          step_index: 5,
          type: 'PLANNER_RESPONSE',
          content: 'Please confirm before I run git write commands.\\n\\nReply **"commit and push to main"** (or adjust the message).',
          tool_calls: [{ name: 'default_api:run_command', arguments: { Path: '/Users/demo/Repo/InControl/a.js' } }],
        }).replace('"tool_calls":[{"name":"default_api:run_command","arguments":{"Path":"/Users/demo/Repo/InControl/a.js"}}]', '"tool_calls":[]') +
        '\\n'
    );
    fs.utimesSync(promptTranscript, twoMinsAgo, twoMinsAgo);

    scanAntigravitySessions(store, seen, dismissed);
    const promptAgent = store.agents.get('agy-convprom');
    assert.equal(promptAgent.status, 'needs_input', '2-minute-old confirmation question must stay in needs_input');
    assert.equal(promptAgent.pendingPrompt.options[0].label, 'Reply "commit and push to main"');
    assert.equal(promptAgent.pendingPrompt.options[0].replyText, 'commit and push to main');

    // Clicking Reply or Dismiss must not immediately revert back to needs_input on next scan
    store.respondToAgent('agy-convprom', { action: 'reply', text: 'commit and push to main', sourceDevice: 'Mac Panel' });
    assert.equal(store.agents.get('agy-convprom').status, 'working');
    scanAntigravitySessions(store, seen, dismissed);
    assert.equal(store.agents.get('agy-convprom').status, 'working', 'Fresh user reply must not be overwritten by stale transcript');
  `;

  try {
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: { ...process.env, HOME: fakeHome, INCONTROL_HOME: path.join(fakeHome, '.incontrol') },
    });
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('unit: executeCustomFunction enforces shell allowlist & SSRF webhook guards', async () => {
  // WHY: Custom function buttons run from remote paired devices too, so shell execution must
  // reject non-allowlisted commands and webhook triggers must block metadata/unspecified hosts.
  const prevHome = process.env.INCONTROL_HOME;
  const isoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-unit-fn-'));
  process.env.INCONTROL_HOME = isoHome;

  try {
    saveUserSettings({
      customFunctions: [
        { id: 'fn_security', label: 'Security Check', type: 'prompt', payload: 'Audit recent changes.' },
        { id: 'fn_bad_shell', label: 'Bad Shell', type: 'shell', payload: 'git status && whoami' },
        { id: 'fn_ssrf', label: 'Bad Webhook', type: 'webhook', payload: 'http://169.254.169.254/latest' },
      ],
    });

    const store = new AgentStore();
    store.upsertAgent({
      id: 'fn-target',
      name: 'Codex',
      provider: 'codex',
      status: 'working',
      workspace: ROOT,
    });

    const promptRes = await executeCustomFunction(store, 'fn-target', 'fn_security');
    assert.equal(promptRes.ok, true);
    assert.equal(promptRes.type, 'prompt');
    assert.equal(typeof promptRes.delivery?.mode, 'string');
    assert.equal(store.agents.get('fn-target').queuedMessages[0].sourceDevice, 'Function · Security Check');

    const badShellRes = await executeCustomFunction(store, 'fn-target', 'fn_bad_shell');
    assert.equal(badShellRes.ok, false);
    assert.match(badShellRes.error, /safe allowlist/i);

    const badWebhookRes = await executeCustomFunction(store, 'fn-target', 'fn_ssrf');
    assert.equal(badWebhookRes.ok, false);
    assert.match(badWebhookRes.error, /not permitted/i);
  } finally {
    fs.rmSync(isoHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.INCONTROL_HOME;
    else process.env.INCONTROL_HOME = prevHome;
  }
});
