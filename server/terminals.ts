// Live terminals in the browser (like Agent Office's desks): PowerShell, Claude Code, Hermes, Orca or an agent.
import pty from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';
import type { WebSocket } from 'ws';
import type { Agent, Terminal } from '../shared/types.ts';
import { which, uid, IS_WIN, HOME, shimTarget } from './util.ts';
import { activeProject, emit, log } from './store.ts';
import { prepareFiles, claudeArgs, claudeEnv } from './engines/claude.ts';
import { hermesArgs } from './engines/hermes.ts';
import { codexLaunch, terminalPromptFile } from './engines/codex.ts';
import { terminalArgs as piTerminalArgs } from './engines/pi.ts';
import { bridgeEnv } from './engines/cli.ts';
import { openclawTerminalArgs } from './engines/openclaw.ts';
import { terminalLaunch as opencodeTerminal } from './engines/opencode.ts';
import { buildSystemPrompt } from './engines/index.ts';
import { workspaceOf } from './tools.ts';

/** A live terminal: what the browser sees (Terminal) plus the pty, its scrollback and the sockets watching it. */
export interface TerminalSession extends Terminal {
  pty: IPty;
  buffer: string;
  clients: Set<WebSocket>;
}

export interface CreateTerminalOptions {
  kind?: 'shell' | 'agent' | 'command' | string;
  agent?: Agent | null;
  command?: string | null;
  args?: string[];
  title?: string | null;
  cwd?: string | null;
  cols?: number;
  rows?: number;
}

const sessions = new Map<string, TerminalSession>();
const MAX_BUFFER = 400_000;

export function listTerminals(): Terminal[] {
  return [...sessions.values()].map(({ id, title, agentId, createdAt, exited, exitCode, command, projectId }) => ({
    id,
    title,
    agentId,
    createdAt,
    exited,
    exitCode,
    command,
    ...(projectId ? { projectId } : {}),
  }));
}

/** What a terminal starts for a command: the program and its arguments (see the .cmd note below). */
export function ptyCommand(command: string, args: string[]): { file: string; argv: string[] } {
  let file = which(command) || command;
  let argv = args;
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    // An npm-installed CLI (codex.cmd, claude.cmd) only starts node with its script: that starts directly, so its
    // arguments reach it as they are. Anything else goes through cmd.exe, which reads & | < > ^ % ! " as its own:
    // an argument with one is refused rather than split into another command.
    const direct = shimTarget(file);
    if (direct) {
      argv = [...direct.args, ...args];
      file = direct.command;
    } else {
      const bad = args.find((a) => /["%!^&|<>\r\n]/.test(String(a)));
      if (bad !== undefined)
        throw new Error(
          `This argument has characters that can't be passed safely to ${file}: ${String(bad).slice(0, 80)}`,
        );
      argv = ['/d', '/c', file, ...args];
      file = process.env.ComSpec || 'cmd.exe';
    }
  }
  return { file, argv };
}

function spawnPty(
  command: string,
  args: string[],
  {
    cwd,
    env,
    cols = 120,
    rows = 32,
  }: { cwd?: string | null; env?: NodeJS.ProcessEnv | null; cols?: number; rows?: number },
): IPty {
  const { file, argv } = ptyCommand(command, args);
  return pty.spawn(file, argv, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: cwd || HOME,
    env: { ...(env || process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
}

export function createTerminal({
  kind = 'shell',
  agent = null,
  command = null,
  args = [],
  title = null,
  cwd = null,
  cols,
  rows,
}: CreateTerminalOptions): { id: string; title: string } {
  let cmd: string;
  let argv: string[] = [];
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
    } else if (agent.engine === 'codex') {
      cmd = 'codex';
      const launch = codexLaunch(agent, {
        interactive: true,
        promptFile: terminalPromptFile(agent, buildSystemPrompt(agent)),
      });
      argv = launch.args;
      env = { ...process.env, ...launch.env };
    } else if (agent.engine === 'pi' || agent.engine === 'omp') {
      cmd = agent.engine;
      argv = piTerminalArgs(agent.engine, agent, buildSystemPrompt(agent));
      env = { ...process.env, ...bridgeEnv(agent.id) };
    } else if (agent.engine === 'openclaw') {
      cmd = 'openclaw';
      argv = openclawTerminalArgs(agent);
    } else if (agent.engine === 'opencode') {
      cmd = 'opencode';
      const launch = opencodeTerminal(agent, buildSystemPrompt(agent));
      argv = launch.args;
      env = launch.env;
    } else
      throw new Error(
        'API-model agents chat in the dashboard; open a terminal for a Claude Code, Codex, Hermes, pi, oh-my-pi, OpenClaw or opencode agent.',
      );
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
  const s: TerminalSession = {
    id,
    title: name,
    agentId: agent?.id || null,
    command: [cmd, ...argv].join(' ').slice(0, 300),
    pty: p,
    buffer: '',
    clients: new Set(),
    createdAt: Date.now(),
    exited: false,
    exitCode: null,
    projectId: activeProject().id,
  };
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

export function attachTerminal(id: string | null, ws: WebSocket) {
  const s = sessions.get(id ?? '');
  if (!s) {
    ws.close(4004, 'no such terminal');
    return;
  }
  s.clients.add(ws);
  if (s.buffer) ws.send(s.buffer);
  ws.on('message', (raw) => {
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(raw.toString()) as typeof msg;
    } catch {
      return;
    }
    if (s.exited) return;
    if (msg.type === 'input') s.pty.write(msg.data as string);
    else if (msg.type === 'resize' && msg.cols! > 0 && msg.rows! > 0) {
      try {
        s.pty.resize(Math.min(msg.cols!, 500), Math.min(msg.rows!, 200));
      } catch {
        /* exited */
      }
    }
  });
  ws.on('close', () => s.clients.delete(ws));
}

export function closeTerminal(id: string): boolean {
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
