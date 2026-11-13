// InControl Apple HomeView Ambient Display

const $ = (sel) => document.querySelector(sel);

let demoMode =
  new URLSearchParams(location.search).get('demo') === '1' ||
  localStorage.getItem('incontrol.demo') === 'on';
const demoResolved = new Map();
let state = { agents: [], counts: {}, settings: {} };
let ws = null;
let reconnectMs = 600;

function demoIcon(bg1, bg2, glyph) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#g)"/>${glyph}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const DEMO_ICONS = {
  nova: demoIcon('#ff7a59', '#ff3d7f', '<path d="M18 40c6-14 22-14 28 0" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round"/><circle cx="32" cy="24" r="6" fill="#fff"/>'),
  atlas: demoIcon('#34c3ff', '#4a5cff', '<circle cx="32" cy="32" r="14" stroke="#fff" stroke-width="4.5" fill="none"/>'),
  orbit: demoIcon('#8e5cff', '#3b1fa8', '<circle cx="32" cy="32" r="7" fill="#fff"/>'),
  pulse: demoIcon('#2fe08a', '#0b9e6a', '<path d="M12 34h10l5-12 8 22 5-10h12" stroke="#fff" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'),
};

function applyDemo(real) {
  const now = Date.now();
  const base = [
    {
      id: 'demo-nova',
      name: 'Claude Code',
      ide: 'Terminal',
      projectName: 'Nova Checkout',
      branch: 'feat/stripe-v3',
      status: 'needs_input',
      currentTask: 'Migrate payments to Stripe API v3',
      currentStep: 'Waiting for approval to run migration',
      pendingPrompt: {
        question: 'Allow Claude to run the database migration on staging?',
        command: 'npm run db:migrate -- --env=staging',
        options: [
          { id: 'approve', label: 'Approve', style: 'primary' },
          { id: 'deny', label: 'Deny', style: 'danger' },
        ],
      },
      toolIconUrl: '/api/icons/tool/claude',
      projectIconUrl: DEMO_ICONS.nova,
    },
    {
      id: 'demo-atlas',
      name: 'ChatGPT / Codex',
      ide: 'ChatGPT App',
      projectName: 'Atlas Mobile',
      branch: 'release/2.4',
      status: 'needs_input',
      currentTask: 'Prepare iOS release 2.4.0',
      currentStep: 'Waiting for confirmation',
      pendingPrompt: {
        question: 'Confirm uploading build 2.4.0 (312) to TestFlight?',
        details: 'All 148 tests pass.',
        options: [
          { id: 'quick_reply', label: 'Confirm Upload', style: 'primary', replyText: 'Confirmed, upload it.' },
          { id: 'dismiss', label: 'Not now', style: 'secondary' },
        ],
      },
      toolIconUrl: '/api/icons/tool/chatgpt',
      projectIconUrl: DEMO_ICONS.atlas,
    },
    {
      id: 'demo-orbit',
      name: 'Antigravity',
      ide: 'Antigravity',
      projectName: 'Orbit Analytics',
      branch: 'design/dashboard-v2',
      status: 'needs_attention',
      currentStep: 'Dashboard redesign finished — ready for review',
      attentionReason: 'Dashboard redesign finished — ready for your review',
      toolIconUrl: '/api/icons/tool/antigravity',
      projectIconUrl: DEMO_ICONS.orbit,
    },
    {
      id: 'demo-pulse',
      name: 'Cursor',
      ide: 'Cursor',
      projectName: 'Pulse API',
      branch: 'refactor/auth',
      status: 'working',
      currentStep: 'Editing src/middleware/auth.ts',
      toolIconUrl: '/api/icons/tool/cursor',
      projectIconUrl: DEMO_ICONS.pulse,
    },
  ].map((a) => {
    const r = demoResolved.get(a.id);
    return r ? { ...a, ...r, pendingPrompt: null } : a;
  });

  const counts = { total: base.length, needs_input: 0, needs_attention: 0, working: 0, idle: 0 };
  for (const a of base) counts[a.status] = (counts[a.status] || 0) + 1;
  return { ...real, agents: base, counts, serverTime: now };
}

function updateClock() {
  const now = new Date();
  $('#hv-time').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#hv-date').textContent = `${now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })} · Apple HomeView`;
}
updateClock();
setInterval(updateClock, 10_000);

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    reconnectMs = 600;
  };
  ws.onclose = () => {
    setTimeout(connect, reconnectMs);
    reconnectMs = Math.min(reconnectMs * 2, 8000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state_sync') {
      state = demoMode ? applyDemo(msg.state) : msg.state;
      render();
    }
  };
}

