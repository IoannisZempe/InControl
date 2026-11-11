import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ICON_CACHE_DIR = path.join(os.homedir(), '.incontrol', 'icon-cache');
const projectIconCache = new Map();

// Known macOS .app bundle icon paths (hardcoded allowlist for safe sips extraction)
const MACOS_APP_ICONS = Object.freeze({
  antigravity: '/Applications/Antigravity.app/Contents/Resources/icon.icns',
  chatgpt: '/Applications/ChatGPT.app/Contents/Resources/icon-chatgpt.icns',
  codex: '/Applications/ChatGPT.app/Contents/Resources/app.icns',
  cursor: '/Applications/Cursor.app/Contents/Resources/Cursor.icns',
  claude: '/Applications/Claude.app/Contents/Resources/electron.icns',
  vscode: '/Applications/Visual Studio Code.app/Contents/Resources/Code.icns',
});

// High-craft vector SVG fallbacks for tools without a local .app bundle (e.g. Claude Code CLI, Aider, OpenCode)
const FALLBACK_TOOL_SVGS = Object.freeze({
  claude: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
    <rect width="128" height="128" rx="28" fill="#D97757"/>
    <g stroke="#FFF7F2" stroke-width="7.5" stroke-linecap="round">
      <line x1="64" y1="22" x2="64" y2="106"/>
      <line x1="22" y1="64" x2="106" y2="64"/>
      <line x1="34.3" y1="34.3" x2="93.7" y2="93.7"/>
      <line x1="93.7" y1="34.3" x2="34.3" y2="93.7"/>
      <line x1="48" y1="25.2" x2="80" y2="102.8"/>
      <line x1="25.2" y1="48" x2="102.8" y2="80"/>
      <line x1="25.2" y1="80" x2="102.8" y2="48"/>
      <line x1="48" y1="102.8" x2="80" y2="25.2"/>
    </g>
    <circle cx="64" cy="64" r="11" fill="#D97757"/>
    <circle cx="64" cy="64" r="6" fill="#FFF7F2"/>
  </svg>`,
  codex: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
    <defs>
      <linearGradient id="cx" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#2B32B2"/>
        <stop offset="100%" stop-color="#1488CC"/>
      </linearGradient>
    </defs>
    <rect width="128" height="128" rx="28" fill="url(#cx)"/>
    <circle cx="64" cy="64" r="38" stroke="#FFFFFF" stroke-opacity="0.28" stroke-width="5"/>
    <path d="M46 50L62 64L46 78M68 78H84" stroke="#FFFFFF" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  chatgpt: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
    <rect width="128" height="128" rx="28" fill="#10A37F"/>
    <g stroke="#FFFFFF" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="64" cy="46" r="18"/>
      <circle cx="80" cy="55" r="18"/>
      <circle cx="80" cy="73" r="18"/>
      <circle cx="64" cy="82" r="18"/>
      <circle cx="48" cy="73" r="18"/>
      <circle cx="48" cy="55" r="18"/>
    </g>
  </svg>`,
  antigravity: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
    <defs>
      <linearGradient id="ag" x1="16" y1="16" x2="112" y2="112" gradientUnits="userSpaceOnUse">
        <stop offset="0%" stop-color="#4FACFE"/>
        <stop offset="50%" stop-color="#6A82FB"/>
        <stop offset="100%" stop-color="#B721FF"/>
      </linearGradient>
    </defs>
    <rect width="128" height="128" rx="28" fill="#101320"/>
    <path d="M64 18C68 48 80 60 110 64C80 68 68 80 64 110C60 80 48 68 18 64C48 60 60 48 64 18Z" fill="url(#ag)"/>
  </svg>`,
  cursor: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
    <rect width="128" height="128" rx="28" fill="#141414"/>
    <path d="M64 22L102 44V84L64 106L26 84V44L64 22Z" stroke="#FFFFFF" stroke-width="6" stroke-linejoin="round"/>
    <path d="M64 22L102 44L64 66L26 44L64 22Z" fill="#FFFFFF" fill-opacity="0.22"/>
    <path d="M64 66V106L102 84V44L64 66Z" fill="#FFFFFF" fill-opacity="0.45"/>
  </svg>`,
  aider: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
    <rect width="128" height="128" rx="28" fill="#11221C"/>
    <path d="M36 48L54 64L36 80M62 80H92" stroke="#30D158" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
});

/**
 * Resolves the canonical tool key ('chatgpt', 'codex', 'antigravity', 'claude', 'cursor', 'aider')
 */
