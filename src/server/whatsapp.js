import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import querystring from 'node:querystring';

const CONFIG_DIR = process.env.INCONTROL_HOME || path.join(os.homedir(), '.incontrol');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_WHATSAPP_CONFIG = {
  enabled: false,
  timeoutSec: 60,
  notifyOnAttention: false,
  provider: 'callmebot', // 'callmebot' | 'twilio' | 'cloud_api' | 'webhook'
  phone: '',
  callmebotApiKey: '',
  twilioSid: '',
  twilioToken: '',
  twilioFrom: 'whatsapp:+14155238886',
  cloudPhoneId: '',
  cloudToken: '',
  webhookUrl: '',
};

/**
 * Load WhatsApp escalation config from ~/.incontrol/config.json.
 */
export function loadWhatsAppConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULT_WHATSAPP_CONFIG, ...(raw.whatsapp || {}) };
  } catch {
    return { ...DEFAULT_WHATSAPP_CONFIG };
  }
}

/**
 * Save WhatsApp escalation config into ~/.incontrol/config.json.
 */
export function saveWhatsAppConfig(patch = {}) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}

  const current = { ...DEFAULT_WHATSAPP_CONFIG, ...(raw.whatsapp || {}) };
  const updated = {
    ...current,
    ...patch,
    enabled: Boolean(patch.enabled ?? current.enabled),
    timeoutSec: Math.max(10, Math.min(3600, Number(patch.timeoutSec ?? current.timeoutSec ?? 60))),
    notifyOnAttention: Boolean(patch.notifyOnAttention ?? current.notifyOnAttention),
  };

  raw.whatsapp = updated;
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(raw, null, 2), { mode: 0o600 });
  return updated;
}

/**
 * Return a UI-safe summary of the WhatsApp configuration.
 */
export function getPublicWhatsAppStatus() {
  const cfg = loadWhatsAppConfig();
  const isConfigured = isProviderConfigured(cfg);
  return {
    enabled: cfg.enabled && isConfigured,
    configured: isConfigured,
    timeoutSec: cfg.timeoutSec,
    notifyOnAttention: cfg.notifyOnAttention,
    provider: cfg.provider,
    phone: cfg.phone,
    callmebotApiKey: cfg.callmebotApiKey ? '••••••••' : '',
    twilioSid: cfg.twilioSid,
    twilioToken: cfg.twilioToken ? '••••••••' : '',
    twilioFrom: cfg.twilioFrom,
    cloudPhoneId: cfg.cloudPhoneId,
    cloudToken: cfg.cloudToken ? '••••••••' : '',
    webhookUrl: cfg.webhookUrl,
  };
}

function isProviderConfigured(cfg) {
  if (!cfg.phone && cfg.provider !== 'webhook') return false;
  switch (cfg.provider) {
    case 'callmebot':
      return Boolean(cfg.phone && cfg.callmebotApiKey);
    case 'twilio':
      return Boolean(cfg.phone && cfg.twilioSid && cfg.twilioToken);
    case 'cloud_api':
      return Boolean(cfg.phone && cfg.cloudPhoneId && cfg.cloudToken);
    case 'webhook':
      return Boolean(cfg.webhookUrl);
    default:
      return false;
  }
}

/**
 * Watches the AgentStore for unanswered `needs_input` (and optionally `needs_attention`) states.
 * If the user does not respond within `timeoutSec`, escalates to WhatsApp automatically.
 */
