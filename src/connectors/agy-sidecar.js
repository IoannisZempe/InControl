import { execFile } from 'node:child_process';
import WebSocket from 'ws';

const DEFAULT_HUB_URL = process.env.INCONTROL_URL || 'http://127.0.0.1:4747';

function toWebSocketUrl(hubUrl) {
  const parsed = new URL(hubUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = '/ws';
  parsed.search = '';
  return parsed.toString();
}

export function formatSidecarPrompt({ text, action, sourceDevice }) {
  const cleanText = String(text || '').trim();
  const device = String(sourceDevice || 'Panel').trim() || 'Panel';
  if (cleanText) {
    return `[From InControl (${device})]: ${cleanText}`;
  }
  if (action === 'approve' || action === 'yes') {
    return `[From InControl (${device})]: Approved, please proceed.`;
  }
  return '';
}

export function checkAgentApiAvailable(execFileFn = execFile) {
  return new Promise((resolve) => {
    execFileFn('which', ['agentapi'], { timeout: 2500 }, (err, stdout = '') => {
      resolve(!err && Boolean(String(stdout || '').trim()));
    });
  });
}

export function sendMessageViaAgentApi(
  { conversationId, prompt },
  { execFileFn = execFile, timeoutMs = 15_000 } = {}
) {
  return new Promise((resolve) => {
    if (!conversationId || !prompt) {
      return resolve({ ok: false, error: 'Missing conversationId or prompt' });
    }
    execFileFn(
      'agentapi',
      ['send-message', String(conversationId), String(prompt)],
      { timeout: timeoutMs },
      (err, stdout = '', stderr = '') => {
        if (err) {
          const detail = String(stderr || stdout || err.message || 'agentapi failed').trim();
          return resolve({ ok: false, error: detail, stdout: String(stdout || ''), stderr: String(stderr || '') });
        }
        resolve({ ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() });
      }
    );
  });
}

/**
 * Long-running Antigravity sidecar bridge (`incontrol sidecar agy`).
 * Connects to the local InControl Hub over WebSocket and delivers remote
 * messages immediately into idle or active Antigravity conversations via `agentapi send-message`.
 */
export async function runAgySidecar(
  _args = [],
  {
    hubUrl = process.env.INCONTROL_URL || DEFAULT_HUB_URL,
    token = process.env.INCONTROL_TOKEN || '',
    WebSocketClass = WebSocket,
    execFileFn = execFile,
    checkAgentApiFn = checkAgentApiAvailable,
    logger = console,
    reconnectBaseMs = 1000,
    reconnectMaxMs = 10_000,
  } = {}
) {
  const wsUrl = toWebSocketUrl(hubUrl);
  const hasAgentApi = await checkAgentApiFn(execFileFn);
  let stopped = false;
  let ws = null;
  let reconnectTimer = null;
  let pingTimer = null;
  let attempt = 0;

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * Math.pow(2, Math.min(attempt, 4)));
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    reconnectTimer.unref?.();
  }

  function clearPing() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function connect() {
    if (stopped) return;
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    try {
      ws = new WebSocketClass(wsUrl, { headers });
    } catch (err) {
      logger.error?.(`[incontrol-sidecar] WebSocket init error: ${err.message}`);
      scheduleReconnect();
      return;
    }

    ws.on('open', () => {
      attempt = 0;
      ws.send(
        JSON.stringify({
          type: 'register_bridge',
          provider: 'antigravity',
          hasAgentApi,
          pid: process.pid,
        })
      );
      clearPing();
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === 1) {
          try {
            ws.ping?.();
          } catch {}
        }
      }, 25_000);
      pingTimer.unref?.();
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type !== 'deliver_message') return;

      const { deliveryId, agentId, conversationId, text, action, sourceDevice } = msg;
      const prompt = formatSidecarPrompt({ text, action, sourceDevice });
      const result = await sendMessageViaAgentApi(
        { conversationId, prompt },
        { execFileFn }
      );

      if (ws && ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: 'bridge_result',
            deliveryId,
            agentId,
            ok: result.ok,
            error: result.error || null,
          })
        );
      }
    });

    ws.on('close', () => {
      clearPing();
      ws = null;
      scheduleReconnect();
    });

    ws.on('error', () => {
      // Handled by 'close' event reconnect
    });
  }

  connect();

  const stop = () => {
    stopped = true;
    clearPing();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      ws?.close?.();
    } catch {}
    ws = null;
  };

  return { stop, hasAgentApi, wsUrl };
}
