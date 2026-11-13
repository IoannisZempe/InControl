import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

function getConfigDir() {
  return process.env.INCONTROL_HOME || path.join(os.homedir(), '.incontrol');
}

export function getHistoryDir() {
  return path.join(getConfigDir(), 'history');
}

/**
 * Format a Date (or timestamp) into local calendar YYYY-MM-DD.
 */
export function formatLocalDay(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isValidDayString(day) {
  return typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day);
}

function getLedgerPath(day = formatLocalDay()) {
  return path.join(getHistoryDir(), `${day}.jsonl`);
}

function getSnapshotPath(day = formatLocalDay()) {
  return path.join(getHistoryDir(), `${day}.snapshot.json`);
}

/**
 * Append a compact structured event to today's persistent JSONL history ledger.
 */
export function appendDailyEvent(entry) {
  if (!entry || typeof entry !== 'object') return;
  try {
    const day = formatLocalDay(entry.timestamp || Date.now());
    const dir = getHistoryDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const record = {
      timestamp: entry.timestamp || Date.now(),
      type: entry.type || 'info',
      agentId: entry.agentId || '',
      agentName: entry.agentName || '',
      provider: entry.provider || '',
      projectName: entry.projectName || '',
      workspace: entry.workspace || '',
      branch: entry.branch || '',
      status: entry.status || '',
      message: String(entry.message || '').slice(0, 500),
    };
    fs.appendFileSync(getLedgerPath(day), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // Non-fatal: ledger writes must never break live agent event handling
  }
}

/**
 * Read all ledger events recorded for a given YYYY-MM-DD day.
 */
export function readDailyEvents(day = formatLocalDay(), maxEvents = 1000) {
  if (!isValidDayString(day)) return [];
  const filePath = getLedgerPath(day);
  if (!fs.existsSync(filePath)) return [];
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    const slice = lines.slice(-maxEvents);
    const events = [];
    for (const line of slice) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip corrupted line
      }
    }
    return events.reverse(); // newest first
  } catch {
    return [];
  }
}

export function readLocalSnapshot(day = formatLocalDay()) {
  if (!isValidDayString(day)) return null;
  const p = getSnapshotPath(day);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function listLocalDays(limit = 30) {
  const dir = getHistoryDir();
  if (!fs.existsSync(dir)) return [];
  const map = new Map();
  try {
    for (const name of fs.readdirSync(dir)) {
      const snapMatch = name.match(/^(\d{4}-\d{2}-\d{2})\.snapshot\.json$/);
      const logMatch = name.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (snapMatch) {
        const day = snapMatch[1];
        const snap = readLocalSnapshot(day);
        if (snap) {
          map.set(day, {
            day,
            capturedAt: snap.capturedAt,
            device: snap.device,
            summary: snap.summary,
            projectCount: snap.stats?.projectCount || 0,
            agentCount: snap.stats?.agentCount || 0,
            commitCount: snap.stats?.commitCount || 0,
            eventCount: snap.stats?.eventCount || 0,
            source: 'local',
          });
        }
      } else if (logMatch && !map.has(logMatch[1])) {
        const day = logMatch[1];
        const events = readDailyEvents(day, 500);
        map.set(day, {
          day,
          capturedAt: events[0]?.timestamp ? new Date(events[0].timestamp).toISOString() : null,
          device: os.hostname(),
          summary: `${events.length} logged event(s) (not snapshotted yet)`,
          projectCount: new Set(events.map((e) => e.projectName).filter(Boolean)).size,
          agentCount: new Set(events.map((e) => e.agentId).filter(Boolean)).size,
          commitCount: 0,
          eventCount: events.length,
          source: 'local-ledger',
        });
      }
    }
  } catch {
    return [];
  }
  return Array.from(map.values())
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, limit);
}

function execGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 2500, maxBuffer: 512 * 1024 }, (err, stdout) => {
      if (err) return resolve('');
      resolve(String(stdout || '').trim());
    });
  });
}

/**
 * Collect today's git branch, commits, and working-tree changes for one workspace path.
 */
export async function collectWorkspaceGitToday(workspacePath, day = formatLocalDay()) {
  if (!workspacePath || typeof workspacePath !== 'string') return null;
  let stat;
  try {
    stat = fs.statSync(workspacePath);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const inside = await execGit(['rev-parse', '--is-inside-work-tree'], workspacePath);
  if (inside !== 'true') {
    return {
      workspace: workspacePath,
      projectName: path.basename(workspacePath) || workspacePath,
      isGitRepo: false,
      branch: null,
      commitsToday: [],
      changedFiles: [],
    };
  }

  const [branch, logRaw, statusRaw] = await Promise.all([
    execGit(['branch', '--show-current'], workspacePath),
    execGit(
      [
        'log',
        `--since=${day} 00:00:00`,
        `--until=${day} 23:59:59`,
        '--pretty=format:%h\t%an\t%aI\t%s',
        '-n',
        '30',
      ],
      workspacePath
    ),
    execGit(['status', '--short', '-u'], workspacePath),
  ]);

  const commitsToday = logRaw
    ? logRaw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [hash, author, authoredAt, ...subjectParts] = line.split('\t');
          return {
            hash: hash || '',
            author: author || '',
            authoredAt: authoredAt || '',
            subject: subjectParts.join('\t').slice(0, 200),
          };
        })
    : [];

  const changedFiles = statusRaw
    ? statusRaw
        .split('\n')
        .filter(Boolean)
        .slice(0, 25)
        .map((line) => line.slice(0, 180))
    : [];

  return {
    workspace: workspacePath,
    projectName: path.basename(workspacePath) || workspacePath,
    isGitRepo: true,
    branch: branch || 'HEAD',
    commitsToday,
    changedFiles,
  };
}

