// InControl client — shared by macOS side panel, desktop browser, and phone PWA.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const DEVICE_NAME = detectDevice();

const SECTION_META = {
  needs_input: { label: 'Needs Input', dot: 'dot-input' },
  needs_attention: { label: 'Needs Review', dot: 'dot-attention' },
  working: { label: 'Active', dot: 'dot-working' },
  idle: { label: 'Idle', dot: 'dot-idle' },
};

const ICON_BRANCH = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`;
const ICON_JUMP = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>`;
const ICON_REPLY = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`;

let state = { agents: [], counts: {}, network: {}, globalEvents: [] };
let filter = 'all';
let ws = null;
let reconnectDelay = 500;
let soundOn = localStorage.getItem('incontrol.sound') !== 'off';
let lastInputIds = new Set();
const expandedLogs = new Set();
const expandedCards = new Set();
const expandedCardAdvanced = new Set();
const draftReplies = new Map();

// ---------------- WebSocket ----------------
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    reconnectDelay = 500;
    $('#ws-indicator').classList.add('connected');
  };
  ws.onclose = () => {
    $('#ws-indicator').classList.remove('connected');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state_sync') {
      state = DEMO_MODE ? applyDemoState(msg.state) : msg.state;
      render();
    } else if (msg.type === 'notification') {
      onNotification(msg.notification);
    }
  };
}

function send(payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

// ---------------- Demo Mode (fictional projects for screenshots / posts) ----------------
// Enable with ?demo=1 or via Advanced → Demo Mode. Never sends anything to real agents.
const DEMO_MODE =
  new URLSearchParams(location.search).get('demo') === '1' ||
  localStorage.getItem('incontrol.demo') === 'on';
const demoResolved = new Map();

function demoIcon(bg1, bg2, glyph) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#g)"/>${glyph}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const DEMO_ICONS = {
  nova: demoIcon('#ff7a59', '#ff3d7f', '<path d="M18 40c6-14 22-14 28 0" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/><circle cx="32" cy="24" r="6" fill="#fff"/>'),
  atlas: demoIcon('#34c3ff', '#4a5cff', '<circle cx="32" cy="32" r="14" stroke="#fff" stroke-width="4.5" fill="none"/><path d="M18 32h28M32 18c6 8 6 20 0 28M32 18c-6 8-6 20 0 28" stroke="#fff" stroke-width="3" fill="none"/>'),
  orbit: demoIcon('#8e5cff', '#3b1fa8', '<circle cx="32" cy="32" r="7" fill="#fff"/><ellipse cx="32" cy="32" rx="20" ry="9" stroke="#fff" stroke-width="3.5" fill="none" transform="rotate(-25 32 32)"/>'),
  pulse: demoIcon('#2fe08a', '#0b9e6a', '<path d="M12 34h10l5-12 8 22 5-10h12" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
  lumen: demoIcon('#ffd34d', '#ff9f0a', '<path d="M32 14l4 12h12l-10 7 4 12-10-7-10 7 4-12-10-7h12z" fill="#fff"/>'),
  harbor: demoIcon('#5f7a99', '#2c3e57', '<path d="M32 16v30M22 26h20M18 38c4 8 24 8 28 0" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round"/>'),
};

function buildDemoAgents() {
  const now = Date.now();
  const tool = (k) => `/api/icons/tool/${k}`;
  const log = (minsAgo, message) => ({ timestamp: now - minsAgo * 60_000, message });
  const agents = [
    {
      id: 'demo-nova',
      name: 'Claude Code',
      provider: 'claude-code',
      toolKey: 'claude',
      ide: 'Terminal',
      workspace: '~/dev/nova-checkout',
      projectName: 'Nova Checkout',
      branch: 'feat/stripe-v3',
      status: 'needs_input',
      currentTask: 'Migrate payments to Stripe API v3',
      currentStep: 'Waiting for approval to run migration',
      pendingPrompt: {
        requestId: 'demo-req-nova',
        question: 'Allow Claude to run the database migration on staging?',
        command: 'npm run db:migrate -- --env=staging',
        allowFreeText: true,
        options: [
          { id: 'approve', label: 'Approve', style: 'primary' },
          { id: 'deny', label: 'Deny', style: 'danger' },
        ],
      },
      metrics: { updatedAt: now - 20_000 },
      logs: [log(1, 'Generated migration 0042_stripe_v3.sql'), log(3, 'Updated checkout webhooks')],
      toolIconUrl: tool('claude'),
      projectIconUrl: DEMO_ICONS.nova,
    },
    {
      id: 'demo-atlas',
      name: 'ChatGPT / Codex',
      provider: 'codex',
      toolKey: 'chatgpt',
      ide: 'ChatGPT App',
      workspace: '~/dev/atlas-mobile',
      projectName: 'Atlas Mobile',
      branch: 'release/2.4',
      status: 'needs_input',
      currentTask: 'Prepare iOS release 2.4.0',
      currentStep: 'Waiting for your confirmation in ChatGPT App',
      pendingPrompt: {
        requestId: 'demo-req-atlas',
        question: 'Confirm that you want me to upload build 2.4.0 (312) to TestFlight now.',
        details: 'All 148 tests pass. Changelog and screenshots are ready.',
        allowFreeText: true,
        options: [
          { id: 'quick_reply', label: 'Confirm Upload', style: 'primary', replyText: 'Confirmed, upload it.' },
          { id: 'dismiss', label: 'Not now', style: 'secondary' },
        ],
      },
      metrics: { updatedAt: now - 75_000 },
      logs: [log(2, 'Bumped version to 2.4.0 (312)'), log(6, 'Archived Release build')],
      toolIconUrl: tool('chatgpt'),
      projectIconUrl: DEMO_ICONS.atlas,
    },
    {
      id: 'demo-orbit',
      name: 'Antigravity',
      provider: 'antigravity',
      toolKey: 'antigravity',
      ide: 'Antigravity',
      workspace: '~/dev/orbit-analytics',
      projectName: 'Orbit Analytics',
      branch: 'design/dashboard-v2',
      status: 'needs_attention',
      currentTask: 'Redesign the analytics dashboard with live charts',
      currentStep: 'Completed · 12 files changed',
      attentionReason: 'Dashboard redesign finished — ready for your review',
      metrics: { updatedAt: now - 3 * 60_000 },
      logs: [log(3, 'Verified charts in browser preview'), log(9, 'Added realtime WebSocket feed')],
      toolIconUrl: tool('antigravity'),
      projectIconUrl: DEMO_ICONS.orbit,
    },
    {
      id: 'demo-pulse',
      name: 'Cursor',
      provider: 'cursor',
      toolKey: 'cursor',
      ide: 'Cursor',
      workspace: '~/dev/pulse-api',
      projectName: 'Pulse API',
      branch: 'refactor/auth',
      status: 'working',
      currentTask: 'Refactor auth middleware to support passkeys',
      currentStep: 'Editing src/middleware/auth.ts',
      metrics: { updatedAt: now - 8_000 },
      logs: [log(0.2, 'Editing src/middleware/auth.ts'), log(2, 'Added WebAuthn verification')],
      toolIconUrl: tool('cursor'),
      projectIconUrl: DEMO_ICONS.pulse,
    },
    {
      id: 'demo-lumen',
      name: 'Codex',
      provider: 'codex',
      toolKey: 'codex',
      ide: 'Codex CLI',
      workspace: '~/dev/lumen-docs',
      projectName: 'Lumen Docs',
      branch: 'main',
      status: 'working',
      currentTask: 'Generate API reference from OpenAPI spec',
      currentStep: 'Writing docs/reference/webhooks.md',
      metrics: { updatedAt: now - 30_000 },
      logs: [log(0.5, 'Writing docs/reference/webhooks.md')],
      toolIconUrl: tool('codex'),
      projectIconUrl: DEMO_ICONS.lumen,
    },
    {
      id: 'demo-harbor',
      name: 'Claude Code',
      provider: 'claude-code',
      toolKey: 'claude',
      ide: 'VS Code',
      workspace: '~/dev/harbor-infra',
      projectName: 'Harbor Infra',
      branch: 'main',
      status: 'idle',
      currentTask: 'Terraform plan for EU region',
      currentStep: 'Idle',
      metrics: { updatedAt: now - 42 * 60_000 },
      logs: [],
      toolIconUrl: tool('claude'),
      projectIconUrl: DEMO_ICONS.harbor,
    },
  ];
  // Apply locally-resolved demo interactions
  return agents.map((a) => {
    const r = demoResolved.get(a.id);
    return r ? { ...a, ...r, pendingPrompt: null } : a;
  });
}

function applyDemoState(real) {
  const agents = buildDemoAgents();
  const rank = { needs_input: 0, needs_attention: 1, working: 2, idle: 3 };
  agents.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  const counts = { total: agents.length, needs_input: 0, needs_attention: 0, working: 0, idle: 0 };
  agents.forEach((a) => (counts[a.status] = (counts[a.status] || 0) + 1));
  const now = Date.now();
  return {
    ...real,
    agents,
    counts,
    globalEvents: [
      { timestamp: now - 8_000, agentName: 'Cursor', projectName: 'Pulse API', message: 'Editing src/middleware/auth.ts' },
      { timestamp: now - 20_000, agentName: 'Claude Code', projectName: 'Nova Checkout', message: 'Requested approval: db:migrate' },
      { timestamp: now - 75_000, agentName: 'ChatGPT / Codex', projectName: 'Atlas Mobile', message: 'Waiting for TestFlight confirmation' },
      { timestamp: now - 180_000, agentName: 'Antigravity', projectName: 'Orbit Analytics', message: 'Task finished — ready for review' },
    ],
  };
}

function demoRespond(agentId, action) {
  if (action === 'dismiss' || action === 'deny') {
    demoResolved.set(agentId, { status: 'idle', currentStep: 'Idle' });
  } else {
    demoResolved.set(agentId, { status: 'working', currentStep: 'Continuing after your approval…' });
  }
  state = applyDemoState(state);
  render();
}

async function respond(agentId, action, text = '') {
  if (DEMO_MODE) {
    demoRespond(agentId, action);
    toast(action === 'reply' ? 'Reply sent (demo)' : `Sent: ${action} (demo)`);
    return;
  }
  const payload = { action, text, sourceDevice: DEVICE_NAME };
  if (!send({ type: 'respond', agentId, ...payload })) {
    await fetch(`/api/agents/${encodeURIComponent(agentId)}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
  draftReplies.delete(agentId);
  toast(action === 'reply' ? 'Reply sent' : `Sent: ${action}`);
}

