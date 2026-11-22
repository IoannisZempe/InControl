/**
 * Zero-dependency W3C Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID ES256)
 * for background PWA notifications on iOS 16.4+ Home-Screen apps and Android/Desktop browsers.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getPushStorePath() {
  const dir = process.env.INCONTROL_HOME || path.join(os.homedir(), '.incontrol');
  return path.join(dir, 'push.json');
}

function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function base64UrlDecode(str) {
  return Buffer.from(String(str || ''), 'base64url');
}

/**
 * Generate an uncompressed P-256 VAPID keypair in base64url (65-byte public, 32-byte private).
 */
export function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: base64UrlEncode(ecdh.getPublicKey()),
    privateKey: base64UrlEncode(ecdh.getPrivateKey()),
  };
}

/**
 * Convert raw 65-byte uncompressed public key + 32-byte private key into a Node KeyObject (JWK).
 */
function vapidPrivateKeyObject(publicKeyB64, privateKeyB64) {
  const pub = base64UrlDecode(publicKeyB64);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('Invalid VAPID public key (expected 65-byte uncompressed P-256 point)');
  }
  const x = base64UrlEncode(pub.subarray(1, 33));
  const y = base64UrlEncode(pub.subarray(33, 65));
  return crypto.createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x,
      y,
      d: privateKeyB64,
    },
    format: 'jwk',
  });
}

/**
 * Build an RFC 8292 VAPID ES256 JWT + Authorization header for a push endpoint origin.
 */
export function createVapidAuthHeader({ endpoint, publicKey, privateKey, subject = 'mailto:theone@localhost', expirationSeconds = 12 * 3600 }) {
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const header = base64UrlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + expirationSeconds,
      sub: subject,
    })
  );
  const signingInput = `${header}.${payload}`;
  const keyObj = vapidPrivateKeyObject(publicKey, privateKey);
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: keyObj,
    dsaEncoding: 'ieee-p1363',
  });
  const jwt = `${signingInput}.${base64UrlEncode(signature)}`;
  return {
    jwt,
    authorization: `vapid t=${jwt}, k=${publicKey}`,
  };
}

/**
 * Encrypt a Web Push payload per RFC 8291 + RFC 8188 (Content-Encoding: aes128gcm).
 */
export function encryptWebPushPayload(plaintext, { p256dh, auth }) {
  const uaPublic = base64UrlDecode(p256dh);
  const authSecret = base64UrlDecode(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('Invalid subscriber p256dh key');
  }
  if (authSecret.length !== 16) {
    throw new Error('Invalid subscriber auth secret');
  }

  const localEcdh = crypto.createECDH('prime256v1');
  localEcdh.generateKeys();
  const asPublic = localEcdh.getPublicKey(); // 65 bytes
  const salt = crypto.randomBytes(16);

  const ecdhSecret = localEcdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));

  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  // RFC 8188 single final record: plaintext || 0x02 delimiter
  const record = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag();

  // RFC 8188 header: salt(16) || rs(4 BE) || idlen(1) || keyid(65)
  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(4096, 0);
  const idLenBuf = Buffer.from([asPublic.length]);
  const header = Buffer.concat([salt, rsBuf, idLenBuf, asPublic]);

  return Buffer.concat([header, ciphertext, tag]);
}

/**
 * Validate push subscription endpoint to prevent SSRF against internal/private hosts.
 */
export function validatePushEndpoint(endpoint, { allowLoopback = false } = {}) {
  let url;
  try {
    url = new URL(String(endpoint || ''));
  } catch {
    return { ok: false, error: 'Invalid push endpoint URL' };
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';

  if (allowLoopback && isLoopback && (url.protocol === 'http:' || url.protocol === 'https:')) {
    return { ok: true, url };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, error: 'Push endpoint must use HTTPS' };
  }
  if (
    isLoopback ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
    /^0\./.test(host)
  ) {
    return { ok: false, error: 'Push endpoint cannot target private or loopback networks' };
  }
  return { ok: true, url };
}

function loadPushState(storePath = getPushStorePath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    if (raw?.vapid?.publicKey && raw?.vapid?.privateKey && Array.isArray(raw.subscriptions)) {
      return raw;
    }
  } catch {}
  const initial = {
    vapid: generateVapidKeys(),
    subscriptions: [],
  };
  savePushState(initial, storePath);
  return initial;
}

