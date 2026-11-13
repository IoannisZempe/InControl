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

function getHandoffsPath(day = formatLocalDay()) {
  return path.join(getHistoryDir(), `${day}.handoffs.json`);
}

export function readHandoffNotes(day = formatLocalDay()) {
  if (!isValidDayString(day)) return [];
  const p = getHandoffsPath(day);
  if (!fs.existsSync(p)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveHandoffNote(note = {}) {
  const day = isValidDayString(note.day) ? note.day : formatLocalDay();
  const entry = {
    id: `ho_${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    day,
    projectName: cleanSnippet(note.projectName || note.project || (note.workspace ? path.basename(note.workspace) : ''), 100),
    workspace: String(note.workspace || '').slice(0, 300),
    provider: cleanSnippet(note.provider || '', 40),
    fromAgent: cleanSnippet(note.fromAgent || note.agentName || '', 80),
    goal: cleanSnippet(note.goal || '', 400),
    summary: cleanSnippet(note.summary || '', 2000),
    nextSteps: cleanSnippet(note.nextSteps || '', 1200),
  };

  try {
    fs.mkdirSync(getHistoryDir(), { recursive: true, mode: 0o700 });
    const existing = readHandoffNotes(day);
    const updated = [entry, ...existing].slice(0, 50);
    fs.writeFileSync(getHandoffsPath(day), JSON.stringify(updated, null, 2) + '\n', { mode: 0o600 });
  } catch {}

  appendDailyEvent({
    timestamp: Date.now(),
    type: 'handoff',
    agentId: note.agentId || '',
    agentName: entry.fromAgent || 'Agent',
    provider: entry.provider || 'custom',
    projectName: entry.projectName || '',
    workspace: entry.workspace || '',
    status: 'idle',
    message: `Saved handoff${entry.goal ? `: ${entry.goal}` : ''}`,
  });

  return entry;
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
 * Redact common credential patterns before persisting or syncing session excerpts remotely.
 */
export function redactSecrets(input) {
  let out = String(input || '');
  out = out.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-~+/=]{12,}/gi, '$1[REDACTED]');
  out = out.replace(/(https?:\/\/|postgres(?:ql)?:\/\/|mongodb(?:\+srv)?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi, '$1$2:[REDACTED]@');
  out = out.replace(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|rk_live_[0-9A-Za-z]{16,}|pk_live_[0-9A-Za-z]{16,})\b/g, '[REDACTED]');
  out = out.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
  out = out.replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*['"]?)([^\s'"`]{8,})/gi, '$1[REDACTED]');
  return out;
}

function cleanSnippet(text, maxLen = 360) {
  return redactSecrets(String(text || '').replace(/\s+/g, ' ').trim()).slice(0, maxLen);
}

function extractAntigravitySessionContext(brainDir, entry, day) {
  const fullDir = path.join(brainDir, entry);
  let title = '';
  const artifactNotes = [];
  for (const candidate of ['task.md', 'implementation_plan.md', 'walkthrough.md', 'architecture_plan.md']) {
    const p = path.join(fullDir, candidate);
    if (!fs.existsSync(p)) continue;
    try {
      const stat = fs.statSync(p);
      if (formatLocalDay(stat.mtime) !== day && candidate !== 'task.md') continue;
      const heading = readFirstMarkdownHeading(p);
      if (!title && heading) title = heading;
      const excerpt = cleanSnippet(fs.readFileSync(p, 'utf8').slice(0, 600), 320);
      if (excerpt) artifactNotes.push({ file: candidate, excerpt });
    } catch {}
  }

  const userPrompts = [];
  let lastSummary = '';
  const transcriptPath = path.join(fullDir, '.system_generated', 'logs', 'transcript.jsonl');
  if (fs.existsSync(transcriptPath)) {
    try {
      const raw = fs.readFileSync(transcriptPath, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const createdDay = obj.created_at ? formatLocalDay(obj.created_at) : day;
        if (createdDay !== day) continue;

        if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
          const match = obj.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
          const promptText = cleanSnippet(match ? match[1] : obj.content, 360);
          if (promptText && !promptText.startsWith('The following is a <SYSTEM_MESSAGE>')) {
            userPrompts.push(promptText);
          }
        } else if (obj.type === 'PLANNER_RESPONSE' && typeof obj.content === 'string' && obj.content.trim()) {
          const summary = cleanSnippet(obj.content, 600);
          if (summary) lastSummary = summary;
        }
      }
    } catch {}
  }

  return {
    title: cleanSnippet(title || userPrompts[0] || `Antigravity session (${entry.slice(0, 8)})`, 120),
    userPrompts: userPrompts.slice(-15),
    lastSummary,
    artifacts: artifactNotes.slice(0, 4),
  };
}

