import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadUserSettings, saveUserSettings } from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const DEFAULT_COLLECTOR_DIR = path.join(REPO_ROOT, 'railway-collector');

function defaultExec(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd || process.cwd(),
        env: opts.env || process.env,
        maxBuffer: 1024 * 1024 * 4,
      },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          return reject(err);
        }
        resolve({ stdout, stderr });
      }
    );
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(String(opts.input));
      child.stdin.end();
    }
  });
}

function defaultInteractive(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      env: opts.env || process.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve({ code });
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function parseJsonSafe(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Some CLI commands emit status lines before the JSON block; recover last JSON object/array
    const firstBrace = text.search(/[\[{]/);
    if (firstBrace !== -1) {
      try {
        return JSON.parse(text.slice(firstBrace));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeProjectList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.projects)) return data.projects;
  if (Array.isArray(data?.edges)) return data.edges.map((e) => e.node).filter(Boolean);
  return [];
}

function normalizeServiceList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.services)) return data.services;
  if (Array.isArray(data?.edges)) return data.edges.map((e) => e.node).filter(Boolean);
  return [];
}

function extractDomains(data) {
  const domains = [];
  const collect = (val) => {
    if (!val) return;
    if (typeof val === 'string' && val.includes('.')) domains.push(val);
    else if (typeof val === 'object') {
      if (typeof val.domain === 'string') domains.push(val.domain);
      if (typeof val.url === 'string') {
        try {
          domains.push(new URL(val.url).host);
        } catch {}
      }
      if (Array.isArray(val.serviceDomains)) val.serviceDomains.forEach(collect);
      if (Array.isArray(val.customDomains)) val.customDomains.forEach(collect);
      if (Array.isArray(val.domains)) val.domains.forEach(collect);
    }
  };
  if (Array.isArray(data)) data.forEach(collect);
  else collect(data);
  return domains.filter(Boolean);
}

