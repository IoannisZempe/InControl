import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { AgentStore } from './store.js';
import { focusAgentWindow, sendMacNotification } from './macos-focus.js';
import {
  startAutoWatcher,
  getIntegrationsStatus,
  installIntegration,
} from '../connectors/auto-watcher.js';
import {
  setupWhatsAppEscalation,
  getPublicWhatsAppStatus,
  loadWhatsAppConfig,
  saveWhatsAppConfig,
  dispatchWhatsAppMessage,
  handleIncomingWhatsAppReply,
} from './whatsapp.js';
import {
  loadUserSettings,
  saveUserSettings,
  executeCustomFunction,
} from './settings.js';
import {
  getToolIconAsset,
  findProjectIconPath,
} from './icons.js';
import {
  loadOrCreateToken,
  checkOrigin,
  isAuthorized,
  safeEqual,
  buildAllowedHosts,
  sessionCookie,
  UNAUTHORIZED_HTML,
} from './auth.js';

// Static files that may be served before pairing (no secrets in them).
const PUBLIC_ASSETS = new Set(['/manifest.json', '/styles.css', '/app.js', '/icon.svg']);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../../public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * Discover LAN and Tailscale IPv4 addresses for cross-device projection.
 */
export function discoverNetworkUrls(port) {
  const interfaces = os.networkInterfaces();
  let lanIp = null;
  let tailscaleIp = null;
  const allUrls = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      const url = `http://${addr.address}:${port}`;
      allUrls.push({ interface: name, ip: addr.address, url });
      if (addr.address.startsWith('100.') || name.toLowerCase().includes('utun')) {
        if (!tailscaleIp && addr.address.startsWith('100.')) {
          tailscaleIp = addr.address;
        }
      } else if (!lanIp) {
        lanIp = addr.address;
      }
    }
  }

  const primaryIp = lanIp || tailscaleIp || 'localhost';
  return {
    localUrl: `http://localhost:${port}`,
    lanUrl: lanIp ? `http://${lanIp}:${port}` : null,
    tailscaleUrl: tailscaleIp ? `http://${tailscaleIp}:${port}` : null,
    primaryProjectionUrl: `http://${primaryIp}:${port}`,
    hostname: os.hostname(),
    allUrls,
  };
}