function extractCodexSessionContext(filePath) {
  let cwd = '';
  let branch = '';
  const userPrompts = [];
  let lastSummary = '';

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.type === 'session_meta' && obj.payload) {
        if (typeof obj.payload.cwd === 'string') cwd = obj.payload.cwd;
        if (typeof obj.payload.git?.branch === 'string') branch = obj.payload.git.branch;
      } else if (obj.type === 'event_msg' && obj.payload) {
        if (obj.payload.type === 'user_message' && typeof obj.payload.message === 'string') {
          const msg = cleanSnippet(obj.payload.message, 360);
          if (msg) userPrompts.push(msg);
        } else if (obj.payload.type === 'agent_message' && typeof obj.payload.message === 'string') {
          const msg = cleanSnippet(obj.payload.message, 600);
          if (msg) lastSummary = msg;
        }
      } else if (obj.type === 'response_item' && obj.payload?.type === 'message') {
        const contentArr = Array.isArray(obj.payload.content) ? obj.payload.content : [];
        const text = contentArr.map((c) => c?.text || '').join(' ').trim();
        if (obj.payload.role === 'user' && text && !text.startsWith('# AGENTS.md') && !text.startsWith('<environment_context>')) {
          const cleaned = cleanSnippet(text, 360);
          if (cleaned && !userPrompts.includes(cleaned)) userPrompts.push(cleaned);
        } else if (obj.payload.role === 'assistant' && text) {
          lastSummary = cleanSnippet(text, 600);
        }
      }
    }
  } catch {}

  const projectName = cwd ? path.basename(cwd) : '';
  return {
    cwd,
    branch,
    title: cleanSnippet(userPrompts[0] || (projectName ? `Codex · ${projectName}` : 'Codex session'), 120),
    userPrompts: userPrompts.slice(-15),
    lastSummary,
  };
}

function extractClaudeSessionContext(filePath, projSlug, day) {
  let cwd = '';
  const userPrompts = [];
  let lastSummary = '';

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj.timestamp && formatLocalDay(obj.timestamp) !== day) continue;
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
      const msg = obj.message || obj;
      if (obj.type === 'user' || msg.role === 'user') {
        const content = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((b) => (b?.type === 'text' ? b.text : '')).join(' ')
            : '';
        const cleaned = cleanSnippet(content, 360);
        if (cleaned) userPrompts.push(cleaned);
      } else if (obj.type === 'assistant' || msg.role === 'assistant') {
        const content = typeof msg.content === 'string'
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((b) => (b?.type === 'text' ? b.text : '')).join(' ')
            : '';
        const cleaned = cleanSnippet(content, 600);
        if (cleaned) lastSummary = cleaned;
      }
    }
  } catch {}

  const fallbackProj = projSlug.replace(/^-+/, '').replace(/-/g, '/') || 'Claude Code';
  return {
    cwd,
    title: cleanSnippet(userPrompts[0] || (cwd ? `Claude · ${path.basename(cwd)}` : fallbackProj), 120),
    userPrompts: userPrompts.slice(-15),
    lastSummary,
  };
}

