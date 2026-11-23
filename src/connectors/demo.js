import QRCode from 'qrcode';
import { InControlAgent } from '../sdk/index.js';
import { loadOrCreateToken } from '../server/auth.js';
import { createInControlHub, discoverNetworkUrls } from '../server/hub.js';
import { launchMacPanel } from '../server/macos-panel.js';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isHubReachable(hubUrl) {
  try {
    const res = await fetch(`${hubUrl}/api/state`, { signal: AbortSignal.timeout(800) });
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
}

function summarizeDecision(result) {
  const resp = result?.response || result || {};
  const action = String(resp.action || (result?.timedOut ? 'timeout' : 'approved')).toLowerCase();
  const text = typeof resp.text === 'string' ? resp.text.trim() : '';
  return { action, text, timedOut: Boolean(result?.timedOut) };
}

/**
 * Runs a 20-second zero-setup interactive demo of TheOne / InControl:
 *   1. Connects to an existing hub or boots an embedded local hub on :4747
 *   2. Prints a scannable terminal QR code for instant phone pairing
 *   3. Seeds 3 realistic agents across the 4 priority lanes
 *   4. Pauses "Claude Code · DB Migration" on a risky Bash gate until approved/denied
 */
export async function runInteractiveDemo(options = {}) {
  const log = options.log || console.log;
  const port = Number(options.port || 4747);
  const stepDelayMs = Number.isFinite(options.stepDelayMs) ? options.stepDelayMs : 900;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 300_000;
  const localOnly = Boolean(options.localOnly);
  const noQr = Boolean(options.noQr);
  const once = Boolean(options.once);

  let embeddedHub = null;
  let hubUrl = options.hubUrl ? options.hubUrl.replace(/\/$/, '') : `http://localhost:${port}`;
  let pairingUrl = null;
  let localUrl = hubUrl;

  if (!options.hubUrl) {
    const alreadyRunning = await isHubReachable(hubUrl);
    if (!alreadyRunning) {
      embeddedHub = await createInControlHub({
        port,
        macNotifications: !options.noNotify,
        localOnly,
        strict: Boolean(options.strict),
      });
      localUrl = embeddedHub.network.localUrl;
      pairingUrl = localOnly
        ? null
        : embeddedHub.network.tailscalePairingUrl || embeddedHub.network.pairingUrl;
    } else {
      const token = loadOrCreateToken();
      const network = discoverNetworkUrls(port);
      localUrl = network.localUrl;
      pairingUrl = localOnly
        ? null
        : `${network.tailscaleUrl || network.primaryProjectionUrl}/?token=${encodeURIComponent(token)}`;
    }
  }

  if (options.panel && options.rootDir && options.cliPath) {
    launchMacPanel(localUrl, { rootDir: options.rootDir, cliPath: options.cliPath });
  }

  log(`
  ╭─────────────────────────────────────────────────────────╮
  │  TheOne · 20-Second Interactive Approval Demo           │
  ╰─────────────────────────────────────────────────────────╯
  Browser UI:  ${localUrl}
  Phone Link:  ${pairingUrl || '(disabled: --local-only)'}`);

  if (pairingUrl && !noQr) {
    try {
      const asciiQr = await QRCode.toString(pairingUrl, { type: 'terminal', small: true });
      log('\n  Scan with your phone camera (same Wi-Fi or Tailscale) to approve remotely:\n');
      for (const line of asciiQr.trimEnd().split('\n')) {
        log(`  ${line}`);
      }
      log('');
    } catch {
      // Non-fatal: pairing URL is already printed above.
    }
  }

  const workspace = options.workspace || process.cwd();
  const token = options.token || null;

  const codexAgent = new InControlAgent({
    id: 'demo-codex-billing',
    name: 'Codex · Billing API',
    provider: 'codex',
    ide: 'Codex',
    workspace,
    branch: 'feat/stripe-idempotency',
    hubUrl,
    token,
  });

  const cursorAgent = new InControlAgent({
    id: 'demo-cursor-checkout',
    name: 'Cursor · Checkout UI',
    provider: 'cursor',
    ide: 'Cursor',
    workspace,
    branch: 'fix/checkout-mobile',
    hubUrl,
    token,
  });

  const claudeAgent = new InControlAgent({
    id: 'demo-claude-migration',
    name: 'Claude Code · DB Migration',
    provider: 'claude',
    ide: 'Claude Code',
    workspace,
    branch: 'feat/users-org-index',
    hubUrl,
    token,
  });

  await codexAgent.working('Refactoring webhook retries', 'Running 42 billing unit tests');
  await cursorAgent.report({
    status: 'needs_review',
    currentTask: 'Fix mobile checkout modal overflow',
    currentStep: 'Diff ready in CheckoutModal.tsx (+18 -6) — ready for review',
  });
  await claudeAgent.working(
    'Add composite org_id index on users',
    'Generated prisma/migrations/20261123_users_org_idx/migration.sql'
  );

  if (stepDelayMs > 0) {
    await delay(stepDelayMs);
  }

  const gatedCommand = 'npx prisma migrate deploy --schema=prisma/prod.prisma';
  log('  [Claude Code] Paused on --gate-bash:');
  log(`    $ ${gatedCommand}`);
  log(`  -> Open ${localUrl} or scan the QR code above and tap Approve, Dry Run, or Deny.\n`);

  const startedAt = Date.now();
  const askRes = await claudeAgent.askHuman(
    'Allow Bash command: npx prisma migrate deploy --schema=prisma/prod.prisma ?',
    ['Approve', 'Dry Run Only', 'Deny'],
    {
      command: gatedCommand,
      details:
        'Demo PreToolUse gate — tap Approve from your phone or desktop panel, or Deny with course-correction feedback.',
      timeoutMs,
      wait: true,
    }
  );

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const { action, text, timedOut } = summarizeDecision(askRes);

  if (timedOut) {
    log(`  ! Demo prompt timed out after ${elapsedSec}s.`);
    await claudeAgent.idle('Demo timed out waiting for approval');
  } else if (action.includes('deny') || action === 'reject' || action === 'stop') {
    const reason = text || 'User denied risky production migration';
    log(`  ✕ Received "${action}" in ${elapsedSec}s${text ? ` ("${text}")` : ''} — blocked Bash command.`);
    await claudeAgent.report({
      status: 'needs_review',
      currentTask: 'Add composite org_id index on users',
      currentStep: `Blocked migration per human feedback: ${reason}`,
    });
  } else if (action.includes('dry')) {
    log(`  ✓ Received "${action}" in ${elapsedSec}s — running safe dry-run SQL diff...`);
    await claudeAgent.working(
      'Add composite org_id index on users',
      'Running prisma migrate diff --script (dry-run only)'
    );
    if (stepDelayMs > 0) await delay(stepDelayMs);
    await claudeAgent.report({
      status: 'needs_review',
      currentTask: 'Add composite org_id index on users',
      currentStep: 'Dry-run SQL preview verified — zero table locks detected',
    });
  } else {
    log(`  ✓ Received "${action}" in ${elapsedSec}s${text ? ` ("${text}")` : ''} — resuming migration...`);
    await claudeAgent.working(
      'Add composite org_id index on users',
      'Applying migration & verifying 14/14 schema checks...'
    );
    if (stepDelayMs > 0) await delay(stepDelayMs);
    await claudeAgent.report({
      status: 'needs_review',
      currentTask: 'Add composite org_id index on users',
      currentStep: 'Migration applied cleanly — 14/14 checks passed',
    });
  }

  log(`
  ✓ Demo complete! Ready to wire up your real coding agents?
    npx incontrol-agents setup claude-code --install --gate-bash
    npx incontrol-agents setup cursor
    npx incontrol-agents start --panel
`);

  if (embeddedHub && once) {
    await embeddedHub.close();
    embeddedHub = null;
  }

  return {
    hub: embeddedHub,
    hubUrl,
    localUrl,
    pairingUrl,
    decision: { action, text, timedOut },
    agentId: claudeAgent.id,
  };
}