function savePushState(data, storePath = getPushStorePath()) {
  const dir = path.dirname(storePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Create a Web Push manager bound to the AgentStore.
 */
export function createWebPushManager(store, { fetchFn = globalThis.fetch, allowLoopbackEndpoint = false } = {}) {
  const storePath = getPushStorePath();
  let state = loadPushState(storePath);
  const notifiedKeys = new Set();

  function getPublicStatus() {
    return {
      publicKey: state.vapid.publicKey,
      subscriptionCount: state.subscriptions.length,
      subscriptions: state.subscriptions.map((s) => ({
        id: s.id,
        host: (() => {
          try {
            return new URL(s.endpoint).host;
          } catch {
            return 'unknown';
          }
        })(),
        deviceLabel: s.deviceLabel || 'Mobile Browser',
        createdAt: s.createdAt,
      })),
    };
  }

  function subscribe(raw) {
    const endpoint = String(raw?.endpoint || '').trim();
    const p256dh = String(raw?.keys?.p256dh || '').trim();
    const auth = String(raw?.keys?.auth || '').trim();
    const deviceLabel = String(raw?.deviceLabel || 'Phone PWA').slice(0, 48);

    const check = validatePushEndpoint(endpoint, { allowLoopback: allowLoopbackEndpoint });
    if (!check.ok) return { ok: false, error: check.error };

    const pubBuf = base64UrlDecode(p256dh);
    const authBuf = base64UrlDecode(auth);
    if (pubBuf.length !== 65 || pubBuf[0] !== 0x04) {
      return { ok: false, error: 'Invalid p256dh key in push subscription' };
    }
    if (authBuf.length !== 16) {
      return { ok: false, error: 'Invalid auth secret in push subscription' };
    }

    const existingIdx = state.subscriptions.findIndex((s) => s.endpoint === endpoint);
    const entry = {
      id: existingIdx >= 0 ? state.subscriptions[existingIdx].id : `sub_${crypto.randomBytes(6).toString('hex')}`,
      endpoint,
      keys: { p256dh, auth },
      deviceLabel,
      createdAt: Date.now(),
    };
    if (existingIdx >= 0) {
      state.subscriptions[existingIdx] = entry;
    } else {
      state.subscriptions.push(entry);
      if (state.subscriptions.length > 20) {
        state.subscriptions = state.subscriptions.slice(-20);
      }
    }
    savePushState(state, storePath);
    return { ok: true, subscription: { id: entry.id, deviceLabel: entry.deviceLabel }, status: getPublicStatus() };
  }

  function unsubscribe(endpoint) {
    const target = String(endpoint || '').trim();
    const before = state.subscriptions.length;
    state.subscriptions = state.subscriptions.filter((s) => s.endpoint !== target);
    const removed = state.subscriptions.length < before;
    if (removed) savePushState(state, storePath);
    return { ok: true, removed, status: getPublicStatus() };
  }

  async function sendToAll(payloadObj) {
    if (!state.subscriptions.length) {
      return { ok: true, sent: 0, failed: 0, pruned: 0 };
    }
    const plaintext = JSON.stringify(payloadObj);
    let sent = 0;
    let failed = 0;
    const staleEndpoints = new Set();

    await Promise.all(
      state.subscriptions.map(async (sub) => {
        try {
          const encrypted = encryptWebPushPayload(plaintext, sub.keys);
          const { authorization } = createVapidAuthHeader({
            endpoint: sub.endpoint,
            publicKey: state.vapid.publicKey,
            privateKey: state.vapid.privateKey,
          });
          const res = await fetchFn(sub.endpoint, {
            method: 'POST',
            headers: {
              Authorization: authorization,
              'Content-Encoding': 'aes128gcm',
              'Content-Type': 'application/octet-stream',
              TTL: '120',
              Urgency: 'high',
            },
            body: encrypted,
          });
          if (res.status === 404 || res.status === 410) {
            staleEndpoints.add(sub.endpoint);
            failed += 1;
          } else if (res.ok || (res.status >= 200 && res.status < 300)) {
            sent += 1;
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        }
      })
    );

    if (staleEndpoints.size > 0) {
      state.subscriptions = state.subscriptions.filter((s) => !staleEndpoints.has(s.endpoint));
      savePushState(state, storePath);
    }

    return { ok: true, sent, failed, pruned: staleEndpoints.size };
  }

  async function sendTestNotification() {
    if (!state.subscriptions.length) {
      return { ok: false, error: 'No subscribed mobile devices yet. Tap Enable Push Alerts on your phone first.' };
    }
    return sendToAll({
      title: 'TheOne · Push Alerts Active',
      body: 'Connected! You will get lock-screen pings whenever an agent blocks on approval.',
      tag: `theone-test-${Date.now()}`,
      url: '/',
    });
  }

  const onStoreChange = (evt) => {
    if (!state.subscriptions.length) return;
    const agent = evt?.agent;
    if (!agent || agent.status !== 'needs_input') return;
    const reqId = agent.pendingPrompt?.requestId || agent.currentStep || 'prompt';
    const dedupeKey = `${agent.id}:${reqId}`;
    if (notifiedKeys.has(dedupeKey)) return;
    notifiedKeys.add(dedupeKey);
    if (notifiedKeys.size > 200) {
      const first = notifiedKeys.values().next().value;
      notifiedKeys.delete(first);
    }

    const title = `${agent.projectName || agent.name} · Needs Input`;
    const body = agent.pendingPrompt?.command
      ? `$ ${agent.pendingPrompt.command}`
      : agent.pendingPrompt?.question || agent.attentionReason || 'Agent is waiting for your approval.';

    sendToAll({
      title,
      body,
      tag: `theone-${agent.id}`,
      agentId: agent.id,
      url: `/?agent=${encodeURIComponent(agent.id)}`,
    }).catch(() => {});
  };

  store.on('change', onStoreChange);

  return {
    getPublicStatus,
    subscribe,
    unsubscribe,
    sendToAll,
    sendTestNotification,
    stop: () => {
      store.off('change', onStoreChange);
    },
  };
}