function readFirstMarkdownHeading(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').slice(0, 1200);
    for (const line of raw.split('\n')) {
      const trimmed = line.replace(/^#+\s*/, '').trim();
      if (trimmed) return trimmed.slice(0, 140);
    }
  } catch {}
  return '';
}

/**
 * Scan local Antigravity / Claude Code / Codex directories for session metadata updated today.
 * Reads only titles/metadata — never scans raw credentials or env files.
 */
export function collectLocalAiSessionsToday(day = formatLocalDay(), roots = {}) {
  if (process.env.INCONTROL_DISABLE_HOME_SCAN === '1' && !roots.force) {
    return [];
  }

  const home = os.homedir();
  const sessions = [];

  // 1. Antigravity brain workspaces modified today
  const agBrainDir = roots.antigravityBrainDir || path.join(home, '.gemini', 'antigravity', 'brain');
  try {
    if (fs.existsSync(agBrainDir)) {
      for (const entry of fs.readdirSync(agBrainDir)) {
        if (entry === 'tempmediaStorage' || entry.startsWith('.')) continue;
        const fullDir = path.join(agBrainDir, entry);
        let stat;
        try {
          stat = fs.statSync(fullDir);
        } catch {
          continue;
        }
        if (!stat.isDirectory() || formatLocalDay(stat.mtime) !== day) continue;

        let title = '';
        for (const candidate of ['task.md', 'implementation_plan.md', 'walkthrough.md']) {
          const p = path.join(fullDir, candidate);
          if (fs.existsSync(p)) {
            title = readFirstMarkdownHeading(p);
            if (title) break;
          }
        }
        sessions.push({
          provider: 'antigravity',
          sessionId: entry,
          title: title || `Antigravity session (${entry.slice(0, 8)})`,
          updatedAt: stat.mtime.toISOString(),
        });
      }
    }
  } catch {}

  // 2. Claude Code project transcripts modified today
  const claudeDir = roots.claudeProjectsDir || path.join(home, '.claude', 'projects');
  try {
    if (fs.existsSync(claudeDir)) {
      for (const projSlug of fs.readdirSync(claudeDir)) {
        const projPath = path.join(claudeDir, projSlug);
        let pStat;
        try {
          pStat = fs.statSync(projPath);
        } catch {
          continue;
        }
        if (!pStat.isDirectory()) continue;
        for (const file of fs.readdirSync(projPath)) {
          if (!file.endsWith('.jsonl')) continue;
          const filePath = path.join(projPath, file);
          let fStat;
          try {
            fStat = fs.statSync(filePath);
          } catch {
            continue;
          }
          if (formatLocalDay(fStat.mtime) !== day) continue;
          sessions.push({
            provider: 'claude-code',
            sessionId: file.replace(/\.jsonl$/, ''),
            title: projSlug.replace(/^-+/, '').replace(/-/g, '/') || 'Claude Code session',
            updatedAt: fStat.mtime.toISOString(),
          });
        }
      }
    }
  } catch {}

  // 3. Codex sessions in ~/.codex/sessions/YYYY/MM/DD/
  const [yr, mo, dy] = day.split('-');
  const codexDayDir = roots.codexDayDir || path.join(home, '.codex', 'sessions', yr, mo, dy);
  try {
    if (fs.existsSync(codexDayDir)) {
      for (const file of fs.readdirSync(codexDayDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(codexDayDir, file);
        let fStat;
        try {
          fStat = fs.statSync(filePath);
        } catch {
          continue;
        }
        sessions.push({
          provider: 'codex',
          sessionId: file.replace(/\.jsonl$/, ''),
          title: `Codex session (${file.slice(0, 28)})`,
          updatedAt: fStat.mtime.toISOString(),
        });
      }
    }
  } catch {}

  return sessions
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, 40);
}

/**
 * Gather a complete structured daily context bundle from InControl store + history + Git + AI sessions.
 */