/**
 * Scan local Antigravity / Claude Code / Codex directories for session metadata, prompts, and summaries updated today.
 * Applies secret redaction and skips raw env/credential files.
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

        const details = extractAntigravitySessionContext(agBrainDir, entry, day);
        sessions.push({
          provider: 'antigravity',
          sessionId: entry,
          title: details.title,
          userPrompts: details.userPrompts,
          lastSummary: details.lastSummary,
          artifacts: details.artifacts,
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
          const details = extractClaudeSessionContext(filePath, projSlug, day);
          sessions.push({
            provider: 'claude-code',
            sessionId: file.replace(/\.jsonl$/, ''),
            workspace: details.cwd || null,
            title: details.title,
            userPrompts: details.userPrompts,
            lastSummary: details.lastSummary,
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
        const details = extractCodexSessionContext(filePath);
        sessions.push({
          provider: 'codex',
          sessionId: file.replace(/\.jsonl$/, ''),
          workspace: details.cwd || null,
          branch: details.branch || null,
          title: details.title,
          userPrompts: details.userPrompts,
          lastSummary: details.lastSummary,
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
  const events = readDailyEvents(day, 1000).map((ev) => ({
    ...ev,
    message: redactSecrets(ev.message),
  }));
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
    currentTask: redactSecrets(a.currentTask),
    currentStep: redactSecrets(a.currentStep),
    metrics: a.metrics,
    logs: (a.logs || []).slice(0, 20).map((l) => ({ ...l, message: redactSecrets(l.message) })),
  }));

  const aiSessions = collectLocalAiSessionsToday(day, options.roots).map((s) => {
    if (s.provider === 'antigravity' && s.sessionId && (!s.workspace || !s.projectName)) {
      const agyId = `agy-${s.sessionId.slice(0, 8)}`;
      const matched =
        sanitizedAgents.find((a) => a.id === agyId) ||
        events.find((ev) => ev.agentId === agyId && ev.workspace);
      if (matched) {
        return {
          ...s,
          workspace: s.workspace || matched.workspace || '',
          projectName: s.projectName || matched.projectName || (matched.workspace ? path.basename(matched.workspace) : ''),
          branch: s.branch || matched.branch || null,
        };
      }
    }
    return s;
  });
  const handoffs = readHandoffNotes(day);

  const activeWorkspaceSet = new Set();
  for (const a of sanitizedAgents) {
    if (a.workspace) activeWorkspaceSet.add(a.workspace);
  }
  for (const ev of events) {
    if (ev.workspace) activeWorkspaceSet.add(ev.workspace);
  }
  for (const s of aiSessions) {
    if (s.workspace) activeWorkspaceSet.add(s.workspace);
  }
  for (const extra of options.extraWorkspaces || []) {
    if (extra) activeWorkspaceSet.add(extra);
  }

  // Also check standard repo containers on macOS for any repos committed/edited today even without a live agent
  const discoveredSet = new Set(activeWorkspaceSet);
  if (process.env.INCONTROL_DISABLE_HOME_SCAN !== '1') {
    const home = os.homedir();
    for (const parentDir of [path.join(home, 'Repo'), path.join(home, 'Documents', 'ChatGPT')]) {
      try {
        if (!fs.existsSync(parentDir)) continue;
        for (const sub of fs.readdirSync(parentDir)) {
          if (sub.startsWith('.')) continue;
          const full = path.join(parentDir, sub);
          try {
            if (fs.statSync(full).isDirectory()) discoveredSet.add(full);
          } catch {}
        }
      } catch {}
    }
  }

  const workspaceList = Array.from(discoveredSet).slice(0, 30);
  const allWorkspaces = (
    await Promise.all(workspaceList.map((wp) => collectWorkspaceGitToday(wp, day)))
  ).filter(Boolean);

  // Keep every workspace that belongs to an active/today session OR had commits/file changes today
  const workspaces = allWorkspaces.filter(
    (w) => activeWorkspaceSet.has(w.workspace) || w.commitsToday.length > 0 || w.changedFiles.length > 0
  );
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
    handoffs,
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

function matchesContextFilter(item = {}, filters = {}) {
  const projectQ = String(filters.project || '').trim().toLowerCase();
  const workspaceQ = String(filters.workspace || '').trim().toLowerCase();
  const providerQ = String(filters.provider || '').trim().toLowerCase();
  const sessionQ = String(filters.sessionId || '').trim().toLowerCase();
  const agentQ = String(filters.agentId || '').trim().toLowerCase();

  if (sessionQ) {
    const sid = String(item.sessionId || '').toLowerCase();
    if (!sid || !sid.includes(sessionQ)) return false;
  }
  if (agentQ) {
    const aid = String(item.id || item.agentId || '').toLowerCase();
    if (aid && !aid.includes(agentQ)) return false;
  }
  if (providerQ) {
    const prov = String(item.provider || '').toLowerCase();
    if (prov && prov !== providerQ) return false;
  }
  if (workspaceQ) {
    const wp = String(item.workspace || '').toLowerCase();
    if (!wp || (wp !== workspaceQ && !wp.includes(workspaceQ))) return false;
  }
  if (projectQ) {
    const pn = String(item.projectName || (item.workspace ? path.basename(item.workspace) : '') || item.title || '').toLowerCase();
    if (!pn.includes(projectQ)) return false;
  }
  return true;
}

/**
 * Build a portable Markdown + structured handoff brief from live local context or an archived Railway/local day.
 * Lets any IDE or AI agent pull full sanitized context across sessions via InControl MCP.
 */