function normalizeDeploymentStatus(data) {
  const list = Array.isArray(data) ? data : data?.deployments || [];
  if (!list.length) return null;
  const first = list[0];
  return {
    id: first.id || null,
    status: String(first.status || '').toUpperCase(),
  };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Automated, idempotent end-to-end installer that deploys InControl's Railway
 * PostgreSQL + daily collector stack for a user and configures ~/.incontrol/settings.json.
 */
export async function setupRailwayArchive(options = {}) {
  const projectName = String(options.projectName || 'incontrol-archive').trim();
  const environment = String(options.environment || 'production').trim();
  const serviceName = String(options.serviceName || 'daily-archive').trim();
  const withStaging = Boolean(options.withStaging);
  const dryRun = Boolean(options.dryRun);
  const allowInstall = options.allowInstall !== false;
  const collectorDir = options.collectorDir || DEFAULT_COLLECTOR_DIR;
  const log = typeof options.log === 'function' ? options.log : (msg) => console.log(msg);
  const exec = options.exec || defaultExec;
  const interactive = options.interactive || defaultInteractive;
  const fetchImpl = options.fetch || globalThis.fetch;
  const platform = options.platform || os.platform();
  const pollIntervalMs = Number.isFinite(options.pollIntervalMs) ? options.pollIntervalMs : 5000;
  const maxPollAttempts = Number.isFinite(options.maxPollAttempts) ? options.maxPollAttempts : 48;

  if (!fs.existsSync(path.join(collectorDir, 'server.js'))) {
    throw new Error(`Collector directory not found at ${collectorDir}`);
  }

  const plannedSteps = [
    'Check or install the Railway CLI',
    'Sign in to Railway (opens browser or creates a free account on the fly)',
    `Find or create Railway project "${projectName}"`,
    `Provision managed Postgres + "${serviceName}" in "${environment}"`,
    ...(withStaging ? [`Create and deploy "staging" environment in "${projectName}"`] : []),
    `Generate a private COLLECTOR_API_TOKEN and deploy "${serviceName}"`,
    `Create a public *.up.railway.app domain and verify GET /health`,
    'Save Railway URL + token into ~/.incontrol/settings.json (0600)',
  ];

  if (dryRun) {
    return { ok: true, dryRun: true, projectName, environment, serviceName, withStaging, steps: plannedSteps };
  }

  // 1. Check / install Railway CLI
  let hasCli = true;
  try {
    await exec('railway', ['--version']);
  } catch {
    hasCli = false;
  }

  if (!hasCli) {
    if (!allowInstall) {
      throw new Error('Railway CLI is not installed. Install it via: brew install railway (macOS) or https://railway.com/install.sh');
    }
    log('Installing Railway CLI...');
    let installed = false;
    if (platform === 'darwin') {
      try {
        await exec('brew', ['--version']);
        await interactive('brew', ['install', 'railway']);
        installed = true;
      } catch {
        // fall back to official install script
      }
    }
    if (!installed) {
      await interactive('sh', ['-c', 'curl -fsSL https://railway.com/install.sh | sh']);
    }
    await exec('railway', ['--version']);
  }

  // 2. Ensure authenticated (creates an account in browser on the fly for new users)
  let authed = false;
  try {
    const who = await exec('railway', ['whoami', '--json']);
    if (parseJsonSafe(who.stdout) || who.stdout.trim()) authed = true;
  } catch {
    authed = false;
  }
  if (!authed) {
    log('Opening Railway sign-in in your browser (new accounts are created automatically)...');
    await interactive('railway', ['login']);
    await exec('railway', ['whoami', '--json']);
  }

  // Use a temporary directory for railway link/init so the user's repo stays clean
  const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'incontrol-railway-link-'));
  try {
    // 3. Find or create project
    let projectId = '';
    try {
      const listRes = await exec('railway', ['project', 'list', '--json'], { cwd: linkDir });
      const projects = normalizeProjectList(parseJsonSafe(listRes.stdout));
      const existing = projects.find((p) => String(p?.name || '').toLowerCase() === projectName.toLowerCase());
      if (existing?.id) projectId = existing.id;
    } catch {
      // try `railway list --json` fallback
      try {
        const listRes = await exec('railway', ['list', '--json'], { cwd: linkDir });
        const projects = normalizeProjectList(parseJsonSafe(listRes.stdout));
        const existing = projects.find((p) => String(p?.name || '').toLowerCase() === projectName.toLowerCase());
        if (existing?.id) projectId = existing.id;
      } catch {}
    }

    if (projectId) {
      log(`Reusing existing Railway project "${projectName}" (${projectId}).`);
      await exec('railway', ['link', '--project', projectId], { cwd: linkDir });
    } else {
      log(`Creating Railway project "${projectName}"...`);
      await exec('railway', ['init', '--name', projectName], { cwd: linkDir });
      const statusRes = await exec('railway', ['status', '--json'], { cwd: linkDir });
      const statusJson = parseJsonSafe(statusRes.stdout);
      projectId = statusJson?.id || statusJson?.project?.id || '';
    }

    // Generate or preserve collector API token before configuring environments
    const existingSettings = loadUserSettings();
    const rotateToken = Boolean(options.rotateToken);
    const token =
      !rotateToken && existingSettings.railwayToken && existingSettings.railwayUrl?.includes('up.railway.app')
        ? existingSettings.railwayToken
        : crypto.randomBytes(24).toString('hex');

    const deployIntoEnvironment = async (targetEnv, envToken) => {
      await exec('railway', ['environment', 'link', targetEnv], { cwd: linkDir }).catch(async () => {
        // Environment may not exist yet (e.g. staging)
        if (targetEnv !== 'production') {
          log(`Creating environment "${targetEnv}"...`);
          await exec('railway', ['environment', 'new', targetEnv], { cwd: linkDir });
          await exec('railway', ['environment', 'link', targetEnv], { cwd: linkDir });
        }
      });

      const svcRes = await exec('railway', ['service', 'list', '--environment', targetEnv, '--json'], { cwd: linkDir });
      const services = normalizeServiceList(parseJsonSafe(svcRes.stdout));

      const hasPostgres = services.some((s) => /postgres/i.test(String(s?.name || '')));
      if (!hasPostgres) {
        log(`Provisioning Postgres in "${targetEnv}"...`);
        await exec('railway', ['add', '--database', 'postgres', '--json'], { cwd: linkDir });
      } else {
        log(`Reusing existing Postgres database in "${targetEnv}".`);
      }

      const hasCollector = services.some(
        (s) => String(s?.name || '').toLowerCase() === serviceName.toLowerCase()
      );
      if (!hasCollector) {
        log(`Creating "${serviceName}" service in "${targetEnv}"...`);
        await exec('railway', ['add', '--service', serviceName, '--json'], { cwd: linkDir });
      } else {
        log(`Reusing existing "${serviceName}" service in "${targetEnv}".`);
      }

      // Wire DATABASE_URL reference + pass secret COLLECTOR_API_TOKEN via stdin (never argv)
      await exec(
        'railway',
        ['variable', 'set', 'DATABASE_URL=${{Postgres.DATABASE_URL}}', '--service', serviceName, '--environment', targetEnv, '--skip-deploys'],
        { cwd: linkDir }
      );
      await exec(
        'railway',
        ['variable', 'set', 'COLLECTOR_API_TOKEN', '--stdin', '--service', serviceName, '--environment', targetEnv, '--skip-deploys'],
        { cwd: linkDir, input: envToken }
      );

      log(`Deploying InControl collector to "${targetEnv}"...`);
      await exec(
        'railway',
        [
          'up',
          collectorDir,
          '--path-as-root',
          '--service',
          serviceName,
          '--environment',
          targetEnv,
          '--detach',
          '-m',
          'Deploy InControl Daily Collector',
        ],
        { cwd: linkDir }
      );

      // Poll deployment status until terminal verdict
      let finalStatus = '';
      for (let i = 0; i < maxPollAttempts; i++) {
        const depRes = await exec(
          'railway',
          ['deployment', 'list', '--service', serviceName, '--environment', targetEnv, '--json'],
          { cwd: linkDir }
        );
        const latest = normalizeDeploymentStatus(parseJsonSafe(depRes.stdout));
        finalStatus = latest?.status || '';
        if (finalStatus === 'SUCCESS') break;
        if (finalStatus === 'FAILED' || finalStatus === 'CRASHED') {
          throw new Error(`Deployment for "${serviceName}" (${targetEnv}) ended with status ${finalStatus}. Check logs with: railway logs --service ${serviceName}`);
        }
        await sleep(pollIntervalMs);
      }
      if (finalStatus !== 'SUCCESS') {
        throw new Error(`Timed out waiting for "${serviceName}" (${targetEnv}) deployment (last status: ${finalStatus || 'unknown'})`);
      }

      // Ensure a public *.up.railway.app domain exists
      let domains = [];
      try {
        const domRes = await exec(
          'railway',
          ['domain', 'list', '--service', serviceName, '--json'],
          { cwd: linkDir }
        );
        domains = extractDomains(parseJsonSafe(domRes.stdout));
      } catch {
        domains = [];
      }

      if (!domains.length) {
        log(`Generating public domain for "${serviceName}" (${targetEnv})...`);
        const createDom = await exec(
          'railway',
          ['domain', '--service', serviceName, '--json'],
          { cwd: linkDir }
        );
        domains = extractDomains(parseJsonSafe(createDom.stdout));
      }
      if (!domains.length) {
        throw new Error(`Could not resolve a public domain for "${serviceName}" (${targetEnv})`);
      }

      const publicUrl = domains[0].startsWith('http') ? domains[0].replace(/\/+$/, '') : `https://${domains[0]}`;

      // Verify live healthcheck
      let healthy = false;
      for (let i = 0; i < 6; i++) {
        try {
          const res = await fetchImpl(`${publicUrl}/health`);
          if (res.ok) {
            healthy = true;
            break;
          }
        } catch {}
        await sleep(Math.min(pollIntervalMs, 2000));
      }
      if (!healthy) {
        throw new Error(`Collector deployed to ${publicUrl}, but /health did not respond cleanly yet`);
      }

      return { environment: targetEnv, url: publicUrl };
    };

    const primaryResult = await deployIntoEnvironment(environment, token);
    let stagingResult = null;
    if (withStaging && environment !== 'staging') {
      stagingResult = await deployIntoEnvironment('staging', crypto.randomBytes(24).toString('hex'));
    }

    const railwayProjectUrl = projectId ? `https://railway.com/project/${projectId}` : '';
    saveUserSettings({
      railwayUrl: primaryResult.url,
      railwayToken: token,
      ...(railwayProjectUrl ? { railwayProjectUrl } : {}),
    });

    return {
      ok: true,
      dryRun: false,
      projectName,
      projectId,
      environment,
      serviceName,
      railwayUrl: primaryResult.url,
      railwayProjectUrl,
      stagingUrl: stagingResult?.url || null,
      configuredLocalSettings: true,
    };
  } finally {
    fs.rmSync(linkDir, { recursive: true, force: true });
  }
}