async function focusAgent(agentId) {
  if (DEMO_MODE) return toast('Focused window (demo)');
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/focus`, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  toast(data.ok ? `Focused ${data.appName}` : data.reason || 'Could not focus window');
}

// ---------------- Rendering ----------------
function render() {
  applySettingsToUI();
  renderCounts();
  renderAgents();
  renderIntegrations();
  renderWhatsAppStatus();
  renderCustomFunctionsList();
  renderActivity();
  detectNewInputRequests();
}

function applySettingsToUI() {
  const s = state.settings || {};
  const logo = s.logoStyle || 'orbit';
  const theme = s.theme || 'obsidian';
  document.body.dataset.logo = logo;
  document.body.dataset.theme = theme;

  $$('.logo-choice').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.logoChoice === logo);
  });
  if ($('#cfg-icon-mode')) $('#cfg-icon-mode').value = s.iconMode || 'both';
  if ($('#cfg-theme')) $('#cfg-theme').value = theme;
  if ($('#cfg-popup-mode')) $('#cfg-popup-mode').value = s.popupMode || 'needs_input';
  if ($('#cfg-dock-side')) $('#cfg-dock-side').value = s.dockSide || 'right';
  if ($('#cfg-panel-width')) $('#cfg-panel-width').value = String(s.panelWidth || 386);
  if ($('#cfg-show-functions')) $('#cfg-show-functions').checked = s.showFunctionBar !== false;
  if ($('#cfg-voice-approval')) $('#cfg-voice-approval').checked = Boolean(s.allowVoiceApproval);
  if ($('#cfg-homekit-enabled')) $('#cfg-homekit-enabled').checked = Boolean(s.homekitEnabled);
  if ($('#cfg-homekit-approve')) $('#cfg-homekit-approve').checked = s.allowHomekitApproval !== false;
  const ahBadge = $('#apple-home-badge');
  if (ahBadge) {
    const hkOn = Boolean(s.homekitEnabled);
    ahBadge.textContent = hkOn ? 'HomeKit' : 'Ready';
    ahBadge.classList.toggle('active', hkOn);
  }
  const archiveBadge = $('#archive-menu-badge');
  if (archiveBadge) {
    const rwReady = Boolean(s.railwayUrl && (s.hasRailwayToken || s.railwayToken));
    archiveBadge.textContent = rwReady ? 'Railway' : 'Local';
    archiveBadge.classList.toggle('active', rwReady);
  }
  if ($('#cfg-railway-url') && document.activeElement !== $('#cfg-railway-url')) {
    $('#cfg-railway-url').value = s.railwayUrl || '';
  }
  if ($('#cfg-railway-token') && document.activeElement !== $('#cfg-railway-token')) {
    $('#cfg-railway-token').value = s.hasRailwayToken ? '••••••••' : '';
  }
  const rwLink = $('#railway-dashboard-link');
  if (rwLink) {
    if (s.railwayProjectUrl) {
      rwLink.href = s.railwayProjectUrl;
      rwLink.classList.remove('hidden');
    } else {
      rwLink.classList.add('hidden');
    }
  }

  // Sync native macOS panel geometry & pop-up mode
  window.webkit?.messageHandlers?.panelConfig?.postMessage({
    dockSide: s.dockSide || 'right',
    panelWidth: Number(s.panelWidth || 386),
    popupMode: s.popupMode || 'needs_input',
    demoMode: Boolean(DEMO_MODE),
  });
}

function renderWhatsAppStatus() {
  const btn = $('#btn-whatsapp');
  const wa = state.whatsapp || {};
  const active = Boolean(wa.enabled);
  if (btn) btn.classList.toggle('wa-active', active);
  const badge = $('#wa-menu-badge');
  if (badge) {
    badge.textContent = active ? 'On' : 'Off';
    badge.classList.toggle('active', active);
  }
}

function renderIntegrations() {
  const container = $('#integrations-list');
  if (!container) return;
  const items = state.integrations || [];
  container.innerHTML = items
    .map((item) => {
      const isConnected = item.configured || item.autoWatched;
      const iconUrl = item.iconUrl || `/api/icons/tool/${encodeURIComponent(item.id)}`;
      return `
        <div class="integration-row">
          <div class="integration-avatar-wrap">
            <img class="integration-icon" src="${esc(iconUrl)}" alt="${esc(item.name)}" loading="lazy" />
            ${
              item.secondaryIconUrl
                ? `<img class="integration-badge-icon" src="${esc(item.secondaryIconUrl)}" alt="" loading="lazy" />`
                : ''
            }
          </div>
          <div class="integration-info">
            <div class="integration-title-row">
              <span class="integration-name">${esc(item.name)}</span>
              <span class="integration-status ${isConnected ? 'connected' : ''}">${esc(item.statusText)}</span>
            </div>
            <div class="integration-sub">${esc(item.subtitle)}</div>
          </div>
          <button class="integration-btn ${item.configured ? 'installed' : ''}" data-act="install-integration" data-target="${esc(item.id)}">
            ${esc(item.actionLabel)}
          </button>
        </div>`;
    })
    .join('');
}

function renderCounts() {
  const c = state.counts || {};
  $('#count-all').textContent = c.total || 0;
  const inputEl = $('#count-input');
  inputEl.textContent = c.needs_input || 0;
  inputEl.classList.toggle('urgent', (c.needs_input || 0) > 0);
  $('#count-attention').textContent = c.needs_attention || 0;
  $('#count-working').textContent = c.working || 0;

  const pill = $('#urgent-pill');
  if (c.needs_input > 0) {
    pill.textContent = `${c.needs_input} waiting`;
    pill.classList.remove('hidden');
  } else {
    pill.classList.add('hidden');
  }
  const popupMode = state.settings?.popupMode || 'needs_input';
  const actionRequired =
    popupMode === 'urgent_and_review'
      ? (c.needs_input || 0) + (c.needs_attention || 0)
      : c.needs_input || 0;
  document.body.dataset.urgent = actionRequired > 0 ? 'true' : 'false';
  document.title = actionRequired > 0 ? `(${actionRequired}) InControl` : 'InControl';
  window.webkit?.messageHandlers?.badge?.postMessage(document.title);
}

function renderAgents() {
  const list = $('#agent-list');

  const active = document.activeElement;
  const focusedAgent = active?.dataset?.replyFor;
  const caret = focusedAgent ? active.selectionStart : null;

  const agents = state.agents.filter((a) => filter === 'all' || a.status === filter);

  if (state.agents.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <h3>No active agents</h3>
        <p>Start a Claude Code session in your terminal or connect Cursor, Antigravity, or a CLI agent.</p>
        <button class="connect-btn" data-act="open-connect">Connect Agent</button>
      </div>`;
    return;
  }

  if (agents.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <h3>All clear</h3>
        <p>No agents in this state right now.</p>
      </div>`;
    return;
  }

  let html = '';
  let currentSection = null;
  for (const agent of agents) {
    if (filter === 'all' && agent.status !== currentSection) {
      currentSection = agent.status;
      const meta = SECTION_META[agent.status] || { label: agent.status, dot: 'dot-idle' };
      html += `
        <div class="section-header">
          <div class="section-header-left">
            <span class="status-dot ${meta.dot}"></span>
            <span>${meta.label}</span>
          </div>
        </div>`;
    }
    html += renderCard(agent);
  }
  list.innerHTML = html;

  if (focusedAgent) {
    const input = list.querySelector(`[data-reply-for="${cssEscape(focusedAgent)}"]`);
    if (input) {
      input.focus();
      if (caret !== null) input.setSelectionRange(caret, caret);
    }
  }
}

function renderCardAvatar(a) {
  const iconMode = state.settings?.iconMode || 'both';
  const toolUrl =
    a.toolIconUrl || `/api/icons/tool/${encodeURIComponent(a.toolKey || a.provider || 'codex')}`;
  const projUrl = a.projectIconUrl || '';

  if (iconMode === 'both' && projUrl) {
    return `
      <div class="card-avatar-wrap has-corner-badge" title="${esc(a.projectName)} · ${esc(a.name)}">
        <img class="avatar-main-img" src="${esc(projUrl)}" alt="${esc(a.projectName)}" loading="lazy" />
        <img class="avatar-badge-img" src="${esc(toolUrl)}" alt="${esc(a.name)}" title="${esc(a.name)} (${esc(a.ide)})" loading="lazy" />
      </div>`;
  }

  if (iconMode === 'project' && projUrl) {
    return `
      <div class="card-avatar-wrap" title="${esc(a.projectName)}">
        <img class="avatar-main-img" src="${esc(projUrl)}" alt="${esc(a.projectName)}" loading="lazy" />
      </div>`;
  }

  return `
    <div class="card-avatar-wrap" title="${esc(a.name)} (${esc(a.ide)})">
      <img class="avatar-main-img" src="${esc(toolUrl)}" alt="${esc(a.name)}" loading="lazy" />
    </div>`;
}

function renderFunctionIconHtml(f, agent = null) {
  const iconSpec = String(f.icon || 'agent').trim();
  const iconMode = state.settings?.iconMode || 'both';
  const refAgent = agent || state.agents?.[0] || null;
  const toolUrl = refAgent?.toolIconUrl || '/api/icons/tool/codex';
  const projUrl = refAgent?.projectIconUrl || toolUrl;

  if (iconSpec.startsWith('tool:')) {
    const toolKey = iconSpec.slice(5) || 'codex';
    return `<img class="fn-icon-img" src="/api/icons/tool/${encodeURIComponent(toolKey)}" alt="${esc(toolKey)}" loading="lazy" />`;
  }
  if (iconSpec === 'project' || iconSpec === '🌿') {
    const src = iconMode === 'tool' ? toolUrl : projUrl;
    return `<img class="fn-icon-img" src="${esc(src)}" alt="Project" loading="lazy" />`;
  }
  if (iconSpec === 'agent' || ['⚡', '🛡️', '🚀'].includes(iconSpec)) {
    const src = iconMode === 'project' ? projUrl : toolUrl;
    return `<img class="fn-icon-img" src="${esc(src)}" alt="Agent" loading="lazy" />`;
  }
  return `<span>${esc(iconSpec)}</span>`;
}

function renderCard(a) {
  const avatarHtml = renderCardAvatar(a);
  const p = a.pendingPrompt;
  const updated = timeAgo(a.metrics?.updatedAt, true);
  const showLogs = expandedLogs.has(a.id);
  const hasDraft = Boolean((draftReplies.get(a.id) || '').trim());
  const isUrgentOrReview = a.status === 'needs_input' || a.status === 'needs_attention';
  const isCardExpanded = isUrgentOrReview || expandedCards.has(a.id) || expandedCardAdvanced.has(a.id) || hasDraft;
  const fnBarHtml = isCardExpanded ? renderFunctionBar(a) : '';

  let decisionHtml = '';
  if (a.status === 'needs_input' && p) {
    const opts = (p.options || [])
      .map(
        (o) =>
          `<button class="btn-decision ${esc(o.style || '')}" data-act="respond" data-agent="${esc(a.id)}" data-action="${esc(o.id)}" ${o.replyText ? `data-reply-text="${esc(o.replyText)}"` : ''}>${esc(o.label)}</button>`
      )
      .join('');
    decisionHtml = `
      <div class="decision-zone">
        <div class="prompt-question">${esc(p.question)}</div>
        ${p.details ? `<div class="prompt-details">${esc(p.details)}</div>` : ''}
        ${p.command ? `<pre class="prompt-code">${esc(p.command)}</pre>` : ''}
        <div class="decision-actions">${opts}</div>
        ${
          p.allowFreeText !== false
            ? `<form class="reply-form" data-act="reply-form" data-agent="${esc(a.id)}">
                 <input class="reply-input" data-reply-for="${esc(a.id)}" placeholder="Reply with instructions…" value="${esc(draftReplies.get(a.id) || '')}" autocomplete="off" />
                 <button type="submit" class="reply-submit">Send</button>
               </form>`
            : ''
        }
      </div>`;
  } else if (a.status === 'needs_attention') {
    decisionHtml = `
      <div class="attention-bar">
        <span class="attention-text">${esc(a.attentionReason || 'Task finished — ready for review')}</span>
        <button class="mini-icon-btn" data-act="respond" data-agent="${esc(a.id)}" data-action="dismiss">Dismiss</button>
      </div>
      <form class="reply-form" data-act="reply-form" data-agent="${esc(a.id)}">
        <input class="reply-input" data-reply-for="${esc(a.id)}" placeholder="Send follow-up instruction…" value="${esc(draftReplies.get(a.id) || '')}" autocomplete="off" />
        <button type="submit" class="reply-submit">Send</button>
      </form>`;
  } else if (a.status === 'working') {
    decisionHtml = `
      <form class="reply-form" data-act="reply-form" data-agent="${esc(a.id)}">
        <input class="reply-input" data-reply-for="${esc(a.id)}" placeholder="Steer agent (queued for next step)…" value="${esc(draftReplies.get(a.id) || '')}" autocomplete="off" />
        <button type="submit" class="reply-submit">Send</button>
        <button type="button" class="btn-decision danger" data-act="respond" data-agent="${esc(a.id)}" data-action="stop" title="Stop agent before next model call">Stop</button>
      </form>`;
  } else if (a.status === 'idle' && isCardExpanded) {
    decisionHtml = `
      <form class="reply-form" data-act="reply-form" data-agent="${esc(a.id)}">
        <input class="reply-input" data-reply-for="${esc(a.id)}" placeholder="Queue message or instruction…" value="${esc(draftReplies.get(a.id) || '')}" autocomplete="off" />
        <button type="submit" class="reply-submit">Send</button>
      </form>`;
  }

  const logHtml =
    showLogs && a.logs?.length
      ? `<ul class="agent-log">${a.logs
          .slice(0, 6)
          .map((l) => `<li><span class="log-time">${clock(l.timestamp)}</span>${esc(l.message)}</li>`)
          .join('')}</ul>`
      : '';

  const showExpandBtn = !isUrgentOrReview;
  const metaLine = [esc(a.name), a.branch ? `<span class="branch-tag">${ICON_BRANCH}<span>${esc(a.branch)}</span></span>` : '']
    .filter(Boolean)
    .join('<span class="meta-sep">·</span>');

  return `
    <article class="agent-card status-${a.status} ${isCardExpanded ? 'is-expanded' : 'is-compact'}" data-id="${esc(a.id)}">
      ${a.status === 'working' ? '<div class="card-aurora-bar"></div>' : ''}
      <div class="card-top">
        <div class="card-title-group">
          ${avatarHtml}
          <div class="title-stack">
            <div class="title-primary">
              <span class="project-name" title="${esc(a.workspace)}">${esc(a.projectName)}</span>
              <span class="agent-label">${metaLine}</span>
            </div>
          </div>
        </div>
        <div class="card-top-right">
          <span class="time-label">${updated}</span>
          ${
            showExpandBtn
              ? `<button class="mini-icon-btn ${isCardExpanded ? 'active' : ''}" data-act="toggle-expand" data-agent="${esc(a.id)}" title="${isCardExpanded ? 'Collapse actions' : 'Reply or run action'}">${ICON_REPLY}</button>`
              : ''
          }
          <button class="mini-icon-btn ${showLogs ? 'active' : ''}" data-act="toggle-log" data-agent="${esc(a.id)}" title="Toggle activity log">${showLogs ? 'Hide' : 'Log'}</button>
          <button class="mini-icon-btn" data-act="focus" data-agent="${esc(a.id)}" title="Focus ${esc(a.ide)} window">${ICON_JUMP}<span>Focus</span></button>
        </div>
      </div>

      ${
        a.currentTask || a.currentStep
          ? `<div class="card-body">
               ${a.currentTask ? `<div class="task-line">${esc(a.currentTask)}</div>` : ''}
               ${
                 a.currentStep && (a.status !== 'idle' || a.currentStep !== 'Idle')
                   ? `<div class="step-line" title="${esc(a.currentStep)}">
                        ${a.status === 'working' ? '<span class="step-pulse"></span>' : ''}
                        <span>${esc(a.currentStep)}</span>
                      </div>`
                   : ''
               }
             </div>`
          : ''
      }

      ${decisionHtml}
      ${fnBarHtml}
      ${logHtml}
    </article>`;
}

function renderFunctionBar(a) {
  const s = state.settings || {};
  if (s.showFunctionBar === false) return '';
  const fns = (s.customFunctions || []).filter((f) => f.pinned !== false);
  if (fns.length === 0) return '';

  const isExpanded = expandedCardAdvanced.has(a.id);
  const primaryFns = fns.slice(0, 2);
  const extraFns = fns.slice(2);

  const renderChip = (f) =>
    `<button type="button" class="fn-chip" data-act="run-function" data-agent="${esc(a.id)}" data-fn="${esc(f.id)}" title="${esc(f.type.toUpperCase())}: ${esc(f.payload)}">
      <span class="fn-chip-icon">${renderFunctionIconHtml(f, a)}</span>
      <span>${esc(f.label)}</span>
    </button>`;

  const primaryHtml = primaryFns.map(renderChip).join('');
  const extraHtml = isExpanded
    ? `${extraFns.map(renderChip).join('')}
       <button type="button" class="fn-chip fn-chip-add" data-act="open-settings" title="Add or customize functions">+ Customize</button>`
    : '';

  return `
    <div class="card-fn-bar">
      ${primaryHtml}
      ${extraHtml}
      <button type="button" class="fn-chip fn-chip-more ${isExpanded ? 'open' : ''}" data-act="toggle-card-advanced" data-agent="${esc(a.id)}" title="Show more functions">
        <span>${isExpanded ? 'Less' : 'Advanced'}</span>
      </button>
    </div>`;
}

function renderActivity() {
  const events = state.globalEvents || [];
  if (events[0]) {
    $('#last-event-preview').textContent = `${events[0].projectName || events[0].agentName}: ${events[0].message}`;
  }
  $('#activity-log').innerHTML = events
    .map(
      (e) =>
        `<li><span class="t">${clock(e.timestamp)}</span><strong>${esc(e.agentName)}</strong> · ${esc(e.message)}</li>`
    )
    .join('');
}

// ---------------- Notifications & Audio ----------------
function detectNewInputRequests() {
  const now = new Set(
    state.agents.filter((a) => a.status === 'needs_input').map((a) => a.pendingPrompt?.requestId || a.id)
  );
  let isNew = false;
  for (const id of now) if (!lastInputIds.has(id)) isNew = true;
  if (isNew && lastInputIds.size + now.size > 0 && document.readyState === 'complete') chime();
  lastInputIds = now;
}

function onNotification(n) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    new Notification(n.title, { body: n.body, tag: n.requestId });
  }
  if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
}

let audioCtx = null;
function chime() {
  if (!soundOn) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = freq;
      o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.1, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.28);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.3);
    });
  } catch {}
}

function syncSoundIcons() {
  $('#icon-sound-on')?.classList.toggle('hidden', !soundOn);
  $('#icon-sound-off')?.classList.toggle('hidden', soundOn);
  const badge = $('#sound-menu-badge');
  if (badge) {
    badge.textContent = soundOn ? 'On' : 'Off';
    badge.classList.toggle('active', soundOn);
  }
}
syncSoundIcons();

// ---------------- Event Listeners ----------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest(
    '[data-act], [data-close], [data-copy-target], [data-copy-text], [data-settings-tab], [data-apple-tab], [data-logo-choice], .filter-pill, .conn-tab'
  );
  if (!el) return;

  if (el.dataset.appleTab) {
    const tab = el.dataset.appleTab;
    $$('.apple-tab').forEach((t) => t.classList.toggle('active', t.dataset.appleTab === tab));
    $('#apple-pane-display')?.classList.toggle('hidden', tab !== 'display');
    $('#apple-pane-siri')?.classList.toggle('hidden', tab !== 'siri');
    $('#apple-pane-homekit')?.classList.toggle('hidden', tab !== 'homekit');
    return;
  }

  if (el.dataset.settingsTab) {
    const tab = el.dataset.settingsTab;
    $$('.settings-tab').forEach((t) => t.classList.toggle('active', t.dataset.settingsTab === tab));
    $('#settings-pane-functions')?.classList.toggle('hidden', tab !== 'functions');
    $('#settings-pane-appearance')?.classList.toggle('hidden', tab !== 'appearance');
    return;
  }

  if (el.dataset.logoChoice) {
    await saveSettingsPatch({ logoStyle: el.dataset.logoChoice });
    toast(`Logo updated: ${el.dataset.logoChoice}`);
    return;
  }

  if (el.classList.contains('filter-pill')) {
    $$('.filter-pill').forEach((t) => t.classList.remove('active'));
    el.classList.add('active');
    filter = el.dataset.filter;
    renderAgents();
    return;
  }
  if (el.classList.contains('conn-tab')) {
    $$('.conn-tab').forEach((t) => t.classList.remove('active'));
    el.classList.add('active');
    $$('.conn-pane').forEach((p) => p.classList.add('hidden'));
    $(`#conn-${el.dataset.conn}`).classList.remove('hidden');
    return;
  }
  if (el.dataset.close) return $(`#${el.dataset.close}`).classList.add('hidden');
  if (el.dataset.copyTarget) return copy($(`#${el.dataset.copyTarget}`).textContent);
  if (el.dataset.copyText) return copy(el.dataset.copyText);

  const agentId = el.dataset.agent;
  switch (el.dataset.act) {
    case 'respond':
      if (el.dataset.action === 'focus_and_dismiss') {
        focusAgent(agentId);
        return respond(agentId, 'dismiss');
      }
      if (el.dataset.replyText) {
        return respond(agentId, 'reply', el.dataset.replyText);
      }
      return respond(agentId, el.dataset.action);
    case 'focus':
      return focusAgent(agentId);
    case 'toggle-log':
      expandedLogs.has(agentId) ? expandedLogs.delete(agentId) : expandedLogs.add(agentId);
      return renderAgents();
    case 'toggle-expand': {
      const opening = !expandedCards.has(agentId);
      if (opening) {
        expandedCards.add(agentId);
      } else {
        expandedCards.delete(agentId);
        expandedCardAdvanced.delete(agentId);
      }
      renderAgents();
      if (opening) {
        requestAnimationFrame(() => document.querySelector(`[data-reply-for="${agentId}"]`)?.focus());
      }
      return;
    }
    case 'toggle-card-advanced':
      expandedCardAdvanced.has(agentId)
        ? expandedCardAdvanced.delete(agentId)
        : expandedCardAdvanced.add(agentId);
      return renderAgents();
    case 'open-connect':
      return $('#modal-connect').classList.remove('hidden');
    case 'open-settings':
      renderCustomFunctionsList();
      return $('#modal-settings').classList.remove('hidden');
    case 'run-function': {
      const fnId = el.dataset.fn;
      if (DEMO_MODE) {
        const fn = (state.settings?.customFunctions || []).find((f) => f.id === fnId);
        return toast(`Sent "${fn?.label || 'function'}" (demo)`);
      }
      el.classList.add('running');
      const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/function`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ functionId: fnId }),
      });
      const data = await res.json().catch(() => ({}));
      el.classList.remove('running');
      toast(data.message || data.error || 'Function executed');
      return;
    }
    case 'toggle-pin-fn': {
      const fnId = el.dataset.fn;
      const list = [...(state.settings?.customFunctions || [])].map((f) =>
        f.id === fnId ? { ...f, pinned: f.pinned === false } : f
      );
      await saveSettingsPatch({ customFunctions: list });
      return;
    }
    case 'delete-fn': {
      const fnId = el.dataset.fn;
      const list = (state.settings?.customFunctions || []).filter((f) => f.id !== fnId);
      await saveSettingsPatch({ customFunctions: list });
      toast('Removed custom function');
      return;
    }
    case 'install-integration': {
      const targetId = el.dataset.target;
      el.textContent = 'Connecting…';
      const res = await fetch('/api/integrations/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: targetId }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.integrations) {
        state.integrations = data.integrations;
        renderIntegrations();
      }
      toast(data.message || 'Connected');
      return;
    }
  }
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-act="reply-form"]');
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector('input');
  const text = input.value.trim();
  if (!text) return;
  respond(form.dataset.agent, 'reply', text);
  input.value = '';
});

document.addEventListener('input', (e) => {
  const id = e.target.dataset?.replyFor;
  if (id) draftReplies.set(id, e.target.value);
});

$('#btn-project').addEventListener('click', () => {
  $('#advanced-drawer')?.classList.add('hidden');
  $('#btn-advanced')?.classList.remove('active');
  const n = state.network || {};
  $('#qr-container').innerHTML = state.qrSvg || '';
  $('#url-primary').textContent = n.pairingUrl || n.primaryProjectionUrl || location.origin;
  if (n.tailscaleUrl) {
    $('#tailscale-row').classList.remove('hidden');
    $('#url-tailscale').textContent = n.tailscalePairingUrl || n.tailscaleUrl;
  }
  $('#modal-project').classList.remove('hidden');
});

$('#btn-connect').addEventListener('click', () => {
  $('#advanced-drawer')?.classList.add('hidden');
  $('#btn-advanced')?.classList.remove('active');
  $('#modal-connect').classList.remove('hidden');
});
$('#btn-settings')?.addEventListener('click', () => {
  $('#advanced-drawer')?.classList.add('hidden');
  $('#btn-advanced')?.classList.remove('active');
  renderCustomFunctionsList();
  $('#modal-settings').classList.remove('hidden');
});
$('#btn-advanced')?.addEventListener('click', () => {
  const drawer = $('#advanced-drawer');
  if (!drawer) return;
  const willOpen = drawer.classList.contains('hidden');
  drawer.classList.toggle('hidden', !willOpen);
  $('#btn-advanced')?.classList.toggle('active', willOpen);
  if (willOpen) {
    $('#activity-drawer')?.classList.add('hidden');
    $('#activity-chevron')?.classList.remove('open');
  }
});
$('#brand-logo-trigger')?.addEventListener('click', () => {
  renderCustomFunctionsList();
  $('#modal-settings').classList.remove('hidden');
  $$('.settings-tab').forEach((t) => t.classList.toggle('active', t.dataset.settingsTab === 'appearance'));
  $('#settings-pane-functions')?.classList.add('hidden');
  $('#settings-pane-appearance')?.classList.remove('hidden');
});
$('#btn-tile-panel')?.addEventListener('click', () => {
  window.webkit?.messageHandlers?.windowDrag?.postMessage('tile');
  toast('Snapped & fitted active window');
});
$('#btn-hide-panel')?.addEventListener('click', () => {
  window.webkit?.messageHandlers?.windowDrag?.postMessage('hide');
});

async function saveSettingsPatch(patch) {
  state.settings = { ...(state.settings || {}), ...patch };
  applySettingsToUI();
  renderCounts();
  renderAgents();
  renderCustomFunctionsList();
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (data.settings) {
    state.settings = data.settings;
    applySettingsToUI();
    renderCustomFunctionsList();
  }
}

function renderCustomFunctionsList() {
  const container = $('#custom-functions-list');
  if (!container) return;
  const fns = state.settings?.customFunctions || [];
  if (fns.length === 0) {
    container.innerHTML = `<div class="fn-empty">No custom functions yet. Add one below!</div>`;
    return;
  }
  container.innerHTML = fns
    .map(
      (f) => `
      <div class="fn-item">
        <div class="fn-item-left">
          <span class="fn-item-icon">${renderFunctionIconHtml(f)}</span>
          <div class="fn-item-meta">
            <div class="fn-item-title-row">
              <span class="fn-item-label">${esc(f.label)}</span>
              <span class="fn-type-badge type-${esc(f.type)}">${esc(f.type)}</span>
            </div>
            <div class="fn-item-payload">${esc(f.payload)}</div>
          </div>
        </div>
        <div class="fn-item-actions">
          <button type="button" class="mini-icon-btn ${f.pinned !== false ? 'active-pin' : ''}" data-act="toggle-pin-fn" data-fn="${esc(f.id)}" title="Show/hide on agent cards">${f.pinned !== false ? 'Pinned' : 'Hidden'}</button>
          <button type="button" class="mini-icon-btn danger-text" data-act="delete-fn" data-fn="${esc(f.id)}" title="Delete function">✕</button>
        </div>
      </div>`
    )
    .join('');
}

$('#form-add-function')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const icon = $('#fn-new-icon').value || 'agent';
  const label = $('#fn-new-label').value.trim();
  const type = $('#fn-new-type').value || 'prompt';
  const payload = $('#fn-new-payload').value.trim();
  if (!label || !payload) return;

  const list = [
    ...(state.settings?.customFunctions || []),
    {
      id: `fn_${Date.now().toString(36)}`,
      icon,
      label,
      type,
      payload,
      pinned: true,
    },
  ];
  await saveSettingsPatch({ customFunctions: list });
  $('#fn-new-label').value = '';
  $('#fn-new-payload').value = '';
  toast(`Added "${label}" function`);
});

$('#cfg-icon-mode')?.addEventListener('change', (e) => saveSettingsPatch({ iconMode: e.target.value }));
$('#cfg-theme')?.addEventListener('change', (e) => saveSettingsPatch({ theme: e.target.value }));
$('#cfg-popup-mode')?.addEventListener('change', (e) => saveSettingsPatch({ popupMode: e.target.value }));
$('#cfg-dock-side')?.addEventListener('change', (e) => saveSettingsPatch({ dockSide: e.target.value }));
$('#cfg-panel-width')?.addEventListener('change', (e) => saveSettingsPatch({ panelWidth: Number(e.target.value) }));
$('#cfg-show-functions')?.addEventListener('change', (e) => saveSettingsPatch({ showFunctionBar: e.target.checked }));
$('#cfg-voice-approval')?.addEventListener('change', async (e) => {
  await saveSettingsPatch({ allowVoiceApproval: e.target.checked });
  toast(e.target.checked ? 'Siri voice approvals enabled' : 'Siri voice approvals turned off');
});
$('#cfg-homekit-enabled')?.addEventListener('change', async (e) => {
  await saveSettingsPatch({ homekitEnabled: e.target.checked });
  await refreshAppleHomeModal();
  toast(e.target.checked ? 'Apple HomeKit Bridge started' : 'Apple HomeKit Bridge stopped');
});
$('#cfg-homekit-approve')?.addEventListener('change', async (e) => {
  await saveSettingsPatch({ allowHomekitApproval: e.target.checked });
  toast(e.target.checked ? 'HomeKit Approve switch enabled' : 'HomeKit Approve switch disabled');
});

async function refreshAppleHomeModal() {
  try {
    const res = await fetch('/api/apple-home');
    const data = await res.json();
    if (!data.ok) return;

    const hv = data.homeview || {};
    $('#hv-qr-container').innerHTML = hv.qrSvg || '';
    $('#hv-url-primary').textContent = hv.pairingUrl || `${location.origin}/homeview`;
    if (hv.tailscalePairingUrl) {
      $('#hv-tailscale-row').classList.remove('hidden');
      $('#hv-url-tailscale').textContent = hv.tailscalePairingUrl;
    } else {
      $('#hv-tailscale-row').classList.add('hidden');
    }
    const openLink = $('#btn-open-homeview');
    if (openLink) openLink.href = DEMO_MODE ? '/homeview?demo=1' : '/homeview';

    const voice = data.voice || {};
    $('#siri-url-status').textContent = voice.statusTextUrl || '';
    $('#siri-url-respond').textContent = voice.respondUrl || '';
    $('#siri-bearer-token').textContent = voice.bearerToken || '';
    if ($('#cfg-voice-approval')) $('#cfg-voice-approval').checked = Boolean(voice.allowVoiceApproval);

    const hk = data.homekit || {};
    if ($('#cfg-homekit-enabled')) $('#cfg-homekit-enabled').checked = Boolean(hk.enabled);
    if ($('#cfg-homekit-approve')) $('#cfg-homekit-approve').checked = hk.allowApproval !== false;
    const activeArea = $('#hk-active-area');
    if (hk.enabled && hk.running) {
      activeArea?.classList.remove('hidden');
      $('#hk-qr-container').innerHTML = hk.setupQrSvg || '';
      $('#hk-pincode').textContent = hk.pincode || '';
      $('#hk-pairing-status').textContent = hk.paired
        ? 'Paired with Apple Home'
        : 'Ready to pair — scan in Apple Home app';
    } else {
      activeArea?.classList.add('hidden');
      if (hk.error) toast(hk.error);
    }
  } catch {}
}

$('#btn-apple-home')?.addEventListener('click', async () => {
  $('#advanced-drawer')?.classList.add('hidden');
  $('#btn-advanced')?.classList.remove('active');
  $('#modal-apple-home')?.classList.remove('hidden');
  await refreshAppleHomeModal();
});

$('#btn-hk-reset')?.addEventListener('click', async () => {
  const res = await fetch('/api/apple-home/homekit/reset', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  await refreshAppleHomeModal();
  toast(data.message || 'HomeKit pairing reset');
});

// ---------------- Daily Context Capture & Railway Archive ----------------
async function triggerDailyCapture(triggerBtn = null) {
  if (DEMO_MODE) {
    toast('Captured 2026-11-13 -> Railway (demo: 4 projects, 7 commits)');
    return;
  }
  const origHtml = triggerBtn ? triggerBtn.innerHTML : null;
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = 'Saving…';
  }
  try {
    const res = await fetch('/api/context/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      toast(data.error || 'Failed to capture daily context');
      return;
    }
    const snap = data.snapshot || {};
    const stats = snap.stats || {};
    const statsText = `${stats.projectCount || 0}p · ${stats.commitCount || 0}c · ${stats.eventCount || 0}e`;
    if (data.railway?.synced) {
      toast(`Saved ${snap.day} → Railway (${statsText})`);
    } else if (data.railway?.error) {
      toast(`Saved locally (${statsText}) · Railway error: ${data.railway.error}`);
    } else {
      toast(`Saved ${snap.day} locally (${statsText})`);
    }
    if (!$('#modal-archive')?.classList.contains('hidden')) {
      await refreshArchiveModal();
    }
  } finally {
    if (triggerBtn && origHtml !== null) {
      triggerBtn.disabled = false;
      triggerBtn.innerHTML = origHtml;
    }
  }
}

async function refreshArchiveModal() {
  const listEl = $('#archive-days-list');
  const previewEl = $('#archive-day-preview');
  if (!listEl) return;
  listEl.innerHTML = '<div class="modal-note">Loading daily collections…</div>';
  previewEl?.classList.add('hidden');
  try {
    const res = await fetch('/api/context/days');
    const data = await res.json();
    if (!data.ok) {
      listEl.innerHTML = `<div class="modal-note">${esc(data.error || 'Unable to load archive')}</div>`;
      return;
    }
    const merged = new Map();
    for (const d of data.localDays || []) {
      merged.set(d.day, { ...d, badges: ['Local'] });
    }
    for (const d of data.remoteDays || []) {
      const prev = merged.get(d.day);
      merged.set(d.day, {
        ...(prev || {}),
        ...d,
        badges: prev ? ['Railway', 'Local'] : ['Railway'],
      });
    }
    const items = Array.from(merged.values()).sort((a, b) => b.day.localeCompare(a.day));
    if (!items.length) {
      listEl.innerHTML = '<div class="modal-note">No daily snapshots saved yet. Click "Save Today\'s Context" above.</div>';
      return;
    }
    listEl.innerHTML = items
      .map(
        (d) => `
        <button type="button" class="archive-row" data-act="preview-day" data-day="${esc(d.day)}">
          <div class="archive-row-top">
            <span class="archive-day">${esc(d.day)}</span>
            <span class="archive-badges">${d.badges.map((b) => `<span class="url-badge">${esc(b)}</span>`).join('')}</span>
          </div>
          <div class="archive-summary">${esc(d.summary || `${d.projectCount || 0} projects · ${d.commitCount || 0} commits · ${d.eventCount || 0} events`)}</div>
        </button>`
      )
      .join('');
  } catch {
    listEl.innerHTML = '<div class="modal-note">Failed to fetch archive list</div>';
  }
}

$('#btn-save-day')?.addEventListener('click', () => triggerDailyCapture($('#btn-save-day')));
$('#btn-archive-capture-now')?.addEventListener('click', () => triggerDailyCapture($('#btn-archive-capture-now')));
$('#btn-archive')?.addEventListener('click', async () => {
  $('#advanced-drawer')?.classList.add('hidden');
  $('#btn-advanced')?.classList.remove('active');
  $('#modal-archive')?.classList.remove('hidden');
  await refreshArchiveModal();
});
$('#railway-config-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const railwayUrl = ($('#cfg-railway-url')?.value || '').trim();
  const railwayToken = ($('#cfg-railway-token')?.value || '').trim();
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ railwayUrl, railwayToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      toast(data.error || 'Invalid Railway settings');
      return;
    }
    if (data.settings) state.settings = data.settings;
    applySettingsToUI();
    toast('Saved Railway Collector settings');
    await refreshArchiveModal();
  } catch {
    toast('Failed to save Railway settings');
  }
});
document.addEventListener('click', async (e) => {
  const dayBtn = e.target.closest('[data-act="preview-day"]');
  if (!dayBtn) return;
  const day = dayBtn.dataset.day;
  const previewEl = $('#archive-day-preview');
  if (!previewEl) return;
  previewEl.textContent = `Loading ${day}…`;
  previewEl.classList.remove('hidden');
  const res = await fetch(`/api/context/days/${encodeURIComponent(day)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    previewEl.textContent = data.error || 'Not found';
    return;
  }
  const col = data.collection || {};
  previewEl.textContent = JSON.stringify(
    {
      day: col.day,
      source: data.source,
      capturedAt: col.capturedAt,
      summary: col.summary,
      projects: col.projects,
      commitsToday: (col.workspaces || []).flatMap((w) =>
        (w.commitsToday || []).map((c) => `[${w.projectName}] ${c.hash} ${c.subject}`)
      ),
      aiSessions: (col.aiSessions || []).map((s) => ({
        provider: s.provider,
        title: s.title,
        workspace: s.workspace || undefined,
        userPrompts: (s.userPrompts || []).slice(0, 5),
        lastSummary: s.lastSummary || undefined,
      })),
      recentEvents: (col.events || []).slice(0, 12).map((ev) => `${ev.projectName}: ${ev.message}`),
    },
    null,
    2
  );
});