export function setupWhatsAppEscalation(store, getPairingUrl) {
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map();
  /** @type {Set<string>} */
  const sentKeys = new Set();

  function evaluateAgents() {
    const cfg = loadWhatsAppConfig();
    if (!cfg.enabled || !isProviderConfigured(cfg)) {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      return;
    }

    const activeKeys = new Set();

    for (const agent of store.agents.values()) {
      const shouldEscalate =
        agent.status === 'needs_input' ||
        (cfg.notifyOnAttention && agent.status === 'needs_attention');

      if (!shouldEscalate) continue;

      const promptId =
        agent.pendingPrompt?.requestId ||
        `${agent.status}_${agent.currentStep || ''}_${agent.attentionReason || ''}`;
      const key = `${agent.id}::${promptId}`;
      activeKeys.add(key);

      if (sentKeys.has(key) || timers.has(key)) continue;

      const delayMs = Math.max(10, Number(cfg.timeoutSec || 60)) * 1000;
      const timer = setTimeout(async () => {
        timers.delete(key);
        const latestAgent = store.agents.get(agent.id);
        if (!latestAgent) return;
        const stillWaiting =
          latestAgent.status === 'needs_input' ||
          (cfg.notifyOnAttention && latestAgent.status === 'needs_attention');
        if (!stillWaiting) return;

        sentKeys.add(key);
        const pairingUrl = typeof getPairingUrl === 'function' ? getPairingUrl() : '';
        const text = formatEscalationMessage(latestAgent, pairingUrl, cfg.timeoutSec);

        try {
          await dispatchWhatsAppMessage(cfg, text, latestAgent);
          store._appendLog(latestAgent, {
            type: 'whatsapp',
            message: `Escalated to WhatsApp (${cfg.phone || cfg.provider}) after ${cfg.timeoutSec}s without reply`,
            timestamp: Date.now(),
          });
          store.emit('change', {
            type: 'whatsapp_escalated',
            agent: store.serializeAgent(latestAgent),
          });
        } catch (err) {
          store._appendLog(latestAgent, {
            type: 'error',
            message: `WhatsApp escalation failed: ${err.message}`,
            timestamp: Date.now(),
          });
        }
      }, delayMs);

      timer.unref?.();
      timers.set(key, timer);
    }

    // Cancel timers for agents that were answered or changed state
    for (const [key, timer] of timers.entries()) {
      if (!activeKeys.has(key)) {
        clearTimeout(timer);
        timers.delete(key);
      }
    }
  }

  store.on('change', evaluateAgents);
  store.on('notification', evaluateAgents);

  return () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  };
}

function formatEscalationMessage(agent, pairingUrl, timeoutSec) {
  const isInput = agent.status === 'needs_input';
  const badge = isInput ? '🔴 NEEDS YOUR INPUT' : '🟠 READY FOR REVIEW';
  const promptText =
    agent.pendingPrompt?.question ||
    agent.attentionReason ||
    agent.currentStep ||
    agent.currentTask ||
    'Agent is waiting for you.';
  const cmdLine = agent.pendingPrompt?.command ? `\nCommand: \`${agent.pendingPrompt.command}\`` : '';
  const linkLine = pairingUrl ? `\n\nRespond in 1 tap:\n${pairingUrl}` : '';

  return (
    `*InControl · ${badge}*\n` +
    `Agent: *${agent.name}* (${agent.projectName})\n` +
    `Waiting ${timeoutSec}s: ${promptText}${cmdLine}` +
    `\n\nReply *1* to Approve, *2* to Deny, or type instructions.${linkLine}`
  );
}

/**
 * Send a WhatsApp message using the configured provider.
 */
