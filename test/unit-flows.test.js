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
import { presentedToken, isAuthorized, safeEqual } from '../src/server/auth.js';
import {
  generateVapidKeys,
  createVapidAuthHeader,
  encryptWebPushPayload,
  validatePushEndpoint,
} from '../src/server/webpush.js';
import crypto from 'node:crypto';

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
    const sidecar = JSON.parse(fs.readFileSync(path.join(pluginDir, 'sidecars', 'bridge', 'sidecar.json'), 'utf8'));
    const userCfg = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'config', 'config.json'), 'utf8'));

    assert.equal(manifest.name, 'incontrol');
    assert.equal(hooks.incontrol.enabled, true);
    assert.ok(
      hooks.incontrol.PreInvocation[0].command.includes(JSON.stringify(process.execPath)),
      'Hook command must quote absolute process.execPath for GUI PATH independence'
    );
    assert.equal(mcp.mcpServers.incontrol.command, process.execPath);
    assert.equal(sidecar.command, process.execPath);
    assert.ok(sidecar.args.includes('sidecar') && sidecar.args.includes('agy'));
    assert.equal(userCfg.sidecars['incontrol/bridge'].enabled, true);
    assert.ok(fs.existsSync(path.join(pluginDir, 'rules', 'AGENTS.md')), 'Plugin rule AGENTS.md must be installed');

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
    assert.equal(afterIdle.ready, false);
    assert.equal(afterIdle.requiresWake, true);
    assert.equal(afterIdle.mode, 'queued-needs-wake');
    assert.ok(afterIdle.warning.includes('Copy + Focus'));

    // When the live Antigravity sidecar bridge is registered, even an idle turn reports ready:true
    idleAgy.metadata = { conversationId: 'conv-idle-bridge-1' };
    store.registerProviderBridge('antigravity', () => true);
    const afterIdleWithBridge = inspectAgentDelivery(store, idleAgy);
    assert.equal(afterIdleWithBridge.ready, true);
    assert.equal(afterIdleWithBridge.mode, 'sidecar-bridge');
    store.unregisterProviderBridge('antigravity');

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

    // Replying on a passive stopped transcript prompt queues it honestly (needs_attention + requiresWake)
    // instead of faking green working status, and must not revert back to needs_input on next scan
    const replyRes = store.respondToAgent('agy-convprom', { action: 'reply', text: 'commit and push to main', sourceDevice: 'Mac Panel' });
    assert.equal(replyRes.deliveredLive, false);
    assert.equal(replyRes.requiresWake, true);
    assert.equal(store.agents.get('agy-convprom').status, 'needs_attention');
    scanAntigravitySessions(store, seen, dismissed);
    assert.equal(store.agents.get('agy-convprom').status, 'needs_attention', 'Fresh queued state must not be overwritten by stale transcript');
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