export async function captureDailyContext(store, options = {}) {
  const day = isValidDayString(options.day) ? options.day : formatLocalDay();
  const capturedAt = new Date().toISOString();
  const events = readDailyEvents(day, 1000);
  const liveAgents = store ? store.getSortedAgents() : [];

  const sanitizedAgents = liveAgents.map((a) => ({
    id: a.id,
    name: a.name,
    provider: a.provider,
    ide: a.ide,
    projectName: a.projectName,
    workspace: a.workspace,
    branch: a.branch,
    status: a.status,
    currentTask: a.currentTask,
    currentStep: a.currentStep,
    metrics: a.metrics,
    logs: (a.logs || []).slice(0, 20),
  }));

  const workspaceSet = new Set();
  for (const a of sanitizedAgents) {
    if (a.workspace) workspaceSet.add(a.workspace);
  }
  for (const ev of events) {
    if (ev.workspace) workspaceSet.add(ev.workspace);
  }
  for (const extra of options.extraWorkspaces || []) {
    if (extra) workspaceSet.add(extra);
  }

  const workspaceList = Array.from(workspaceSet).slice(0, 20);
  const workspaces = (
    await Promise.all(workspaceList.map((wp) => collectWorkspaceGitToday(wp, day)))
  ).filter(Boolean);

  const aiSessions = collectLocalAiSessionsToday(day, options.roots);
  const commitCount = workspaces.reduce((sum, w) => sum + (w.commitsToday?.length || 0), 0);
  const projectNames = Array.from(
    new Set([
      ...sanitizedAgents.map((a) => a.projectName).filter(Boolean),
      ...workspaces.map((w) => w.projectName).filter(Boolean),
    ])
  );

  const summaryParts = [];
  if (projectNames.length) summaryParts.push(`${projectNames.length} project(s): ${projectNames.slice(0, 4).join(', ')}`);
  if (commitCount) summaryParts.push(`${commitCount} commit(s)`);
  if (events.length) summaryParts.push(`${events.length} event(s)`);
  if (aiSessions.length) summaryParts.push(`${aiSessions.length} AI session(s)`);

  const snapshot = {
    day,
    capturedAt,
    device: os.hostname(),
    summary: summaryParts.join(' · ') || 'Empty day snapshot',
    stats: {
      projectCount: projectNames.length,
      agentCount: sanitizedAgents.length,
      commitCount,
      eventCount: events.length,
      sessionCount: aiSessions.length,
    },
    projects: projectNames,
    agents: sanitizedAgents,
    events,
    workspaces,
    aiSessions,
  };

  try {
    fs.mkdirSync(getHistoryDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(getSnapshotPath(day), JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Non-fatal
  }

  return snapshot;
}

/**
 * Validate Railway Collector URL to block metadata SSRF or unsafe schemes.
 */
export function validateRailwayUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return { ok: true, url: '' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'Invalid Railway Collector URL' };
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    return { ok: false, error: 'Railway Collector URL must use https:// (or http://localhost for local tests)' };
  }
  if (host === '169.254.169.254' || host === 'metadata.google.internal' || host === '0.0.0.0') {
    return { ok: false, error: 'Railway Collector host is not permitted' };
  }
  return { ok: true, url: parsed.origin + parsed.pathname.replace(/\/+$/, '') };
}

export async function pushSnapshotToRailway(snapshot, settings) {
  const check = validateRailwayUrl(settings?.railwayUrl);
  if (!check.ok) {
    return { synced: false, error: check.error };
  }
  if (!check.url) {
    return { synced: false, skipped: true, reason: 'Railway Collector URL is not configured' };
  }
  if (!settings?.railwayToken) {
    return { synced: false, error: 'Railway Collector API token is missing' };
  }

  const resp = await fetch(`${check.url}/api/days`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.railwayToken}`,
    },
    body: JSON.stringify(snapshot),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    return { synced: false, status: resp.status, error: data.error || `HTTP ${resp.status}` };
  }
  return {
    synced: true,
    day: data.day || snapshot.day,
    updatedAt: data.updatedAt || null,
    remoteUrl: check.url,
  };
}

export async function fetchRailwayDays(settings, limit = 30) {
  const check = validateRailwayUrl(settings?.railwayUrl);
  if (!check.ok) return { ok: false, error: check.error, days: [] };
  if (!check.url) return { ok: false, configured: false, days: [] };
  if (!settings?.railwayToken) return { ok: false, error: 'Railway Collector API token is missing', days: [] };

  const resp = await fetch(`${check.url}/api/days?limit=${encodeURIComponent(String(limit))}`, {
    headers: { Authorization: `Bearer ${settings.railwayToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    return { ok: false, error: data.error || `HTTP ${resp.status}`, days: [] };
  }
  return { ok: true, configured: true, days: data.days || [] };
}

export async function fetchRailwayDay(day, settings) {
  if (!isValidDayString(day)) return { ok: false, error: 'Invalid day format' };
  const check = validateRailwayUrl(settings?.railwayUrl);
  if (!check.ok) return { ok: false, error: check.error };
  if (!check.url) return { ok: false, error: 'Railway Collector URL is not configured' };
  if (!settings?.railwayToken) return { ok: false, error: 'Railway Collector API token is missing' };

  const resp = await fetch(`${check.url}/api/days/${encodeURIComponent(day)}`, {
    headers: { Authorization: `Bearer ${settings.railwayToken}` },
    signal: AbortSignal.timeout(8_000),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) {
    return { ok: false, error: data.error || `HTTP ${resp.status}` };
  }
  return { ok: true, day: data.day, collection: data.collection };
}
