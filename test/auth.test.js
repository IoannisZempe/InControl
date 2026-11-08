import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createInControlHub } from '../src/server/hub.js';

const TOKEN = 'test-token-123';

async function withHub(opts, fn) {
  const hub = await createInControlHub({ macNotifications: false, token: TOKEN, ...opts });
  try {
    await fn(`http://localhost:${hub.port}`, hub);
  } finally {
    await hub.close();
  }
}

test('security: cross-site browser requests are blocked (no CORS, Origin check)', () =>
  withHub({ port: 4781 }, async (base) => {
    const res = await fetch(`${base}/api/state`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);

    const ok = await fetch(`${base}/api/state`, { headers: { Origin: base } });
    assert.equal(ok.status, 200);
  }));

test('security: DNS-rebinding Host header is rejected', () =>
  withHub({ port: 4782 }, async () => {
    // fetch() ignores custom Host headers, so use raw http
    const status = await new Promise((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port: 4782, path: '/api/state', headers: { Host: 'attacker.example:4782' } }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
        .on('error', reject);
    });
    assert.equal(status, 403);
  }));

test('security: token required (strict), via Bearer, cookie pairing, and WebSocket', () =>
  withHub({ port: 4783, strict: true }, async (base) => {
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    assert.equal((await fetch(`${base}/`)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer wrong' } })).status,
      401
    );
    assert.equal(
      (await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status,
      200
    );

    // Pairing link sets an HttpOnly cookie and strips the token from the URL
    const pair = await fetch(`${base}/?token=${TOKEN}`, { redirect: 'manual' });
    assert.equal(pair.status, 302);
    assert.equal(pair.headers.get('location'), '/');
    const cookie = pair.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    const withCookie = await fetch(`${base}/api/state`, { headers: { Cookie: cookie.split(';')[0] } });
    assert.equal(withCookie.status, 200);

    // WebSocket: rejected without token, accepted with it
    const wsUrl = base.replace('http', 'ws') + '/ws';
    await assert.rejects(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        ws.on('open', resolve);
        ws.on('error', reject);
      })
    );
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
      ws.on('message', () => {
        ws.close();
        resolve();
      });
      ws.on('error', reject);
    });
  }));

test('security: local connectors on loopback work without a token (default mode)', () =>
  withHub({ port: 4784 }, async (base) => {
    assert.equal((await fetch(`${base}/api/state`)).status, 200);
  }));

test('security: LAN clients need the token', async (t) => {
  await withHub({ port: 4785 }, async (_base, hub) => {
    if (!hub.network.lanUrl) return t.skip('no LAN interface');
    assert.equal((await fetch(`${hub.network.lanUrl}/api/state`)).status, 401);
    const ok = await fetch(`${hub.network.lanUrl}/api/state`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(ok.status, 200);
  });
});
