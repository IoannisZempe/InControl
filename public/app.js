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

let state = { agents: [], counts: {}, network: {}, globalEvents: [] };
let filter = 'all';
let ws = null;
let reconnectDelay = 500;
let soundOn = localStorage.getItem('incontrol.sound') !== 'off';
let lastInputIds = new Set();
const expandedLogs = new Set();
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
      state = msg.state;
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

async function respond(agentId, action, text = '') {
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
  if ($('#cfg-theme')) $('#cfg-theme').value = theme;
  if ($('#cfg-popup-mode')) $('#cfg-popup-mode').value = s.popupMode || 'needs_input';
  if ($('#cfg-dock-side')) $('#cfg-dock-side').value = s.dockSide || 'right';
  if ($('#cfg-panel-width')) $('#cfg-panel-width').value = String(s.panelWidth || 386);
  if ($('#cfg-show-functions')) $('#cfg-show-functions').checked = s.showFunctionBar !== false;

  // Sync native macOS panel geometry & pop-up mode
  window.webkit?.messageHandlers?.panelConfig?.postMessage({
    dockSide: s.dockSide || 'right',
    panelWidth: Number(s.panelWidth || 386),
    popupMode: s.popupMode || 'needs_input',
  });
}

function renderWhatsAppStatus() {
  const btn = $('#btn-whatsapp');
  if (!btn) return;
  const wa = state.whatsapp || {};
  btn.classList.toggle('wa-active', Boolean(wa.enabled));
}

function renderIntegrations() {
  const container = $('#integrations-list');
  if (!container) return;
  const items = state.integrations || [];
  container.innerHTML = items
    .map((item) => {
      const isConnected = item.configured || item.autoWatched;
      return `
        <div class="integration-row">
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

function renderCard(a) {
  const badgeSvg = providerBadgeSvg(a.provider, a.name);
  const p = a.pendingPrompt;
  const updated = timeAgo(a.metrics?.updatedAt, true);
  const showLogs = expandedLogs.has(a.id);
  const fnBarHtml = renderFunctionBar(a);

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
  } else if (a.status === 'idle') {
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

  return `
    <article class="agent-card status-${a.status}" data-id="${esc(a.id)}">
      ${a.status === 'working' ? '<div class="card-aurora-bar"></div>' : ''}
      <div class="card-top">
        <div class="card-title-group">
          <span class="provider-badge provider-${esc(a.provider)}">${badgeSvg}</span>
          <div class="title-stack">
            <div class="title-primary">
              <span class="project-name" title="${esc(a.workspace)}">${esc(a.projectName)}</span>
              <span class="agent-label">${esc(a.name)}</span>
            </div>
          </div>
        </div>
        <div class="card-top-right">
          <span class="time-label">${updated}</span>
          <button class="mini-icon-btn" data-act="toggle-log" data-agent="${esc(a.id)}" title="Toggle activity log">${showLogs ? 'Hide' : 'Log'}</button>
          <button class="mini-icon-btn" data-act="focus" data-agent="${esc(a.id)}" title="Focus ${esc(a.ide)} window">${ICON_JUMP}<span>Focus</span></button>
        </div>
      </div>

      <div class="card-submeta">
        <span>${esc(a.ide)}</span>
        ${a.branch ? `<span>·</span><span class="branch-tag">${ICON_BRANCH}<span>${esc(a.branch)}</span></span>` : ''}
      </div>

      <div class="card-body">
        ${a.currentTask ? `<div class="task-line">${esc(a.currentTask)}</div>` : ''}
        ${
          a.currentStep
            ? `<div class="step-line" title="${esc(a.currentStep)}">
                 ${a.status === 'working' ? '<span class="step-pulse"></span>' : ''}
                 <span>${esc(a.currentStep)}</span>
               </div>`
            : ''
        }
      </div>

      ${decisionHtml}
      ${fnBarHtml}
      ${logHtml}
    </article>`;
}

function renderFunctionBar(a) {
  const s = state.settings || {};
  if (s.showFunctionBar === false) return '';
  const fns = (s.customFunctions || []).filter((f) => f.pinned !== false);
  const chips = fns
    .map(
      (f) =>
        `<button type="button" class="fn-chip" data-act="run-function" data-agent="${esc(a.id)}" data-fn="${esc(f.id)}" title="${esc(f.type.toUpperCase())}: ${esc(f.payload)}">
          <span class="fn-chip-icon">${esc(f.icon || '⚡')}</span>
          <span>${esc(f.label)}</span>
        </button>`
    )
    .join('');

  return `
    <div class="card-fn-bar">
      ${chips}
      <button type="button" class="fn-chip fn-chip-add" data-act="open-settings" title="Add or customize functions">+ Function</button>
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
  $('#icon-sound-on').classList.toggle('hidden', !soundOn);
  $('#icon-sound-off').classList.toggle('hidden', soundOn);
}
syncSoundIcons();

// ---------------- Event Listeners ----------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest(
    '[data-act], [data-close], [data-copy-target], [data-copy-text], [data-settings-tab], [data-logo-choice], .filter-pill, .conn-tab'
  );
  if (!el) return;

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
    case 'open-connect':
      return $('#modal-connect').classList.remove('hidden');
    case 'open-settings':
      renderCustomFunctionsList();
      return $('#modal-settings').classList.remove('hidden');
    case 'run-function': {
      const fnId = el.dataset.fn;
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
  const n = state.network || {};
  $('#qr-container').innerHTML = state.qrSvg || '';
  $('#url-primary').textContent = n.pairingUrl || n.primaryProjectionUrl || location.origin;
  if (n.tailscaleUrl) {
    $('#tailscale-row').classList.remove('hidden');
    $('#url-tailscale').textContent = n.tailscalePairingUrl || n.tailscaleUrl;
  }
  $('#modal-project').classList.remove('hidden');
});

$('#btn-connect').addEventListener('click', () => $('#modal-connect').classList.remove('hidden'));
$('#btn-settings')?.addEventListener('click', () => {
  renderCustomFunctionsList();
  $('#modal-settings').classList.remove('hidden');
});
$('#brand-logo-trigger')?.addEventListener('click', () => {
  renderCustomFunctionsList();
  $('#modal-settings').classList.remove('hidden');
  $$('.settings-tab').forEach((t) => t.classList.toggle('active', t.dataset.settingsTab === 'appearance'));
  $('#settings-pane-functions')?.classList.add('hidden');
  $('#settings-pane-appearance')?.classList.remove('hidden');
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
          <span class="fn-item-icon">${esc(f.icon || '⚡')}</span>
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
  const icon = $('#fn-new-icon').value || '⚡';
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

$('#cfg-theme')?.addEventListener('change', (e) => saveSettingsPatch({ theme: e.target.value }));
$('#cfg-popup-mode')?.addEventListener('change', (e) => saveSettingsPatch({ popupMode: e.target.value }));
$('#cfg-dock-side')?.addEventListener('change', (e) => saveSettingsPatch({ dockSide: e.target.value }));
$('#cfg-panel-width')?.addEventListener('change', (e) => saveSettingsPatch({ panelWidth: Number(e.target.value) }));
$('#cfg-show-functions')?.addEventListener('change', (e) => saveSettingsPatch({ showFunctionBar: e.target.checked }));

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

$('#toggle-activity').addEventListener('click', () => {
  $('#activity-drawer').classList.toggle('hidden');
  $('#activity-chevron').classList.toggle('open');
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