export async function createInControlHub(options = {}) {
  const port = Number(options.port || process.env.INCONTROL_PORT || 4747);
  const host = options.host || (options.localOnly ? '127.0.0.1' : '0.0.0.0');
  const enableMacNotifications = options.macNotifications !== false;
  const token = options.token || loadOrCreateToken();
  const requireLocal = Boolean(options.strict);

  const store = new AgentStore();
  const stopAutoWatcher = options.autoWatch === false ? () => {} : startAutoWatcher(store);

  const network = discoverNetworkUrls(port);
  network.pairingUrl = `${network.primaryProjectionUrl}/?token=${encodeURIComponent(token)}`;
  network.tailscalePairingUrl = network.tailscaleUrl
    ? `${network.tailscaleUrl}/?token=${encodeURIComponent(token)}`
    : null;
  const stopWhatsApp = setupWhatsAppEscalation(
    store,
    () => network.tailscalePairingUrl || network.pairingUrl
  );
  const allowedHosts = buildAllowedHosts(network, options.allowedHosts || []);
  // The QR code carries the pairing token so scanning it pairs the device in one step.
  const qrSvg = await QRCode.toString(network.pairingUrl, {
    type: 'svg',
    margin: 1,
    color: {
      dark: '#f8fafc',
      light: '#00000000',
    },
  });

  const server = http.createServer(async (req, res) => {
    // No CORS headers on purpose: only same-origin pages (our own UI) may call the API from a browser.
    // Agents/connectors are non-browser clients and are unaffected.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const originCheck = checkOrigin(req, allowedHosts);
    if (!originCheck.ok) {
      return sendJson(res, 403, { ok: false, error: originCheck.reason });
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // Pairing: a valid ?token= sets a long-lived HttpOnly cookie, then redirects to strip it from the URL.
    const queryToken = parsedUrl.searchParams.get('token');
    if (req.method === 'GET' && queryToken && !pathname.startsWith('/api/')) {
      if (safeEqual(queryToken, token)) {
        res.writeHead(302, { 'Set-Cookie': sessionCookie(token), Location: '/' });
        res.end();
        return;
      }
    }

    if (!PUBLIC_ASSETS.has(pathname) && !isAuthorized(req, parsedUrl, token, { requireLocal })) {
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized: pairing token required' });
      }
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(UNAUTHORIZED_HTML);
      return;
    }

    try {
      // 1. GET /api/state — Full state snapshot
      if (req.method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, buildFullState(store, network, qrSvg));
      }

      // 2. POST /api/agents/event — Register or update agent state
      if (req.method === 'POST' && pathname === '/api/agents/event') {
        const body = await readJsonBody(req);
        const agent = store.upsertAgent(body);
        const queuedMessages = store.drainQueuedMessages(agent.id);
        return sendJson(res, 200, {
          ok: true,
          agent: store.serializeAgent(agent),
          queuedMessages,
        });
      }

      // 3. POST /api/agents/ask — Request human input/approval (supports blocking wait)
      if (req.method === 'POST' && pathname === '/api/agents/ask') {
        const body = await readJsonBody(req);
        const agentId = body.id || body.agentId || 'custom-agent';
        const wait = body.wait !== false;
        const timeoutMs = Number(body.timeoutMs || 300_000);

        const result = await store.requestInput(
          agentId,
          {
            question: body.question,
            toolName: body.toolName,
            command: body.command,
            details: body.details,
            options: body.options,
            allowFreeText: body.allowFreeText,
            wait,
            agentMeta: {
              name: body.name,
              provider: body.provider,
              ide: body.ide,
              workspace: body.workspace,
              branch: body.branch,
              currentTask: body.currentTask,
            },
          },
          timeoutMs
        );

        return sendJson(res, 200, result);
      }

      // 4. POST /api/agents/:id/respond — User responds from Mac panel or Phone
      const respondMatch = pathname.match(/^\/api\/agents\/([^/]+)\/respond$/);
      if (req.method === 'POST' && respondMatch) {
        const agentId = decodeURIComponent(respondMatch[1]);
        const body = await readJsonBody(req);
        const result = store.respondToAgent(agentId, body);
        return sendJson(res, result.ok ? 200 : 404, result);
      }

      // 5. POST /api/agents/:id/focus — Focus IDE / Terminal window on macOS
      const focusMatch = pathname.match(/^\/api\/agents\/([^/]+)\/focus$/);
      if (req.method === 'POST' && focusMatch) {
        const agentId = decodeURIComponent(focusMatch[1]);
        const agent = store.agents.get(agentId);
        if (!agent) {
          return sendJson(res, 404, { ok: false, error: 'Agent not found' });
        }
        const focusResult = await focusAgentWindow(agent);
        return sendJson(res, 200, focusResult);
      }

      // 6. GET /api/agents/:id/messages — Poll queued user instructions
      const messagesMatch = pathname.match(/^\/api\/agents\/([^/]+)\/messages$/);
      if (req.method === 'GET' && messagesMatch) {
        const agentId = decodeURIComponent(messagesMatch[1]);
        const messages = store.drainQueuedMessages(agentId);
        return sendJson(res, 200, { ok: true, messages });
      }

      // 7. DELETE /api/agents/:id — Remove agent
      const deleteMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
      if (req.method === 'DELETE' && deleteMatch) {
        const agentId = decodeURIComponent(deleteMatch[1]);
        const existed = store.removeAgent(agentId);
        return sendJson(res, 200, { ok: existed });
      }

      // 8. GET /api/integrations — Live integration detection & status
      if (req.method === 'GET' && pathname === '/api/integrations') {
        return sendJson(res, 200, { ok: true, integrations: getIntegrationsStatus() });
      }

      // 9. POST /api/integrations/install — One-click integration installer
      if (req.method === 'POST' && pathname === '/api/integrations/install') {
        const body = await readJsonBody(req);
        const result = installIntegration(body.id);
        broadcast({
          type: 'state_sync',
          state: buildFullState(store, network, qrSvg),
        });
        return sendJson(res, 200, {
          ...result,
          integrations: getIntegrationsStatus(),
        });
      }

      // 10. GET/POST /api/whatsapp — Configure unanswered-prompt WhatsApp escalation
      if (req.method === 'GET' && pathname === '/api/whatsapp') {
        return sendJson(res, 200, { ok: true, whatsapp: getPublicWhatsAppStatus() });
      }

      if (req.method === 'POST' && pathname === '/api/whatsapp') {
        const body = await readJsonBody(req);
        const patch = { ...body };
        for (const secretKey of ['callmebotApiKey', 'twilioToken', 'cloudToken']) {
          if (patch[secretKey] === '••••••••' || patch[secretKey] === undefined) {
            delete patch[secretKey];
          }
        }
        saveWhatsAppConfig(patch);
        broadcast({
          type: 'state_sync',
          state: buildFullState(store, network, qrSvg),
        });
        return sendJson(res, 200, {
          ok: true,
          message: 'Saved WhatsApp escalation settings',
          whatsapp: getPublicWhatsAppStatus(),
        });
      }

      if (req.method === 'POST' && pathname === '/api/whatsapp/test') {
        const cfg = loadWhatsAppConfig();
        const link = network.tailscalePairingUrl || network.pairingUrl;
        await dispatchWhatsAppMessage(
          cfg,
          `✅ *InControl WhatsApp Escalation Active*\nIf you don't respond within ${cfg.timeoutSec}s when an agent needs input, InControl will message you here.\n\nOpen panel: ${link}`
        );
        return sendJson(res, 200, { ok: true, message: `Sent test WhatsApp to ${cfg.phone || cfg.provider}` });
      }

      if (req.method === 'POST' && pathname === '/api/webhooks/whatsapp') {
        const body = await readJsonOrFormBody(req);
        const result = handleIncomingWhatsAppReply(store, body);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      // 10b. GET/POST /api/settings & POST /api/agents/:id/function — User customization & custom functions
      if (req.method === 'GET' && pathname === '/api/settings') {
        return sendJson(res, 200, { ok: true, settings: loadUserSettings() });
      }

      if (req.method === 'POST' && pathname === '/api/settings') {
        const body = await readJsonBody(req);
        const updated = saveUserSettings(body);
        broadcast({
          type: 'state_sync',
          state: buildFullState(store, network, qrSvg),
        });
        return sendJson(res, 200, {
          ok: true,
          message: 'Saved InControl settings',
          settings: updated,
        });
      }

      const fnMatch = pathname.match(/^\/api\/agents\/([^/]+)\/function$/);
      if (req.method === 'POST' && fnMatch) {
        const agentId = decodeURIComponent(fnMatch[1]);
        const body = await readJsonBody(req);
        const result = await executeCustomFunction(store, agentId, body.functionId);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      // 10c. GET /api/icons/tool/:toolKey & GET /api/icons/project/:agentId — Real Agentic Tool & Project Icons
      const toolIconMatch = pathname.match(/^\/api\/icons\/tool\/([a-z0-9_-]+)$/i);
      if (req.method === 'GET' && toolIconMatch) {
        const asset = getToolIconAsset(toolIconMatch[1].toLowerCase());
        res.writeHead(200, {
          'Content-Type': asset.contentType,
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'public, max-age=3600',
        });
        res.end(asset.buffer);
        return;
      }

      const projIconMatch = pathname.match(/^\/api\/icons\/project\/([^/]+)$/);
      if (req.method === 'GET' && projIconMatch) {
        const agentId = decodeURIComponent(projIconMatch[1]);
        const agent = store.agents.get(agentId);
        const iconPath = agent ? findProjectIconPath(agent.workspace) : null;
        if (!iconPath || !fs.existsSync(iconPath)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(iconPath).toLowerCase();
        const mime = ext === '.svg' ? 'image/svg+xml' : 'image/png';
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'public, max-age=300',
        });
        res.end(fs.readFileSync(iconPath));
        return;
      }

      // 11. Static file serving (Web UI / PWA)
      let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
      // Prevent directory traversal (including sibling-prefix paths)
      const relPath = path.relative(PUBLIC_DIR, filePath);
      if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(filePath).pipe(res);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || 'Internal Server Error' });
    }
  });

  // WebSocket server for instant cross-device state projection
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: ({ req }, done) => {
      const url = new URL(req.url || '/ws', 'http://localhost');
      if (!checkOrigin(req, allowedHosts).ok) return done(false, 403, 'Forbidden');
      if (!isAuthorized(req, url, token, { requireLocal })) return done(false, 401, 'Unauthorized');
      done(true);
    },
  });

  function broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  }

  store.on('change', (changeEvent) => {
    broadcast({
      type: 'state_sync',
      changeEvent,
      state: buildFullState(store, network, qrSvg),
    });
  });

  store.on('notification', (notification) => {
    broadcast({
      type: 'notification',
      notification,
    });
    if (enableMacNotifications) {
      sendMacNotification({
        title: notification.title,
        body: notification.body,
      });
    }
  });

  wss.on('connection', (ws) => {
    ws.send(
      JSON.stringify({
        type: 'state_sync',
        state: buildFullState(store, network, qrSvg),
      })
    );

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'respond' && msg.agentId) {
          store.respondToAgent(msg.agentId, msg);
        } else if (msg.type === 'focus' && msg.agentId) {
          const agent = store.agents.get(msg.agentId);
          if (agent) await focusAgentWindow(agent);
        }
      } catch {
        // Ignore malformed WS messages
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });

  return {
    server,
    wss,
    store,
    network,
    port,
    token,
    close: () =>
      new Promise((resolve) => {
        stopAutoWatcher();
        stopWhatsApp();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

function buildFullState(store, network, qrSvg) {
  return {
    agents: store.getSortedAgents(),
    counts: store.getSummaryCounts(),
    integrations: getIntegrationsStatus(),
    whatsapp: getPublicWhatsAppStatus(),
    settings: loadUserSettings(),
    network,
    qrSvg,
    globalEvents: store.globalEvents.slice(0, 25),
    serverTime: Date.now(),
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function readJsonOrFormBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      const ct = (req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/x-www-form-urlencoded')) {
        return resolve(Object.fromEntries(new URLSearchParams(raw).entries()));
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(Object.fromEntries(new URLSearchParams(raw).entries()));
      }
    });
    req.on('error', reject);
  });
}