export async function buildPortableContextBrief({
  store = null,
  settings = {},
  day = null,
  project = '',
  workspace = '',
  provider = '',
  sessionId = '',
  agentId = '',
} = {}) {
  const today = formatLocalDay();
  const targetDay = isValidDayString(day) ? day : today;
  let source = 'live';
  let collection = null;

  if (targetDay === today && store) {
    collection = await captureDailyContext(store, { day: targetDay });
  } else {
    if (settings?.railwayUrl && settings?.railwayToken) {
      const remote = await fetchRailwayDay(targetDay, settings);
      if (remote.ok && remote.collection) {
        collection = remote.collection;
        source = 'railway';
      }
    }
    if (!collection) {
      const local = readLocalSnapshot(targetDay);
      if (local) {
        collection = local;
        source = 'local';
      } else if (targetDay === today) {
        collection = await captureDailyContext(store, { day: targetDay });
      }
    }
  }

  if (!collection) {
    return { ok: false, error: `No context snapshot found for ${targetDay}` };
  }

  const filters = { project, workspace, provider, sessionId, agentId };
  const hasFilter = Boolean(project || workspace || provider || sessionId || agentId);

  const workspaces = (collection.workspaces || []).filter((w) => matchesContextFilter(w, filters));
  const aiSessions = (collection.aiSessions || []).filter((s) => matchesContextFilter(s, filters));
  const agents = (collection.agents || []).filter((a) => matchesContextFilter(a, filters));
  const handoffs = (collection.handoffs || []).filter((h) => matchesContextFilter(h, filters));
  const events = (collection.events || []).filter((ev) => matchesContextFilter(ev, filters)).slice(0, 20);

  // Build crisp portable Markdown suitable for pasting or MCP injection into another IDE/agent
  const lines = [];
  lines.push(`# InControl Handoff Context (${targetDay})`);
  lines.push(
    `Source: \`${source}\` · Device: \`${collection.device || os.hostname()}\`${
      project ? ` · Project: **${project}**` : ''
    }${workspace ? ` · Workspace: \`${workspace}\`` : ''}${provider ? ` · Provider: \`${provider}\`` : ''}`
  );
  lines.push('');

  if (handoffs.length) {
    lines.push('## Explicit Handoff Checkpoints');
    for (const h of handoffs.slice(0, 5)) {
      lines.push(`### ${h.projectName || h.fromAgent || 'Checkpoint'} (${h.createdAt})`);
      if (h.goal) lines.push(`- **Goal:** ${h.goal}`);
      if (h.summary) lines.push(`- **Summary:** ${h.summary}`);
      if (h.nextSteps) lines.push(`- **Next steps:** ${h.nextSteps}`);
      lines.push('');
    }
  }

  if (workspaces.length) {
    lines.push('## Workspaces & Git State');
    for (const w of workspaces.slice(0, 8)) {
      lines.push(`### ${w.projectName || path.basename(w.workspace)} (\`${w.branch || 'no-branch'}\`) — \`${w.workspace}\``);
      if (w.commitsToday?.length) {
        lines.push('- **Commits today:**');
        for (const c of w.commitsToday.slice(0, 10)) {
          lines.push(`  - \`${c.hash}\` ${c.subject}`);
        }
      }
      if (w.changedFiles?.length) {
        lines.push(`- **Working tree (${w.changedFiles.length} changed):** ${w.changedFiles.slice(0, 15).map((f) => `\`${f}\``).join(', ')}`);
      }
      lines.push('');
    }
  }

  if (aiSessions.length) {
    lines.push('## AI Sessions');
    for (const s of aiSessions.slice(0, 10)) {
      lines.push(`### [${s.provider}] ${s.title || s.sessionId}`);
      if (s.workspace) lines.push(`- **Workspace:** \`${s.workspace}\`${s.branch ? ` (${s.branch})` : ''}`);
      if (s.userPrompts?.length) {
        lines.push('- **Recent user prompts:**');
        for (const p of s.userPrompts.slice(-6)) {
          lines.push(`  - ${p}`);
        }
      }
      if (s.lastSummary) {
        lines.push(`- **Last assistant summary:** ${s.lastSummary}`);
      }
      if (s.artifacts?.length) {
        lines.push('- **Artifacts / plan notes:**');
        for (const art of s.artifacts) {
          lines.push(`  - **${art.file}:** ${art.excerpt}`);
        }
      }
      lines.push('');
    }
  }

  if (agents.length) {
    lines.push('## Live Connected Agents');
    for (const a of agents.slice(0, 10)) {
      lines.push(`- **${a.projectName}** (${a.name} · \`${a.status}\`): ${a.currentTask || a.currentStep || 'Active'}`);
    }
    lines.push('');
  }

  if (!handoffs.length && !workspaces.length && !aiSessions.length && !agents.length && hasFilter) {
    lines.push('_No matching sessions or workspaces found for the given filter._');
  }

  const brief = {
    day: targetDay,
    source,
    device: collection.device || os.hostname(),
    filters,
    handoffs,
    workspaces,
    aiSessions,
    agents,
    events,
  };

  return {
    ok: true,
    source,
    day: targetDay,
    summary: collection.summary,
    markdown: lines.join('\n').trim(),
    brief,
  };
}
