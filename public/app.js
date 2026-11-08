// InControl web client — shared by macOS side panel, desktop browser and phone PWA.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const DEVICE_NAME = detectDevice();
const STATUS_LABEL = {
  needs_input: 'Needs Input',
  needs_attention: 'Attention',
  working: 'Working',
  idle: 'Idle',
};
const SECTION_LABEL = {
  needs_input: '🔴 Needs your input',
  needs_attention: '🟠 Needs your attention',
  working: '🟢 Working — no action needed',
  idle: '⚪ Idle',
};

let state = { agents: [], counts: {}, simulatorActive: false, network: {}, globalEvents: [] };
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
  renderCounts();
  renderAgents();
  renderActivity();
  $('#btn-demo').classList.toggle('active', state.simulatorActive);
  detectNewInputRequests();
}

function renderCounts() {
  const c = state.counts || {};
  setCount('#count-all', c.total || 0);
  setCount('#count-input', c.needs_input || 0);
  setCount('#count-attention', c.needs_attention || 0);
  setCount('#count-working', c.working || 0);

  const pill = $('#urgent-pill');
  if (c.needs_input > 0) {
    pill.textContent = `${c.needs_input} need input`;
    pill.classList.remove('hidden');
  } else {
    pill.classList.add('hidden');
  }
  const urgent = (c.needs_input || 0) + (c.needs_attention || 0);
  document.title = urgent > 0 ? `(${urgent}) InControl` : 'InControl — Agent Side Panel';
}

function setCount(sel, n) {
  const el = $(sel);
  el.textContent = n;
  el.classList.toggle('nonzero', n > 0);
}

function renderAgents() {
  const list = $('#agent-list');

  // Preserve focus + caret on reply input across re-renders
  const active = document.activeElement;
  const focusedAgent = active?.dataset?.replyFor;
  const caret = focusedAgent ? active.selectionStart : null;

  const agents = state.agents.filter((a) => filter === 'all' || a.status === filter);

  if (state.agents.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="big">🛰️</div>
        <h3>No agents connected yet</h3>
        <p>Connect Claude Code, Antigravity, Cursor, CLI agents or your own custom agents — or start the interactive demo.</p>
        <div class="row">
          <button class="action-btn primary" data-act="open-connect">+ Connect agent</button>
          <button class="action-btn" data-act="start-demo">Start demo</button>
        </div>
      </div>`;
    return;
  }

  if (agents.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="big">✅</div><h3>All clear</h3><p>Nothing in this category.</p></div>`;
    return;
  }

  let html = '';
  let currentSection = null;
  for (const agent of agents) {
    if (filter === 'all' && agent.status !== currentSection) {
      currentSection = agent.status;
      html += `<div class="section-label">${SECTION_LABEL[agent.status] || agent.status}</div>`;
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
  const initials = providerInitials(a.provider, a.name);
  const p = a.pendingPrompt;
  const updated = timeAgo(a.metrics?.updatedAt);

  let body = `
    <div class="card-task">${esc(a.currentTask || '')}</div>
    ${a.currentStep ? `<div class="card-step" title="${esc(a.currentStep)}">› ${esc(a.currentStep)}</div>` : ''}
  `;

  if (a.status === 'needs_input' && p) {
    const opts = (p.options || [])
      .map(
        (o) =>
          `<button class="action-btn ${esc(o.style || '')}" data-act="respond" data-agent="${esc(a.id)}" data-action="${esc(o.id)}">${esc(o.label)}</button>`
      )
      .join('');
    body += `
      <div class="prompt-box">
        ${p.toolName ? `<div class="prompt-tool">${esc(p.toolName)}</div>` : ''}
        <div class="prompt-question">${esc(p.question)}</div>
        ${p.details ? `<div class="prompt-details">${esc(p.details)}</div>` : ''}
        ${p.command ? `<pre class="prompt-command">${esc(p.command)}</pre>` : ''}
        <div class="prompt-wait">Waiting ${timeAgo(p.createdAt, true)}</div>
        <div class="prompt-options">${opts}</div>
        ${
          p.allowFreeText !== false
            ? `<form class="reply-row" data-act="reply-form" data-agent="${esc(a.id)}">
                 <input class="reply-input" data-reply-for="${esc(a.id)}" placeholder="Reply or give instructions…" value="${esc(draftReplies.get(a.id) || '')}" autocomplete="off" />
                 <button type="submit" class="send-btn">Send</button>
               </form>`
            : ''
        }
      </div>`;
  } else if (a.status === 'needs_attention') {
    body += `
      ${a.attentionReason ? `<div class="attention-reason">${esc(a.attentionReason)}</div>` : ''}
      <form class="reply-row" data-act="reply-form" data-agent="${esc(a.id)}">
        <input class="reply-input" data-reply-for="${esc(a.id)}" placeholder="Send a follow-up…" value="${esc(draftReplies.get(a.id) || '')}" autocomplete="off" />
        <button type="submit" class="send-btn">Send</button>
      </form>`;
  }

  if (expandedLogs.has(a.id) && a.logs?.length) {
    body += `<ul class="log-list">${a.logs
      .slice(0, 8)
      .map((l) => `<li><span class="t">${clock(l.timestamp)}</span>${esc(l.message)}</li>`)
      .join('')}</ul>`;
  }

  return `
    <article class="agent-card status-${a.status}" data-id="${esc(a.id)}">
      <div class="card-head">
        <div class="card-identity">
          <div class="provider-avatar provider-${esc(a.provider)}">${initials}</div>
          <div class="card-titles">
            <div class="agent-name">${esc(a.name)} · ${esc(a.projectName)}</div>
            <div class="agent-meta">${esc(a.ide)}${a.branch ? ` · <span class="branch">${esc(a.branch)}</span>` : ''}</div>
          </div>
        </div>
        <span class="status-badge badge-${a.status}"><span class="dot dot-${a.status === 'needs_input' ? 'input' : a.status === 'needs_attention' ? 'attention' : a.status}"></span>${STATUS_LABEL[a.status] || a.status}</span>
      </div>
      ${body}
      <div class="card-footer">
        <span class="footer-meta">${a.metrics?.toolsRun || 0} tools · updated ${updated}</span>
        <div class="footer-actions">
          ${a.status === 'needs_attention' ? `<button class="ghost-btn" data-act="respond" data-agent="${esc(a.id)}" data-action="dismiss">✓ Done</button>` : ''}
          <button class="ghost-btn" data-act="toggle-log" data-agent="${esc(a.id)}">${expandedLogs.has(a.id) ? 'Hide log' : 'Log'}</button>
          <button class="ghost-btn" data-act="focus" data-agent="${esc(a.id)}" title="Bring the IDE / terminal window to front (macOS)">↗ Jump</button>
        </div>
      </div>
    </article>`;
}

function renderActivity() {
  const events = state.globalEvents || [];
  if (events[0]) {
    $('#last-event-preview').textContent = `${events[0].agentName}: ${events[0].message}`;
  }
  $('#activity-log').innerHTML = events
    .map(
      (e) =>
        `<li><span class="t">${clock(e.timestamp)}</span><strong>${esc(e.agentName)}</strong> · ${esc(e.message)}</li>`
    )
    .join('');
}

// ---------------- Notifications ----------------
function detectNewInputRequests() {
  const now = new Set(state.agents.filter((a) => a.status === 'needs_input').map((a) => a.pendingPrompt?.requestId || a.id));
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
      g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.3);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.32);
    });
  } catch {}
}

