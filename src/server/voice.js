/**
 * Shared spoken-summary & voice-command helpers for Siri Shortcuts and Apple HomeView.
 */

const APPROVE_WORDS = new Set([
  'approve',
  'approved',
  'yes',
  'yeah',
  'yep',
  'ok',
  'okay',
  'confirm',
  'confirmed',
  'allow',
  'proceed',
  'continue',
  'go',
  'done',
]);

const DENY_WORDS = new Set(['deny', 'denied', 'no', 'nope', 'reject', 'cancel', 'stop', 'abort']);

const DISMISS_WORDS = new Set(['dismiss', 'ignore', 'skip', 'later', 'clear']);

/**
 * Picks the exact payload for Store.respondToAgent when a remote trigger (Siri / HomeKit / button)
 * approves, denies, or dismisses an agent.
 */
export function buildActionPayload(agent, decision, customText = '', sourceDevice = 'Siri') {
  if (decision === 'reply' && customText) {
    return { action: 'reply', text: customText, sourceDevice };
  }
  if (decision === 'approve') {
    const primary = (agent?.pendingPrompt?.options || []).find((o) => o.style === 'primary') ||
      (agent?.pendingPrompt?.options || [])[0];
    if (primary?.replyText) {
      return { action: 'reply', text: primary.replyText, sourceDevice };
    }
    if (primary?.id && primary.id !== 'approve') {
      return { action: primary.id, text: customText || primary.label || 'Approved', sourceDevice };
    }
    return { action: 'approve', text: customText || 'Approved', sourceDevice };
  }
  if (decision === 'deny') {
    return { action: 'deny', text: customText || 'Denied', sourceDevice };
  }
  if (decision === 'dismiss') {
    return { action: 'dismiss', text: customText || 'Dismissed', sourceDevice };
  }
  return { action: decision, text: customText, sourceDevice };
}

/**
 * Builds a concise spoken status summary for Siri / Apple HomeView.
 */
export function buildVoiceStatus(store, settings = {}) {
  const agents = store.getSortedAgents();
  const counts = store.getSummaryCounts();
  const waiting = agents.filter((a) => a.status === 'needs_input');
  const review = agents.filter((a) => a.status === 'needs_attention');
  const working = agents.filter((a) => a.status === 'working');

  let speech;
  if (waiting.length > 0) {
    const parts = waiting.slice(0, 3).map((a) => {
      const q = cleanForSpeech(a.pendingPrompt?.question || 'needs your input');
      return `${a.projectName} with ${a.name}: ${q}`;
    });
    const prefix =
      waiting.length === 1
        ? '1 agent needs your input.'
        : `${waiting.length} agents need your input.`;
    const suffix =
      review.length > 0
        ? ` Also, ${review.length} ${review.length === 1 ? 'task is' : 'tasks are'} ready for review.`
        : '';
    speech = `${prefix} ${parts.join(' Next, ')}${suffix}`;
  } else if (review.length > 0) {
    const names = review.slice(0, 3).map((a) => a.projectName).join(', ');
    speech = `${review.length} ${review.length === 1 ? 'project is' : 'projects are'} ready for review: ${names}.`;
  } else if (working.length > 0) {
    speech = `All clear. ${working.length} ${working.length === 1 ? 'agent is' : 'agents are'} actively working.`;
  } else if (counts.total > 0) {
    speech = `All clear. ${counts.total} ${counts.total === 1 ? 'agent is' : 'agents are'} idle.`;
  } else {
    speech = 'All clear. No active coding agents right now.';
  }

  return {
    ok: true,
    speech,
    counts,
    allowVoiceApproval: Boolean(settings.allowVoiceApproval),
    waiting: waiting.map((a) => ({
      id: a.id,
      name: a.name,
      projectName: a.projectName,
      question: a.pendingPrompt?.question || '',
      command: a.pendingPrompt?.command || null,
    })),
    review: review.map((a) => ({
      id: a.id,
      name: a.name,
      projectName: a.projectName,
      reason: a.attentionReason || 'Task finished',
    })),
  };
}

/**
 * Handles a Siri / voice command (`approve`, `deny`, `dismiss`, or freeform `reply`).
 * Enforces `settings.allowVoiceApproval` (default false) before mutating any agent state.
 */
export function handleVoiceRespond(store, settings = {}, body = {}) {
  if (!settings.allowVoiceApproval) {
    return {
      status: 403,
      ok: false,
      error: 'Voice approvals are disabled in InControl settings.',
      speech:
        'Voice approvals are currently turned off in InControl. Open Apple Home settings to allow them.',
    };
  }

  const rawText = String(body.text || body.command || '').trim();
  const rawDecision = String(body.decision || body.action || '').trim().toLowerCase();
  const normalizedWord = (rawDecision || rawText).toLowerCase().replace(/[.!?]+$/, '');

  let intent = 'reply';
  if (APPROVE_WORDS.has(normalizedWord)) intent = 'approve';
  else if (DENY_WORDS.has(normalizedWord)) intent = 'deny';
  else if (DISMISS_WORDS.has(normalizedWord)) intent = 'dismiss';
  else if (!rawDecision && !rawText) intent = 'approve';

  const target = pickTargetAgent(store, {
    agentId: body.agentId,
    project: body.project,
    preferWaiting: intent !== 'reply',
  });

  if (!target) {
    return {
      status: 404,
      ok: false,
      error: 'No matching agent is waiting for input.',
      speech: 'There are no agents waiting for your response right now.',
    };
  }

  const payload = buildActionPayload(
    target,
    intent,
    intent === 'reply' ? rawText : '',
    body.sourceDevice || 'Siri'
  );
  const res = store.respondToAgent(target.id, payload);
  if (!res.ok) {
    return {
      status: 404,
      ok: false,
      error: res.error || 'Could not deliver response',
      speech: `Could not reach ${target.projectName}.`,
    };
  }

  const verb =
    intent === 'approve'
      ? 'Approved'
      : intent === 'deny'
        ? 'Denied'
        : intent === 'dismiss'
          ? 'Dismissed'
          : 'Sent reply to';

  return {
    status: 200,
    ok: true,
    action: payload.action,
    agentId: target.id,
    projectName: target.projectName,
    speech: `${verb} ${target.projectName}.`,
  };
}

/**
 * Picks either a specific agent by ID/project or the oldest waiting (`needs_input`) agent.
 */
export function pickTargetAgent(store, { agentId, project, preferWaiting = true } = {}) {
  const agents = Array.from(store.agents.values());
  if (agentId) {
    return store.agents.get(agentId) || null;
  }
  if (project) {
    const q = String(project).trim().toLowerCase();
    const match = agents.find(
      (a) =>
        a.projectName.toLowerCase() === q ||
        a.projectName.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q)
    );
    if (match) return match;
  }

  const waiting = agents
    .filter((a) => a.status === 'needs_input')
    .sort((a, b) => (a.metrics?.updatedAt || 0) - (b.metrics?.updatedAt || 0));
  if (waiting.length > 0) return waiting[0];

  if (!preferWaiting) {
    const active = agents.sort((a, b) => (b.metrics?.updatedAt || 0) - (a.metrics?.updatedAt || 0));
    return active[0] || null;
  }
  return null;
}

function cleanForSpeech(str) {
  return String(str || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}