function syncWhatsAppProviderPane(provider) {
  $$('.wa-provider-pane').forEach((p) => p.classList.add('hidden'));
  const pane = $(`#wa-pane-${provider}`);
  if (pane) pane.classList.remove('hidden');
  $('#wa-phone-wrap').classList.toggle('hidden', provider === 'webhook');
}

function populateWhatsAppForm() {
  const wa = state.whatsapp || {};
  $('#wa-enabled').checked = wa.enabled !== false;
  $('#wa-timeout').value = String(wa.timeoutSec || 60);
  $('#wa-provider').value = wa.provider || 'callmebot';
  $('#wa-attention').checked = Boolean(wa.notifyOnAttention);
  $('#wa-phone').value = wa.phone || '';
  $('#wa-callmebot-key').value = wa.callmebotApiKey || '';
  $('#wa-twilio-sid').value = wa.twilioSid || '';
  $('#wa-twilio-token').value = wa.twilioToken || '';
  $('#wa-twilio-from').value = wa.twilioFrom || 'whatsapp:+14155238886';
  $('#wa-cloud-phone-id').value = wa.cloudPhoneId || '';
  $('#wa-cloud-token').value = wa.cloudToken || '';
  $('#wa-webhook-url').value = wa.webhookUrl || '';
  syncWhatsAppProviderPane($('#wa-provider').value);
}