// ---------------- Event wiring ----------------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act], [data-close], [data-copy-target], [data-copy-text], .triage-tab, .conn-tab');
  if (!el) return;

  if (el.classList.contains('triage-tab')) {
    $$('.triage-tab').forEach((t) => t.classList.remove('active'));
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
      return respond(agentId, el.dataset.action);
    case 'focus':
      return focusAgent(agentId);
    case 'toggle-log':
      expandedLogs.has(agentId) ? expandedLogs.delete(agentId) : expandedLogs.add(agentId);
      return renderAgents();
    case 'open-connect':
      return $('#modal-connect').classList.remove('hidden');
    case 'start-demo':
      return toggleDemo();
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
  $('#url-primary').textContent = n.primaryProjectionUrl || location.origin;
  if (n.tailscaleUrl) {
    $('#tailscale-row').classList.remove('hidden');
    $('#url-tailscale').textContent = n.tailscaleUrl;
  }
  $('#modal-project').classList.remove('hidden');
});

$('#btn-connect').addEventListener('click', () => $('#modal-connect').classList.remove('hidden'));
$('#btn-demo').addEventListener('click', toggleDemo);

$('#btn-sound').addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('incontrol.sound', soundOn ? 'on' : 'off');
  $('#sound-icon').textContent = soundOn ? '🔔' : '🔕';
  if (soundOn) chime();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
});
$('#sound-icon').textContent = soundOn ? '🔔' : '🔕';

$('#toggle-activity').addEventListener('click', (e) => {
  if (e.target.closest('#btn-sim-prompt')) return;
  $('#activity-drawer').classList.toggle('hidden');
  $('#activity-chevron').classList.toggle('open');
});

$('#btn-sim-prompt').addEventListener('click', async (e) => {
  e.stopPropagation();
  await fetch('/api/simulator/trigger-prompt', { method: 'POST' });
});

$('#btn-fire-custom').addEventListener('click', async () => {
  fetch('/api/agents/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'custom-deploybot',
      name: 'DeployBot',
      provider: 'custom',
      ide: 'Python SDK',
      workspace: '/repo/backend',
      wait: false,
      question: 'Approve production Kubernetes rollout?',
      command: 'kubectl rollout restart deployment/api',
      options: [
        { id: 'approve', label: 'Rollout Now', style: 'primary' },
        { id: 'deny', label: 'Abort', style: 'danger' },
      ],
    }),
  });
  $('#modal-connect').classList.add('hidden');
  toast('Custom agent event sent');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal-backdrop').forEach((m) => m.classList.add('hidden'));
});

async function toggleDemo() {
  await fetch('/api/simulator/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
}

// Re-render relative timestamps every 15s
setInterval(() => {
  if (!document.activeElement?.dataset?.replyFor) renderAgents();
}, 15000);

// ---------------- Helpers ----------------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function cssEscape(s) {
  return window.CSS?.escape ? CSS.escape(s) : s.replace(/"/g, '\\"');
}
function providerInitials(provider, name) {
  const map = { 'claude-code': 'CC', antigravity: 'AG', cursor: 'Cu', codex: 'Cx', aider: 'Ai', opencode: 'OC', vscode: 'VS', windsurf: 'WS', custom: '⚙' };
  return map[provider] || (name || '?').slice(0, 2);
}
function timeAgo(ts, short = false) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return short ? 'just now' : 'just now';
  if (s < 60) return `${s}s${short ? '' : ' ago'}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m${short ? '' : ' ago'}`;
  return `${Math.round(m / 60)}h${short ? '' : ' ago'}`;
}
function clock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function copy(text) {
  navigator.clipboard?.writeText(text.trim()).then(() => toast('Copied'), () => toast('Copy failed'));
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
  if (/InControlPanel/.test(ua)) return 'Mac Side Panel';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac Browser';
  return 'Browser';
}

connect();
