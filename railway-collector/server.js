import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

const PORT = Number(process.env.PORT || 8080);
const DATABASE_URL = process.env.DATABASE_URL || '';
const COLLECTOR_API_TOKEN = process.env.COLLECTOR_API_TOKEN || '';
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB safety cap per daily snapshot

if (!DATABASE_URL) {
  console.warn('[railway-collector] Warning: DATABASE_URL is not set');
}
if (!COLLECTOR_API_TOKEN) {
  console.warn('[railway-collector] Warning: COLLECTOR_API_TOKEN is not set (API routes will reject requests)');
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('.railway.internal') || DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
    })
  : null;

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_contexts (
      day DATE PRIMARY KEY,
      captured_at TIMESTAMPTZ NOT NULL,
      device TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      project_count INTEGER NOT NULL DEFAULT 0,
      agent_count INTEGER NOT NULL DEFAULT 0,
      commit_count INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_daily_contexts_captured_at
    ON daily_contexts (captured_at DESC);
  `);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthorized(req) {
  if (!COLLECTOR_API_TOKEN) return false;
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return false;
  return safeEqual(auth.slice(7).trim(), COLLECTOR_API_TOKEN);
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function isValidDay(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      if (!pool) return sendJson(res, 503, { ok: false, error: 'Database not configured' });
      await pool.query('SELECT 1');
      return sendJson(res, 200, { ok: true, service: 'incontrol-railway-collector' });
    }

    if (pathname.startsWith('/api/')) {
      if (!COLLECTOR_API_TOKEN) {
        return sendJson(res, 503, { ok: false, error: 'COLLECTOR_API_TOKEN not configured' });
      }
      if (!isAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
      }
      if (!pool) {
        return sendJson(res, 503, { ok: false, error: 'DATABASE_URL not configured' });
      }
    }

    // POST /api/days — Upsert a full daily context collection keyed by YYYY-MM-DD
    if (req.method === 'POST' && pathname === '/api/days') {
      const body = await readJsonBody(req);
      const day = String(body.day || '').trim();
      if (!isValidDay(day)) {
        return sendJson(res, 400, { ok: false, error: 'Invalid or missing day (expected YYYY-MM-DD)' });
      }

      const capturedAt = body.capturedAt ? new Date(body.capturedAt) : new Date();
      const safeCapturedAt = Number.isNaN(capturedAt.getTime()) ? new Date() : capturedAt;
      const device = String(body.device || '').slice(0, 120);
      const summary = String(body.summary || '').slice(0, 500);
      const stats = body.stats || {};
      const projectCount = Number(stats.projectCount) || 0;
      const agentCount = Number(stats.agentCount) || 0;
      const commitCount = Number(stats.commitCount) || 0;
      const eventCount = Number(stats.eventCount) || 0;

      const result = await pool.query(
        `INSERT INTO daily_contexts (
           day, captured_at, device, summary,
           project_count, agent_count, commit_count, event_count, payload, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
         ON CONFLICT (day) DO UPDATE SET
           captured_at = EXCLUDED.captured_at,
           device = EXCLUDED.device,
           summary = EXCLUDED.summary,
           project_count = EXCLUDED.project_count,
           agent_count = EXCLUDED.agent_count,
           commit_count = EXCLUDED.commit_count,
           event_count = EXCLUDED.event_count,
           payload = EXCLUDED.payload,
           updated_at = NOW()
         RETURNING to_char(day, 'YYYY-MM-DD') AS day, captured_at, updated_at`,
        [day, safeCapturedAt.toISOString(), device, summary, projectCount, agentCount, commitCount, eventCount, JSON.stringify(body)]
      );

      return sendJson(res, 200, {
        ok: true,
        day: result.rows[0].day,
        capturedAt: result.rows[0].captured_at,
        updatedAt: result.rows[0].updated_at,
      });
    }

    // GET /api/days — List daily archive entries
    if (req.method === 'GET' && pathname === '/api/days') {
      const limit = Math.max(1, Math.min(90, Number(url.searchParams.get('limit')) || 30));
      const { rows } = await pool.query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day,
                captured_at AS "capturedAt",
                device,
                summary,
                project_count AS "projectCount",
                agent_count AS "agentCount",
                commit_count AS "commitCount",
                event_count AS "eventCount",
                updated_at AS "updatedAt"
         FROM daily_contexts
         ORDER BY day DESC
         LIMIT $1`,
        [limit]
      );
      return sendJson(res, 200, { ok: true, days: rows });
    }

    // GET /api/days/:day — Fetch full JSON payload for one day
    const dayMatch = pathname.match(/^\/api\/days\/(\d{4}-\d{2}-\d{2})$/);
    if (req.method === 'GET' && dayMatch) {
      const { rows } = await pool.query(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day,
                captured_at AS "capturedAt",
                updated_at AS "updatedAt",
                payload
         FROM daily_contexts
         WHERE day = $1`,
        [dayMatch[1]]
      );
      if (!rows.length) {
        return sendJson(res, 404, { ok: false, error: 'Day not found' });
      }
      return sendJson(res, 200, {
        ok: true,
        day: rows[0].day,
        capturedAt: rows[0].capturedAt,
        updatedAt: rows[0].updatedAt,
        collection: rows[0].payload,
      });
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    const status = err.statusCode || 500;
    return sendJson(res, status, { ok: false, error: err.message || 'Internal Server Error' });
  }
});

await ensureSchema();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[railway-collector] Listening on 0.0.0.0:${PORT}`);
});
