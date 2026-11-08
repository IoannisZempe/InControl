import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { AgentStore } from './store.js';
import { AgentSimulator } from './simulator.js';
import { focusAgentWindow, sendMacNotification } from './macos-focus.js';

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
  const host = options.host || '0.0.0.0';
  const enableMacNotifications = options.macNotifications !== false;

  const store = new AgentStore();
  const simulator = new AgentSimulator(store);

  if (options.demo) {
    simulator.start();
  }

  const network = discoverNetworkUrls(port);
  const qrSvg = await QRCode.toString(network.primaryProjectionUrl, {
    type: 'svg',
    margin: 1,
    color: {
      dark: '#f8fafc',
      light: '#00000000',
    },
  });

  const server = http.createServer(async (req, res) => {
    // CORS headers so custom agents or external webviews can connect freely
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    try {
      // 1. GET /api/state — Full state snapshot
      if (req.method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, buildFullState(store, simulator, network, qrSvg));
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

      // 8. POST /api/simulator/toggle — Enable/disable simulated demo agents
      if (req.method === 'POST' && pathname === '/api/simulator/toggle') {
        const body = await readJsonBody(req);
        const shouldEnable = body.enabled !== undefined ? Boolean(body.enabled) : !simulator.active;
        if (shouldEnable) {
          simulator.start();
        } else {
          simulator.stop();
        }
        return sendJson(res, 200, { ok: true, simulatorActive: simulator.active });
      }

      // 9. POST /api/simulator/trigger-prompt — Simulate an incoming blocking prompt
      if (req.method === 'POST' && pathname === '/api/simulator/trigger-prompt') {
        if (!simulator.active) simulator.start();
        store.requestInput('sim-agy-incontrol', {
          wait: false,
          question: 'Ready to publish @incontrol/agents v0.1.0 and push tags to origin/main?',
          toolName: 'Bash',
          command: 'git push origin main --tags && npm publish --access public',
          options: [
            { id: 'approve', label: 'Approve Push', style: 'primary' },
            { id: 'push_only', label: 'Git Push Only', style: 'secondary' },
            { id: 'deny', label: 'Hold Off', style: 'danger' },
          ],
          allowFreeText: true,
        });
        return sendJson(res, 200, { ok: true });
      }

      // 10. Static file serving (Web UI / PWA)
      let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname);
      // Prevent directory traversal
      if (!filePath.startsWith(PUBLIC_DIR)) {
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
  const wss = new WebSocketServer({ server, path: '/ws' });

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
      state: buildFullState(store, simulator, network, qrSvg),
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
        state: buildFullState(store, simulator, network, qrSvg),
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
        } else if (msg.type === 'toggle_simulator') {
          if (simulator.active) simulator.stop();
          else simulator.start();
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
    simulator,
    network,
    port,
    close: () =>
      new Promise((resolve) => {
        simulator.stop();
        wss.close();
        server.close(() => resolve());
      }),
  };
}

function buildFullState(store, simulator, network, qrSvg) {
  return {
    agents: store.getSortedAgents(),
    counts: store.getSummaryCounts(),
    simulatorActive: simulator.active,
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