export function normalizeToolKey(provider = '', ide = '', name = '') {
  const p = String(provider).toLowerCase();
  const i = String(ide).toLowerCase();
  const n = String(name).toLowerCase();

  if (p.includes('antigravity') || i.includes('antigravity') || n.includes('antigravity')) {
    return 'antigravity';
  }
  if (p.includes('claude') || i.includes('claude') || n.includes('claude')) {
    return 'claude';
  }
  if (p.includes('cursor') || i.includes('cursor') || n.includes('cursor')) {
    return 'cursor';
  }
  if (i.includes('chatgpt') || n.includes('chatgpt')) {
    return 'chatgpt';
  }
  if (p.includes('codex') || n.includes('codex')) {
    return 'codex';
  }
  if (p.includes('aider') || n.includes('aider')) {
    return 'aider';
  }
  return 'codex';
}

/**
 * Returns { contentType, buffer } for the requested tool icon.
 * Uses the real installed macOS .app icon when available, or crisp SVG fallback.
 */
export function getToolIconAsset(toolKey) {
  const key = Object.prototype.hasOwnProperty.call(MACOS_APP_ICONS, toolKey) ? toolKey : 'codex';
  const icnsPath = MACOS_APP_ICONS[key];

  if (icnsPath && fs.existsSync(icnsPath)) {
    try {
      fs.mkdirSync(ICON_CACHE_DIR, { recursive: true, mode: 0o700 });
      const cachedPng = path.join(ICON_CACHE_DIR, `${key}.png`);
      if (!fs.existsSync(cachedPng)) {
        execFileSync(
          '/usr/bin/sips',
          ['-s', 'format', 'png', '-z', '128', '128', icnsPath, '--out', cachedPng],
          { stdio: 'ignore', timeout: 4000 }
        );
      }
      if (fs.existsSync(cachedPng)) {
        return {
          contentType: 'image/png',
          buffer: fs.readFileSync(cachedPng),
        };
      }
    } catch {}
  }

  const svg = FALLBACK_TOOL_SVGS[key] || FALLBACK_TOOL_SVGS.codex;
  return {
    contentType: 'image/svg+xml',
    buffer: Buffer.from(svg, 'utf8'),
  };
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  'coverage',
  '.agents',
  '.claude',
  'test',
  'tests',
]);

/**
 * Discovers a project's own icon/logo file inside its workspace directory.
 */
export function findProjectIconPath(workspace) {
  if (!workspace || typeof workspace !== 'string') return null;
  if (projectIconCache.has(workspace)) {
    const cached = projectIconCache.get(workspace);
    if (!cached || fs.existsSync(cached)) return cached;
  }

  if (!fs.existsSync(workspace)) {
    projectIconCache.set(workspace, null);
    return null;
  }

  let realWorkspace;
  try {
    realWorkspace = fs.realpathSync(workspace);
  } catch {
    projectIconCache.set(workspace, null);
    return null;
  }

  const isInsideWorkspace = (candidatePath) => {
    try {
      const realCandidate = fs.realpathSync(candidatePath);
      const rel = path.relative(realWorkspace, realCandidate);
      return !rel.startsWith('..') && !path.isAbsolute(rel);
    } catch {
      return false;
    }
  };

  // 1. Direct well-known relative paths
  const directCandidates = [
    'public/icon.svg',
    'public/icon.png',
    'public/favicon.svg',
    'public/favicon.png',
    'public/apple-touch-icon.png',
    'public/logo.svg',
    'public/logo.png',
    'app/icon.svg',
    'app/icon.png',
    'brand/diald-icon-mint.png',
    'brand/diald-icon-cycle.svg',
    'assets/icon.png',
    'assets/logo.png',
    'icon.svg',
    'icon.png',
    'favicon.svg',
    'favicon.png',
  ];

  for (const rel of directCandidates) {
    const full = path.join(workspace, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile() && isInsideWorkspace(full)) {
      projectIconCache.set(workspace, full);
      return full;
    }
  }

  // 2. Bounded shallow search (up to depth 4) for *icon*.{svg,png} or *-180.png / *-192.png
  const matches = [];
  function walk(dir, depth = 0) {
    if (depth > 4 || matches.length >= 8) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          walk(full, depth + 1);
        }
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (
          (lower.endsWith('.svg') || lower.endsWith('.png')) &&
          (lower.includes('icon') ||
            lower.includes('-180.') ||
            lower.includes('-192.') ||
            lower.includes('logo')) &&
          !lower.includes('screenshot')
        ) {
          matches.push(full);
        }
      }
    }
  }

  walk(workspace, 0);
  // Prefer icon files over full wordmark logos
  matches.sort((a, b) => {
    const aIcon = path.basename(a).toLowerCase().includes('icon') || a.includes('180') ? 0 : 1;
    const bIcon = path.basename(b).toLowerCase().includes('icon') || b.includes('180') ? 0 : 1;
    return aIcon - bIcon;
  });

  const best = matches.find((m) => isInsideWorkspace(m)) || null;
  projectIconCache.set(workspace, best);
  return best;
}