$('#btn-whatsapp')?.addEventListener('click', () => {
  $('#advanced-drawer')?.classList.add('hidden');
  $('#btn-advanced')?.classList.remove('active');
  populateWhatsAppForm();
  $('#modal-whatsapp').classList.remove('hidden');
});

$('#wa-provider')?.addEventListener('change', (e) => {
  syncWhatsAppProviderPane(e.target.value);
});

$('#form-whatsapp')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    enabled: $('#wa-enabled').checked,
    timeoutSec: Number($('#wa-timeout').value || 60),
    provider: $('#wa-provider').value,
    notifyOnAttention: $('#wa-attention').checked,
    phone: $('#wa-phone').value.trim(),
    callmebotApiKey: $('#wa-callmebot-key').value.trim(),
    twilioSid: $('#wa-twilio-sid').value.trim(),
    twilioToken: $('#wa-twilio-token').value.trim(),
    twilioFrom: $('#wa-twilio-from').value.trim(),
    cloudPhoneId: $('#wa-cloud-phone-id').value.trim(),
    cloudToken: $('#wa-cloud-token').value.trim(),
    webhookUrl: $('#wa-webhook-url').value.trim(),
  };
  const res = await fetch('/api/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (data.whatsapp) {
    state.whatsapp = data.whatsapp;
    renderWhatsAppStatus();
  }
  toast(data.message || 'Saved WhatsApp settings');
  $('#modal-whatsapp').classList.add('hidden');
});