export async function dispatchWhatsAppMessage(cfg, text, agent = null) {
  const cleanPhone = String(cfg.phone || '').replace(/[^\d+]/g, '');

  if (cfg.provider === 'callmebot') {
    const phoneDigits = cleanPhone.replace(/^\+/, '');
    const url =
      `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phoneDigits)}` +
      `&text=${encodeURIComponent(text)}` +
      `&apikey=${encodeURIComponent(cfg.callmebotApiKey)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`CallMeBot HTTP ${res.status}: ${body.slice(0, 120)}`);
    }
    return { ok: true, provider: 'callmebot' };
  }

  if (cfg.provider === 'twilio') {
    const to = cleanPhone.startsWith('whatsapp:') ? cleanPhone : `whatsapp:${cleanPhone.startsWith('+') ? cleanPhone : '+' + cleanPhone}`;
    const from = cfg.twilioFrom.startsWith('whatsapp:') ? cfg.twilioFrom : `whatsapp:${cfg.twilioFrom}`;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.twilioSid)}/Messages.json`;
    const auth = Buffer.from(`${cfg.twilioSid}:${cfg.twilioToken}`).toString('base64');
    const body = querystring.stringify({ To: to, From: from, Body: text });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Twilio HTTP ${res.status}: ${errText.slice(0, 140)}`);
    }
    return { ok: true, provider: 'twilio' };
  }

  if (cfg.provider === 'cloud_api') {
    const toDigits = cleanPhone.replace(/^\+/, '');
    const url = `https://graph.facebook.com/v21.0/${encodeURIComponent(cfg.cloudPhoneId)}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.cloudToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toDigits,
        type: 'text',
        text: { preview_url: false, body: text },
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`WhatsApp Cloud API HTTP ${res.status}: ${errText.slice(0, 140)}`);
    }
    return { ok: true, provider: 'cloud_api' };
  }

  if (cfg.provider === 'webhook') {
    let parsedWebhook;
    try {
      parsedWebhook = new URL(cfg.webhookUrl);
    } catch {
      throw new Error('Invalid webhook URL');
    }
    if (parsedWebhook.protocol !== 'http:' && parsedWebhook.protocol !== 'https:') {
      throw new Error('Webhook URL must use http: or https:');
    }
    const res = await fetch(parsedWebhook.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'incontrol',
        phone: cleanPhone,
        text,
        agent: agent
          ? {
              id: agent.id,
              name: agent.name,
              projectName: agent.projectName,
              status: agent.status,
              currentTask: agent.currentTask,
              currentStep: agent.currentStep,
              pendingPrompt: agent.pendingPrompt,
            }
          : null,
        timestamp: Date.now(),
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Webhook HTTP ${res.status}: ${errText.slice(0, 140)}`);
    }
    return { ok: true, provider: 'webhook' };
  }

  throw new Error(`Unsupported WhatsApp provider: ${cfg.provider}`);
}

/**
 * Handle an incoming WhatsApp reply (from Twilio webhook, Meta Cloud API, or custom bridge)
 * and route it to the most urgent waiting agent in InControl.
 */
export function handleIncomingWhatsAppReply(store, payload = {}) {
  // Extract message text from Twilio (`Body`), Meta Cloud API (`entry[0].changes[0].value.messages[0].text.body`), or generic JSON (`text` / `message`)
  const metaMsg =
    payload?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body || null;
  const rawText = String(
    payload.Body ?? payload.text ?? payload.message ?? metaMsg ?? ''
  ).trim();

  if (!rawText) {
    return { ok: false, error: 'Empty WhatsApp reply body' };
  }

  // Find target agent: explicit `agentId`, or top priority agent (`needs_input` -> `needs_attention` -> `working` -> `idle`)
  let target = payload.agentId ? store.agents.get(payload.agentId) : null;
  if (!target) {
    const sorted = store.getSortedAgents();
    if (sorted.length > 0) {
      target = store.agents.get(sorted[0].id);
    }
  }

  if (!target) {
    return { ok: false, error: 'No active agents to receive WhatsApp reply' };
  }

  const lower = rawText.toLowerCase();
  let action = 'reply';
  let text = rawText;

  if (lower === '1' || lower === 'approve' || lower === 'yes' || lower === 'y' || lower === 'allow') {
    action = target.pendingPrompt?.options?.[0]?.id || 'approve';
    text = '';
  } else if (lower === '2' || lower === 'deny' || lower === 'no' || lower === 'n' || lower === 'reject') {
    action = target.pendingPrompt?.options?.[1]?.id || 'deny';
    text = '';
  } else if (lower === 'stop') {
    action = 'stop';
    text = '';
  }

  return store.respondToAgent(target.id, {
    action,
    text,
    sourceDevice: 'WhatsApp',
  });
}
