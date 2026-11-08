import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const COOKIE_NAME = 'incontrol_token';
const CONFIG_DIR = process.env.INCONTROL_HOME || path.join(os.homedir(), '.incontrol');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Load the pairing token (INCONTROL_TOKEN env > ~/.incontrol/config.json), creating one if missing.
 */
export function loadOrCreateToken({ rotate = false } = {}) {
  if (process.env.INCONTROL_TOKEN && !rotate) return process.env.INCONTROL_TOKEN;

  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}

  if (!config.token || rotate) {
    config.token = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
  return config.token;
}

export function isLoopback(req) {
  return LOOPBACK.has(req.socket?.remoteAddress);
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Extract a presented token from Authorization header, cookie, or ?token= query.
 */
export function presentedToken(req, url) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (cookie) return cookie;
  return url.searchParams.get('token');
}

/**
 * Guard against cross-site requests and DNS rebinding:
 *  - Host header must be one we actually serve (localhost, our IPs, our hostname)
 *  - If an Origin header is present (browsers), it must match the Host
 * Non-browser clients (connectors, curl) send no Origin and pass the origin check.
 */
export function checkOrigin(req, allowedHosts) {
  const host = (req.headers.host || '').toLowerCase();
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!allowedHosts.has(hostname)) {
    return { ok: false, reason: `Host '${hostname}' not allowed` };
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    return { ok: false, reason: 'Cross-site request blocked (Sec-Fetch-Site)' };
  }
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    try {
      if (new URL(origin).host.toLowerCase() !== host) {
        return { ok: false, reason: 'Cross-origin request blocked' };
      }
    } catch {
      return { ok: false, reason: 'Invalid Origin' };
    }
  } else if (origin === 'null') {
    return { ok: false, reason: 'Opaque origin blocked' };
  }
  return { ok: true };
}

/**
 * Decide whether a request is authorized.
 * Loopback clients (local connectors, the macOS panel) are trusted unless requireLocal is set.
 */
export function isAuthorized(req, url, token, { requireLocal = false } = {}) {
  if (!requireLocal && isLoopback(req)) return true;
  return safeEqual(presentedToken(req, url), token);
}

export function buildAllowedHosts(network, extra = []) {
  const hosts = new Set(['localhost', '127.0.0.1', '::1']);
  for (const u of network.allUrls || []) hosts.add(u.ip);
  if (network.hostname) {
    const h = network.hostname.toLowerCase();
    hosts.add(h);
    hosts.add(h.endsWith('.local') ? h : `${h}.local`);
  }
  for (const h of extra) if (h) hosts.add(String(h).toLowerCase());
  return hosts;
}

export function sessionCookie(token) {
  // HttpOnly so page scripts can't read it; 1 year so phones stay paired.
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`;
}

export const UNAUTHORIZED_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>InControl — pairing required</title></head>
<body style="background:#090b10;color:#94a3b8;font:15px -apple-system,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:20px">
<div><div style="font-size:40px">🔒</div><h2 style="color:#e2e8f0">Pairing required</h2>
<p>Open InControl on your Mac, tap <b>📱</b> and scan the QR code<br>or run <code>incontrol token</code> and open the pairing link.</p></div></body></html>`;