$('#btn-wa-test')?.addEventListener('click', async () => {
  const btn = $('#btn-wa-test');
  btn.textContent = 'Sending…';
  // Save current form values first so test uses them
  await fetch('/api/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: $('#wa-enabled').checked,
      timeoutSec: Number($('#wa-timeout').value || 60),
      provider: $('#wa-provider').value,
      notifyOnAttention: $('#wa-attention').checked,
      phone: $('#wa-phone').value.trim(),
      callmebotApiKey: $('#wa-callmebot-key').value.trim(),
      twilioSid: $('#wa-twilio-sid').value.trim(),
      twilioToken: $('#wa-twilio-token').value.trim(),
      twilioFrom: $('#wa-twilio-from').value.trim(),
      cloudPhoneId: $('#wa-cloud-phone-id').value.trim(),
      cloudToken: $('#wa-cloud-token').value.trim(),
      webhookUrl: $('#wa-webhook-url').value.trim(),
    }),
  });
  const res = await fetch('/api/whatsapp/test', { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  btn.textContent = 'Send Test';
  toast(data.ok ? data.message : data.error || 'WhatsApp test failed');
});

$('#btn-sound').addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('incontrol.sound', soundOn ? 'on' : 'off');
  syncSoundIcons();
  if (soundOn) chime();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
});