test('unit: ChatGPT/Codex watcher detects option approvals, resets completed steps on new turn, and queues with --resume', async () => {
  const { EventEmitter } = await import('node:events');
  const {
    detectActionRequest,
    queueCodexThreadMessage,
    resolveCodexBin,
  } = await import('../src/connectors/auto-watcher.js');

  // 1. Real ChatGPT numbered option + "Approve option 1..." prompt must trigger needs_input with quick buttons
  const msg = [
    'I see three approaches:',
    '',
    '1. **Compliance-first connector platform — recommended.** Separate repo and service; official APIs where available.',
    '2. **Full browser scraping.** Wider coverage initially, but fragile.',
    '3. **Manual research assistant.** Users paste listings.',
    '',
    'I recommend option 1, with a server-side email entitlement. Approve option 1 and I’ll write the design, create the standalone repo, and begin test-first implementation.',
  ].join('\n');

  const req = detectActionRequest(msg, false, 'ChatGPT App');
  assert.ok(req, 'Option approval prompt must be detected for ChatGPT App');
  assert.equal(req.options[0].label, 'Option 1: Compliance-first…');
  assert.equal(req.options[0].replyText, 'Approve option 1');
  assert.equal(req.options[1].replyText, 'Option 2');
  assert.equal(req.options[2].replyText, 'Option 3');

  // 2. Binary preference: ChatGPT App prefers Desktop bundled codex before ~/.local/bin/codex
  const desktopBin = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const resolvedDesktop = resolveCodexBin('ChatGPT App', (p) => p === desktopBin || p.endsWith('/.local/bin/codex'));
  assert.equal(resolvedDesktop, desktopBin);

  // 3. queueCodexThreadMessage passes --resume, falls back without --resume on older CLI, and marks needs_attention on failure
  const store = new AgentStore();
  store.upsertAgent({ id: 'codex-test', name: 'ChatGPT / Codex', provider: 'codex', ide: 'ChatGPT App', status: 'needs_attention' });

  const calls = [];
  const makeFakeChild = ({ code = 0, stderrText = '' }) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stderrText) child.stderr.emit('data', Buffer.from(stderrText));
      child.emit('close', code);
    });
    return child;
  };

  queueCodexThreadMessage('thread-uuid-1', 'Option 1', process.cwd(), store, 'codex-test', 'ChatGPT App', {
    binOverride: '/tmp/fake-codex-old',
    spawnFn: (bin, args) => {
      calls.push({ bin, args });
      if (args.includes('--resume')) {
        return makeFakeChild({ code: 2, stderrText: "error: unexpected argument '--resume' found" });
      }
      return makeFakeChild({ code: 0 });
    },
  });

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.includes('--resume'), true);
  assert.equal(calls[1].args.includes('--resume'), false);
  assert.equal(store.agents.get('codex-test').status, 'working');
  assert.match(store.agents.get('codex-test').currentStep, /Sent to ChatGPT App/);

  // 4. Isolated HOME watcher test: trailing token_count does not flip completed turn to working;
  // new task_started clears Turn completed; active MCP needs_input is preserved.
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-unit-codex-'));
  const dayDir = path.join(fakeHome, '.codex', 'sessions', '2026', '11', '16');
  fs.mkdirSync(dayDir, { recursive: true });
  const rollout = path.join(dayDir, 'rollout-2026-11-16T16-00-00-11111111-2222-3333-4444-555555555555.jsonl');
  const workspaceDir = path.join(fakeHome, 'Repo', 'GymW');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const isoScript = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { AgentStore } from './src/server/store.js';
    import { scanCodexAndChatGptSessions, inspectAgentDelivery } from './src/connectors/auto-watcher.js';

    const store = new AgentStore();
    const seen = new Map();
    const dismissed = new Set();
    const rollout = ${JSON.stringify(rollout)};
    const workspaceDir = ${JSON.stringify(workspaceDir)};
    const tid = '11111111-2222-3333-4444-555555555555';

    // Phase A: task_complete with approval prompt + trailing token_count
    fs.writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id: tid, session_id: tid, cwd: workspaceDir, originator: 'Codex Desktop' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build tracker' }] } }),
      JSON.stringify({ type: 'event_msg', ordinal: 1, payload: { type: 'task_complete', turn_id: 't1', last_agent_message: ${JSON.stringify(msg)} } }),
      JSON.stringify({ type: 'event_msg', ordinal: 2, payload: { type: 'token_count' } }),
    ].join('\\n') + '\\n');

    scanCodexAndChatGptSessions(store, seen, dismissed);
    const a1 = store.agents.get('codex-gymw');
    assert.equal(a1.status, 'needs_input');
    assert.equal(a1.metadata.threadId, tid);
    assert.equal(inspectAgentDelivery(store, a1).ready, true);

    // Phase B: finished normal turn + trailing token_count -> stays needs_attention, never working+Turn completed
    fs.writeFileSync(rollout, [
      JSON.stringify({ type: 'session_meta', payload: { id: tid, session_id: tid, cwd: workspaceDir, originator: 'Codex Desktop' } }),
      JSON.stringify({ type: 'event_msg', ordinal: 3, payload: { type: 'task_complete', turn_id: 't2', last_agent_message: 'All tests passed cleanly.' } }),
      JSON.stringify({ type: 'event_msg', ordinal: 4, payload: { type: 'token_count' } }),
    ].join('\\n') + '\\n');
    const t2 = new Date(Date.now() + 2000);
    fs.utimesSync(rollout, t2, t2);
    scanCodexAndChatGptSessions(store, seen, dismissed);
    const a2 = store.agents.get('codex-gymw');
    assert.equal(a2.status, 'needs_attention');
    assert.equal(a2.currentStep, 'Turn completed');

    // Phase C: new turn started -> resets Turn completed to Thinking...
    fs.appendFileSync(rollout, [
      JSON.stringify({ type: 'event_msg', ordinal: 5, payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Lets do both 1+2' }] } }),
    ].join('\\n') + '\\n');
    const t3 = new Date(Date.now() + 4000);
    fs.utimesSync(rollout, t3, t3);
    scanCodexAndChatGptSessions(store, seen, dismissed);
    const a3 = store.agents.get('codex-gymw');
    assert.equal(a3.status, 'working');
    assert.equal(a3.currentStep, 'Thinking…');
    assert.equal(a3.attentionReason, null);
  `;

  try {
    await execFileAsync(process.execPath, ['--input-type=module', '-e', isoScript], {
      cwd: ROOT,
      env: { ...process.env, HOME: fakeHome, INCONTROL_HOME: path.join(fakeHome, '.incontrol') },
    });
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

test('unit: focusAgentWindow deep-links ChatGPT threads, opens Cursor workspaces, and handles AX denial cleanly', async () => {
  const { focusAgentWindow } = await import('../src/server/macos-focus.js');

  const calls = [];
  const fakeExec = (cmd, args, _opts, cb) => {
    calls.push({ cmd, args });
    if (cmd === 'osascript') {
      return cb(null, 'AX_DENIED:Antigravity', '');
    }
    return cb(null, '', '');
  };

  // 1. ChatGPT / Codex deep link routes directly to exact thread ID without Accessibility
  const codexFocus = await focusAgentWindow(
    {
      id: 'codex-gymw',
      ide: 'ChatGPT App',
      provider: 'codex',
      projectName: 'GymW',
      metadata: { threadId: '01a1b689-eab3-7743-ae1e-0fcfc33c766a' },
    },
    { platform: 'darwin', execFileFn: fakeExec }
  );
  assert.equal(codexFocus.ok, true);
  assert.equal(codexFocus.deepLinked, true);
  assert.equal(codexFocus.exactTarget, true);
  assert.equal(calls[0].cmd, 'open');
  assert.equal(calls[0].args[0], 'codex://threads/01a1b689-eab3-7743-ae1e-0fcfc33c766a');

  // 2. Cursor with existing workspace focuses folder window directly without Accessibility
  calls.length = 0;
  const cursorFocus = await focusAgentWindow(
    {
      id: 'cursor-demo',
      ide: 'Cursor',
      provider: 'cursor',
      projectName: 'InControl',
      workspace: '/Users/demo/Repo/InControl',
    },
    { platform: 'darwin', execFileFn: fakeExec, existsSyncFn: () => true }
  );
  assert.equal(cursorFocus.ok, true);
  assert.equal(cursorFocus.exactTarget, true);
  assert.equal(calls[0].cmd, 'open');
  assert.deepEqual(calls[0].args, ['-a', 'Cursor', '/Users/demo/Repo/InControl']);

  // 3. Antigravity activates app even when Accessibility (System Events) is denied, reporting honest status
  calls.length = 0;
  const agyFocus = await focusAgentWindow(
    {
      id: 'agy-1',
      ide: 'Antigravity',
      provider: 'antigravity',
      projectName: 'InControl',
      workspace: '/Users/demo/Repo/InControl',
    },
    { platform: 'darwin', execFileFn: fakeExec }
  );
  assert.equal(agyFocus.ok, true);
  assert.equal(agyFocus.appName, 'Antigravity');
  assert.equal(agyFocus.needsAccessibility, true);
  assert.equal(agyFocus.exactTarget, false);
  assert.equal(calls[0].cmd, 'open');
  assert.deepEqual(calls[0].args, ['-a', 'Antigravity']);
});

test('unit: scanAntigravitySessions expires 25h-old Needs Review cards and prunes >12h idle ghost cards', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-unit-stale-agy-'));
  fs.mkdirSync(path.join(fakeHome, '.gemini', 'antigravity', 'brain'), { recursive: true });

  const script = `
    import assert from 'node:assert/strict';
    import { AgentStore } from './src/server/store.js';
    import { scanAntigravitySessions } from './src/connectors/auto-watcher.js';

    const store = new AgentStore();
    const now = Date.now();
    store.upsertAgent({
      id: 'agy-stale20m',
      name: 'Antigravity',
      provider: 'antigravity',
      ide: 'Antigravity',
      status: 'needs_attention',
      currentStep: 'Turn complete — ready for review',
      attentionReason: 'Old turn',
      updatedAt: now - 20 * 60_000,
    });
    store.upsertAgent({
      id: 'agy-stale25h',
      name: 'Antigravity',
      provider: 'antigravity',
      ide: 'Antigravity',
      status: 'needs_attention',
      currentStep: 'Turn complete — ready for review',
      updatedAt: now - 25 * 3600_000,
    });
    store.upsertAgent({
      id: 'agy-idle20h',
      name: 'Antigravity',
      provider: 'antigravity',
      ide: 'Antigravity',
      status: 'idle',
      currentStep: 'Idle',
      updatedAt: now - 20 * 3600_000,
    });

    scanAntigravitySessions(store, new Map(), new Set());

    // 20m-old review card demotes to idle; >12h cards are expired/pruned cleanly
    assert.equal(store.agents.get('agy-stale20m')?.status, 'idle');
    assert.equal(store.agents.get('agy-stale20m')?.attentionReason, null);
    assert.equal(store.agents.get('agy-stale25h')?.status, 'idle');
    assert.equal(store.agents.has('agy-idle20h'), false);
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

test('unit: TheOne branding, icons, demo media, and CLI alias stay consistent', () => {
  // WHY: Prevents regressions where UI, macOS menu bar, PWA manifest, or README drift back
  // to stale branding or broken icon/demo links.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin.theone, './bin/incontrol.js');
  assert.equal(pkg.bin.incontrol, './bin/incontrol.js');
  assert.equal(pkg.bin['incontrol-agents'], './bin/incontrol.js');

  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert.match(indexHtml, /<title>TheOne<\/title>/);
  assert.match(indexHtml, /<span class="brand-title">TheOne<\/span>/);
  assert.match(indexHtml, /apple-touch-icon\.png/);
  assert.match(indexHtml, /The One Ring & Eye/);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/manifest.json'), 'utf8'));
  assert.equal(manifest.short_name, 'TheOne');
  assert.match(manifest.name, /^TheOne/);

  const homeviewHtml = fs.readFileSync(path.join(ROOT, 'public/homeview.html'), 'utf8');
  assert.match(homeviewHtml, /<title>TheOne · Apple HomeView<\/title>/);
  assert.match(homeviewHtml, /apple-touch-icon\.png/);

  const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  assert.match(appJs, /TheOne/);

  const swiftPanel = fs.readFileSync(path.join(ROOT, 'macos/InControlPanel.swift'), 'utf8');
  assert.match(swiftPanel, /TheOneStatusItem/);
  assert.match(swiftPanel, /The One Ring & Eye/);
  assert.match(swiftPanel, /var stayHidden: Bool/);
  assert.match(swiftPanel, /cmd == "stay_hidden"/);
  assert.match(swiftPanel, /dismissedSignature/);
  assert.match(swiftPanel, /final class NotchHandleView/);
  assert.match(swiftPanel, /func sendQuickDecision/);
  assert.match(swiftPanel, /toggleNotchHandle/);
  assert.match(indexHtml, /id="btn-close-stay-hidden"/);
  assert.match(indexHtml, /id="cfg-handle-style"/);
  assert.match(appJs, /is-kbd-selected/);
  assert.match(appJs, /ArrowDown/);

  // Verify Forged Gold SVG icon and binary PNG/GIF/MP4 headers
  const iconSvg = fs.readFileSync(path.join(ROOT, 'public/icon.svg'), 'utf8');
  assert.match(iconSvg, /#E8C468/i);

  const touchPng = fs.readFileSync(path.join(ROOT, 'public/apple-touch-icon.png'));
  assert.equal(touchPng.subarray(0, 4).toString('hex'), '89504e47', 'apple-touch-icon.png must be a valid PNG');

  const demoGif = fs.readFileSync(path.join(ROOT, 'docs/demo.gif'));
  assert.match(demoGif.subarray(0, 6).toString('ascii'), /^GIF8[79]a$/, 'docs/demo.gif must be a valid GIF');

  const demoMp4 = fs.readFileSync(path.join(ROOT, 'docs/demo.mp4'));
  assert.equal(demoMp4.subarray(4, 8).toString('ascii'), 'ftyp', 'docs/demo.mp4 must be a valid MP4 container');

  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /<h1 align="center">TheOne<\/h1>/);
  assert.match(readme, /docs\/demo\.gif/);
  assert.match(readme, /--gate-bash/);
  assert.match(readme, /Platform Scope/);
});

test('unit: mobile Bearer token & QR query pairing auth guards', () => {
  // WHY: Native iOS / mobile clients connect over LAN or Tailscale using Authorization: Bearer
  // on REST calls and ?token= on WebSocket upgrades; auth must reject forged or missing tokens.
  const secret = 'test-mobile-192bit-token-xyz';
  const urlNoToken = new URL('http://192.168.1.42:4747/api/state');
  const urlWithToken = new URL(`http://192.168.1.42:4747/ws?token=${secret}`);

  const lanBearerReq = {
    headers: { authorization: `Bearer ${secret}` },
    socket: { remoteAddress: '192.168.1.99' },
  };
  assert.equal(presentedToken(lanBearerReq, urlNoToken), secret);
  assert.equal(isAuthorized(lanBearerReq, urlNoToken, secret, { requireLocal: true }), true);

  const wsQueryReq = {
    headers: {},
    socket: { remoteAddress: '100.64.0.12' },
  };
  assert.equal(presentedToken(wsQueryReq, urlWithToken), secret);
  assert.equal(isAuthorized(wsQueryReq, urlWithToken, secret, { requireLocal: true }), true);

  const badBearerReq = {
    headers: { authorization: 'Bearer wrong-token' },
    socket: { remoteAddress: '192.168.1.99' },
  };
  assert.equal(isAuthorized(badBearerReq, urlNoToken, secret, { requireLocal: true }), false);
  assert.equal(safeEqual(secret, 'short'), false);
});

test('unit: native iOS SwiftUI project (ios/TheOne) has valid manifest, icons, and sources', () => {
  const iosRoot = path.join(ROOT, 'ios');
  const expectedFiles = [
    'TheOne.xcodeproj/project.pbxproj',
    'TheOne.xcodeproj/xcshareddata/xcschemes/TheOne.xcscheme',
    'TheOne/Info.plist',
    'TheOne/TheOneApp.swift',
    'TheOne/ContentView.swift',
    'TheOne/HubClient.swift',
    'TheOne/Models.swift',
    'TheOne/TheOneLogoView.swift',
    'TheOne/NotificationManager.swift',
    'TheOne/QRScannerView.swift',
    'TheOne/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png',
  ];
  for (const rel of expectedFiles) {
    assert.equal(fs.existsSync(path.join(iosRoot, rel)), true, `Missing iOS project file: ${rel}`);
  }
  const appIcon = fs.readFileSync(path.join(iosRoot, 'TheOne/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png'));
  assert.equal(appIcon.subarray(0, 4).toString('hex'), '89504e47', 'AppIcon-1024.png must be a valid PNG');
  const plist = fs.readFileSync(path.join(iosRoot, 'TheOne/Info.plist'), 'utf8');
  assert.match(plist, /NSCameraUsageDescription/);
  assert.match(plist, /NSLocalNetworkUsageDescription/);
});

test('unit: Web Push VAPID ES256 JWT, RFC 8291 aes128gcm round-trip decryption, and SSRF guards', () => {
  // WHY: Zero-dependency Web Push must produce valid RFC 8292 VAPID JWTs and RFC 8291 aes128gcm
  // ciphertexts that Apple (web.push.apple.com) & Chrome/Firefox can decrypt, while blocking SSRF.
  const vapid = generateVapidKeys();
  const endpoint = 'https://web.push.apple.com/QBS1234567890';
  const { jwt, authorization } = createVapidAuthHeader({
    endpoint,
    publicKey: vapid.publicKey,
    privateKey: vapid.privateKey,
  });
  assert.match(authorization, /^vapid t=[^,]+, k=/);

  // Verify ES256 signature on the JWT with the uncompressed VAPID public key
  const [hdrB64, payB64, sigB64] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(payB64, 'base64url').toString('utf8'));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  const pubRaw = Buffer.from(vapid.publicKey, 'base64url');
  const pubKeyObj = crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pubRaw.subarray(1, 33).toString('base64url'),
      y: pubRaw.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  const sigValid = crypto.verify(
    'sha256',
    Buffer.from(`${hdrB64}.${payB64}`),
    { key: pubKeyObj, dsaEncoding: 'ieee-p1363' },
    Buffer.from(sigB64, 'base64url')
  );
  assert.equal(sigValid, true, 'VAPID ES256 JWT signature must verify cleanly');

  // Simulate subscriber (iPhone PWA) ECDH keypair + 16-byte auth secret and decrypt our ciphertext
  const uaEcdh = crypto.createECDH('prime256v1');
  uaEcdh.generateKeys();
  const uaPublic = uaEcdh.getPublicKey();
  const authSecret = crypto.randomBytes(16);

  const original = JSON.stringify({ title: 'payments-api · Needs Input', body: '$ npx prisma migrate dev' });
  const packet = encryptWebPushPayload(original, {
    p256dh: uaPublic.toString('base64url'),
    auth: authSecret.toString('base64url'),
  });

  // Parse RFC 8188 header: salt(16) || rs(4) || idlen(1) || asPublic(65) || ciphertext || tag(16)
  const salt = packet.subarray(0, 16);
  const rs = packet.readUInt32BE(16);
  const idlen = packet[20];
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const asPublic = packet.subarray(21, 21 + 65);
  const ciphertext = packet.subarray(86, packet.length - 16);
  const tag = packet.subarray(packet.length - 16);

  const shared = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const decryptedRecord = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.equal(decryptedRecord[decryptedRecord.length - 1], 0x02, 'Final RFC 8188 delimiter must be 0x02');
  assert.equal(decryptedRecord.subarray(0, -1).toString('utf8'), original);

  // SSRF endpoint validation guards
  assert.equal(validatePushEndpoint('https://web.push.apple.com/abc').ok, true);
  assert.equal(validatePushEndpoint('http://web.push.apple.com/abc').ok, false);
  assert.equal(validatePushEndpoint('https://169.254.169.254/latest/meta-data').ok, false);
  assert.equal(validatePushEndpoint('https://192.168.1.5/hook').ok, false);
  assert.equal(validatePushEndpoint('https://127.0.0.1:4747/api/state').ok, false);
});
