import { hubHeaders } from './http.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import WebSocket from 'ws';

const DEFAULT_HUB_URL = process.env.INCONTROL_URL || 'http://localhost:4747';

const PROMPT_PATTERNS = [
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\[Y\/n\]/,
  /allow\s+.*\?/i,
  /approve\?/i,
  /continue\?/i,
  /press enter/i,
  /waiting for input/i,
  /\?\s*$/,
];

/**
 * Wraps any CLI agent process (e.g. codex, aider, opencode, gemini),
 * streams its state to InControl, and pipes remote replies from the panel/phone into stdin.
 */
export async function runCliWrapper(args = []) {
  const hubUrl = process.env.INCONTROL_URL || DEFAULT_HUB_URL;
  const dashIdx = args.indexOf('--');
  const flagArgs = dashIdx !== -1 ? args.slice(0, dashIdx) : [];
  const cmdArgs = dashIdx !== -1 ? args.slice(dashIdx + 1) : args;

  if (cmdArgs.length === 0) {
    console.error('Usage: incontrol wrap [--name <Name>] [--ide <IDE>] -- <command> [args...]');
    process.exit(1);
  }

  const command = cmdArgs[0];
  const commandArgs = cmdArgs.slice(1);
  const name = getFlag(flagArgs, '--name') || command;
  const provider = getFlag(flagArgs, '--provider') || command.toLowerCase();
  const ide = getFlag(flagArgs, '--ide') || process.env.TERM_PROGRAM || 'Terminal';
  const workspace = process.cwd();
  const projectName = path.basename(workspace) || 'workspace';
  const agentId = `${provider}-${projectName}-${process.pid}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');

  await reportEvent(hubUrl, {
    id: agentId,
    name,
    provider,
    ide,
    workspace,
    pid: process.pid,
    status: 'working',
    currentTask: `${command} ${commandArgs.join(' ')}`.trim(),
    currentStep: 'Starting CLI agent process...',
  });

  const child = spawn(command, commandArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    cwd: workspace,
  });

  // Forward local terminal stdin to child
  if (process.stdin.isTTY) {
    process.stdin.on('data', (chunk) => {
      child.stdin.write(chunk);
    });
  }

  // Connect WebSocket to receive instant remote replies from Phone or Side Panel
  const wsUrl = hubUrl.replace(/^http/, 'ws') + '/ws';
  const ws = new WebSocket(wsUrl, { headers: hubHeaders(false) });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (
        msg.type === 'state_sync' &&
        msg.changeEvent?.type === 'agent_responded' &&
        msg.changeEvent?.agent?.id === agentId
      ) {
        // Handled via message polling below to avoid duplicate writes
      }
    } catch {}
  });
  ws.on('error', () => {});

  // Poll queued messages for this wrapped CLI agent
  const pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`${hubUrl}/api/agents/${encodeURIComponent(agentId)}/messages`, { headers: hubHeaders(false) });
      const data = await res.json();
      if (Array.isArray(data.messages)) {
        for (const msg of data.messages) {
          let inputLine = msg.text;
          if (!inputLine) {
            if (msg.action === 'approve' || msg.action === 'yes') inputLine = 'y';
            else if (msg.action === 'deny' || msg.action === 'no') inputLine = 'n';
          }
          if (inputLine !== undefined && inputLine !== null) {
            child.stdin.write(`${inputLine}\n`);
          }
        }
      }
    } catch {}
  }, 700);

  let lastReportAt = 0;

  function handleOutput(chunk) {
    const text = chunk.toString('utf8');
    const clean = stripAnsi(text).trim();
    if (!clean) return;

    const lastLine = clean.split(/\r?\n/).pop()?.trim() || clean.slice(0, 120);
    const isPrompt = PROMPT_PATTERNS.some((re) => re.test(lastLine));

    if (isPrompt) {
      fetch(`${hubUrl}/api/agents/ask`, {
        method: 'POST',
        headers: hubHeaders(),
        body: JSON.stringify({
          id: agentId,
          name,
          provider,
          ide,
          workspace,
          wait: false,
          question: lastLine,
          toolName: `${name} CLI Prompt`,
          options: [
            { id: 'yes', label: 'Yes (y)', style: 'primary' },
            { id: 'no', label: 'No (n)', style: 'danger' },
          ],
          allowFreeText: true,
        }),
      }).catch(() => {});
      return;
    }

    const now = Date.now();
    if (now - lastReportAt > 800) {
      lastReportAt = now;
      reportEvent(hubUrl, {
        id: agentId,
        name,
        provider,
        ide,
        workspace,
        status: 'working',
        currentStep: lastLine.slice(0, 120),
        logType: 'tool',
        logMessage: lastLine.slice(0, 120),
      });
    }
  }

  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    handleOutput(chunk);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    handleOutput(chunk);
  });

  child.on('exit', async (code) => {
    clearInterval(pollTimer);
    ws.close();
    await reportEvent(hubUrl, {
      id: agentId,
      name,
      provider,
      ide,
      workspace,
      status: 'needs_attention',
      currentStep: `Process exited with code ${code ?? 0}`,
      attentionReason: `${name} finished execution (exit code ${code ?? 0}).`,
      logType: code === 0 ? 'success' : 'error',
      logMessage: `Process exited with code ${code ?? 0}`,
    });
    process.exit(code ?? 0);
  });
}

async function reportEvent(hubUrl, payload) {
  try {
    await fetch(`${hubUrl}/api/agents/event`, {
      method: 'POST',
      headers: hubHeaders(),
      body: JSON.stringify(payload),
    });
  } catch {}
}

function stripAnsi(str) {
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function getFlag(args, flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}