$('#btn-demo')?.addEventListener('click', () => {
  localStorage.setItem('incontrol.demo', DEMO_MODE ? 'off' : 'on');
  const url = new URL(location.href);
  url.searchParams.delete('demo');
  location.replace(url.toString());
});
if ($('#demo-menu-badge')) {
  $('#demo-menu-badge').textContent = DEMO_MODE ? 'On' : 'Off';
  $('#demo-menu-badge').classList.toggle('active', DEMO_MODE);
}

$('#toggle-activity').addEventListener('click', () => {
  const willOpen = $('#activity-drawer').classList.contains('hidden');
  $('#activity-drawer').classList.toggle('hidden', !willOpen);
  $('#activity-chevron').classList.toggle('open', willOpen);
  if (willOpen) {
    $('#advanced-drawer')?.classList.add('hidden');
    $('#btn-advanced')?.classList.remove('active');
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
});

setInterval(() => {
  if (!document.activeElement?.dataset?.replyFor) renderAgents();
}, 15000);

// ---------------- Helpers ----------------
function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
function cssEscape(s) {
  return window.CSS?.escape ? CSS.escape(s) : s.replace(/"/g, '\\"');
}
function providerBadgeSvg(provider, name) {
  switch (provider) {
    case 'codex':
      // OpenAI / Codex geometric knot mark
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 20.66 7 20.66 17 12 22 3.34 17 3.34 7 12 2"/><circle cx="12" cy="12" r="3.2"/></svg>`;
    case 'antigravity':
      // Google Antigravity 4-point star + orbit
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5 C13.2 8.5 15.5 10.8 21.5 12 C15.5 13.2 13.2 15.5 12 21.5 C10.8 15.5 8.5 13.2 2.5 12 C8.5 10.8 10.8 8.5 12 2.5 Z"/></svg>`;
    case 'claude-code':
      // Claude sunburst / spark mark
      return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/><line x1="18.4" y1="5.6" x2="5.6" y2="18.4"/></svg>`;
    case 'cursor':
      // Cursor 3D vector arrow cube
      return `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 4l16 6.5-7 2.5-2.5 7L4 4z"/></svg>`;
    default:
      return `<span>${esc((name || '?').slice(0, 2).toUpperCase())}</span>`;
  }
}
function timeAgo(ts, short = false) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m${short ? '' : ' ago'}`;
  return `${Math.round(m / 60)}h${short ? '' : ' ago'}`;
}
function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function copy(text) {
  navigator.clipboard?.writeText(text.trim()).then(
    () => toast('Copied to clipboard'),
    () => toast('Copy failed')
  );
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}
function detectDevice() {
  const ua = navigator.userAgent;
  if (/InControlPanel/.test(ua)) return 'Mac Panel';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'Browser';
}

connect();