async function respond(agentId, action, replyText = '') {
  if (demoMode) {
    if (action === 'dismiss' || action === 'deny') {
      demoResolved.set(agentId, { status: 'idle', currentStep: 'Idle' });
    } else {
      demoResolved.set(agentId, { status: 'working', currentStep: 'Continuing after your approval…' });
    }
    state = applyDemo(state);
    render();
    showToast(`Sent: ${action} (demo)`);
    return;
  }
  await fetch(`/api/agents/${encodeURIComponent(agentId)}/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: replyText ? 'reply' : action,
      text: replyText || '',
      sourceDevice: 'Apple HomeView',
    }),
  });
  showToast(replyText ? 'Confirmation sent' : `Sent: ${action}`);
}

function avatarHtml(a, cls = 'hv-avatar-wrap') {
  const mainSrc = a.projectIconUrl || a.toolIconUrl || '/api/icons/tool/codex';
  const showBadge = Boolean(a.projectIconUrl && a.toolIconUrl);
  if (cls === 'hv-fleet-avatar') {
    return `<div class="hv-fleet-avatar">
      <img class="main" src="${esc(mainSrc)}" alt="" />
      ${showBadge ? `<img class="badge" src="${esc(a.toolIconUrl)}" alt="" />` : ''}
    </div>`;
  }
  return `<div class="hv-avatar-wrap">
    <img class="hv-avatar-main" src="${esc(mainSrc)}" alt="${esc(a.projectName)}" />
    ${showBadge ? `<img class="hv-avatar-badge" src="${esc(a.toolIconUrl)}" alt="${esc(a.name)}" />` : ''}
  </div>`;
}

function render() {
  const agents = state.agents || [];
  const counts = state.counts || {};
  const waiting = agents.filter((a) => a.status === 'needs_input');
  const review = agents.filter((a) => a.status === 'needs_attention');

  $('#hv-demo-btn')?.classList.toggle('active', demoMode);

  const pill = $('#hv-pill');
  const pillText = $('#hv-pill-text');
  if (waiting.length > 0) {
    document.body.dataset.state = 'urgent';
    pill.className = 'hv-pill urgent';
    pillText.textContent = `${waiting.length} Waiting for Input`;
  } else if (review.length > 0) {
    document.body.dataset.state = 'review';
    pill.className = 'hv-pill review';
    pillText.textContent = `${review.length} Ready for Review`;
  } else if ((counts.working || 0) > 0) {
    document.body.dataset.state = 'working';
    pill.className = 'hv-pill calm';
    pillText.textContent = `${counts.working} Agents Active`;
  } else {
    document.body.dataset.state = 'idle';
    pill.className = 'hv-pill calm';
    pillText.textContent = 'All Clear';
  }

  const spotlight = [...waiting, ...review];
  const primaryEl = $('#hv-primary');
  if (spotlight.length === 0) {
    primaryEl.innerHTML = `
      <div class="hv-calm-card">
        <div class="hv-calm-title">All Agents Running Smoothly</div>
        <div class="hv-calm-sub">${
          (counts.working || 0) > 0
            ? `${counts.working} active ${counts.working === 1 ? 'agent is' : 'agents are'} working in the background. Prompts appear here automatically.`
            : 'No pending approvals right now.'
        }</div>
      </div>`;
  } else {
    primaryEl.innerHTML = spotlight
      .map((a) => {
        const p = a.pendingPrompt;
        const buttons = p
          ? (p.options || [])
              .map(
                (o) =>
                  `<button class="hv-btn ${esc(o.style || '')}" data-act="respond" data-agent="${esc(a.id)}" data-action="${esc(o.id)}" ${o.replyText ? `data-reply-text="${esc(o.replyText)}"` : ''}>${esc(o.label)}</button>`
              )
              .join('')
          : `<button class="hv-btn primary" data-act="respond" data-agent="${esc(a.id)}" data-action="dismiss">Mark Reviewed</button>`;

        return `
          <article class="hv-spot-card status-${esc(a.status)}">
            <div class="hv-card-head">
              ${avatarHtml(a)}
              <div class="hv-card-meta">
                <div class="hv-project">${esc(a.projectName)}</div>
                <div class="hv-sub">${esc(a.name)} · ${esc(a.ide)}${a.branch ? ` · ${esc(a.branch)}` : ''}</div>
              </div>
            </div>
            <div class="hv-question">${esc(p?.question || a.attentionReason || a.currentStep || 'Ready for review')}</div>
            ${p?.details ? `<div class="hv-details">${esc(p.details)}</div>` : ''}
            ${p?.command ? `<pre class="hv-code">${esc(p.command)}</pre>` : ''}
            <div class="hv-actions">${buttons}</div>
          </article>`;
      })
      .join('');
  }

  const fleetEl = $('#hv-fleet');
  if (agents.length === 0) {
    fleetEl.innerHTML = `<div class="hv-fleet-step">Waiting for agent sessions…</div>`;
  } else {
    fleetEl.innerHTML = agents
      .map(
        (a) => `
        <div class="hv-fleet-item">
          ${avatarHtml(a, 'hv-fleet-avatar')}
          <div class="hv-fleet-info">
            <div class="hv-fleet-name">${esc(a.projectName)}</div>
            <div class="hv-fleet-step">${esc(a.currentStep || a.status)}</div>
          </div>
        </div>`
      )
      .join('');
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act="respond"]');
  if (btn) {
    respond(btn.dataset.agent, btn.dataset.action, btn.dataset.replyText || '');
  }
});

$('#hv-demo-btn')?.addEventListener('click', () => {
  demoMode = !demoMode;
  localStorage.setItem('incontrol.demo', demoMode ? 'on' : 'off');
  if (demoMode) {
    state = applyDemo(state);
  } else {
    fetch('/api/state')
      .then((r) => r.json())
      .then((s) => {
        state = s;
        render();
      })
      .catch(() => {});
  }
  render();
});

function showToast(msg) {
  const el = $('#hv-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 2400);
}

function esc(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

if (demoMode) {
  state = applyDemo(state);
  render();
}
connect();
