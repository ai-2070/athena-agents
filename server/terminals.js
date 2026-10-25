// Live terminals in the browser (like Agent Office's desks): PowerShell, Claude Code, Hermes, Orca or an agent.
import pty from '@lydell/node-pty';
import { which, uid, IS_WIN, HOME } from './util.js';
import { emit, log } from './store.js';
import { prepareFiles, claudeArgs, claudeEnv } from './engines/claude.js';
import { hermesArgs } from './engines/hermes.js';
import { buildSystemPrompt } from './engines/index.js';
import { workspaceOf } from './tools.js';

const sessions = new Map();
const MAX_BUFFER = 400_000;

export function listTerminals() {
  return [...sessions.values()].map(({ id, title, agentId, createdAt, exited, exitCode, command }) => ({ id, title, agentId, createdAt, exited, exitCode, command }));
}

function spawnPty(command, args, { cwd, env, cols = 120, rows = 32 }) {
  let file = which(command) || command;
  let argv = args;
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    argv = ['/d', '/c', file, ...args];
    file = process.env.ComSpec || 'cmd.exe';
  }
  return pty.spawn(file, argv, { name: 'xterm-256color', cols, rows, cwd: cwd || HOME, env: { ...(env || process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' } });
}

export function createTerminal({ kind = 'shell', agent = null, command = null, args = [], title = null, cwd = null, cols, rows }) {
  let cmd;
  let argv = [];
  let env = process.env;
  let dir = cwd || HOME;
  let name = title;
  if (kind === 'agent' && agent) {
    dir = workspaceOf(agent);
    if (agent.engine === 'claude-code') {
      const files = prepareFiles(agent, buildSystemPrompt(agent));
      cmd = 'claude';
      argv = claudeArgs(agent, { ...files, interactive: true });
      env = claudeEnv(agent);
    } else if (agent.engine === 'hermes') {
      cmd = 'hermes';
      argv = hermesArgs(agent, { interactive: true });
    } else throw new Error('API-model agents chat in the dashboard; open a terminal for a Claude Code or Hermes agent.');
    name ||= `${agent.emoji || ''} ${agent.name}`.trim();
  } else if (kind === 'command' && command) {
    cmd = command;
    argv = args;
    name ||= [command, ...args].join(' ');
  } else {
    cmd = IS_WIN ? 'powershell.exe' : process.env.SHELL || 'bash';
    argv = IS_WIN ? ['-NoLogo'] : [];
    name ||= 'PowerShell';
  }
  if (!which(cmd) && !IS_WIN) throw new Error(`${cmd} was not found.`);
  const p = spawnPty(cmd, argv, { cwd: dir, env, cols, rows });
  const id = uid('t');
  const s = { id, title: name, agentId: agent?.id || null, command: [cmd, ...argv].join(' ').slice(0, 300), pty: p, buffer: '', clients: new Set(), createdAt: Date.now(), exited: false, exitCode: null };
  p.onData((d) => {
    s.buffer += d;
    if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER);
    for (const ws of s.clients) if (ws.readyState === 1) ws.send(d);
  });
  p.onExit(({ exitCode }) => {
    s.exited = true;
    s.exitCode = exitCode;
    const msg = `\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`;
    s.buffer += msg;
    for (const ws of s.clients) if (ws.readyState === 1) ws.send(msg);
    emit('terminals');
  });
  sessions.set(id, s);
  emit('terminals');
  log('terminal', `Opened terminal: ${name}`, { agentId: agent?.id });
  return { id, title: name };
}

export function attachTerminal(id, ws) {
  const s = sessions.get(id);
  if (!s) {
    ws.close(4004, 'no such terminal');
    return;
  }
  s.clients.add(ws);
  if (s.buffer) ws.send(s.buffer);
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (s.exited) return;
    if (msg.type === 'input') s.pty.write(msg.data);
    else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
      try {
        s.pty.resize(Math.min(msg.cols, 500), Math.min(msg.rows, 200));
      } catch {
        /* exited */
      }
    }
  });
  ws.on('close', () => s.clients.delete(ws));
}

export function closeTerminal(id) {
  const s = sessions.get(id);
  if (!s) return false;
  try {
    s.pty.kill();
  } catch {
    /* gone */
  }
  for (const ws of s.clients) ws.close();
  sessions.delete(id);
  emit('terminals');
  return true;
}

export function closeAll() {
  for (const id of [...sessions.keys()]) closeTerminal(id);
}
