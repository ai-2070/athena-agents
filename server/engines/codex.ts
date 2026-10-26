// OpenAI Codex engine: runs `codex exec --json` (your ChatGPT login via `codex login`, or an API key),
// resuming the same Codex thread so the conversation continues. The dashboard tools come in as an MCP server.
import fs from 'node:fs';
import path from 'node:path';
import { which, spawnCommand, killTree, run as runCmd, ROOT, PORT, dataPath, ensureDir } from '../util.ts';
import { internalToken } from '../store.ts';
import { listServers } from '../mcp.ts';
import { workspaceOf } from '../tools.ts';
import { effortFor } from '../../shared/effort.ts';
import type { Agent } from '../../shared/types.ts';
import type { EngineRunArgs, EngineResult } from './index.ts';

/** EngineStatus['codex'] plus the first line of `codex login status` and where codex is. */
export interface CodexStatus {
  installed: boolean;
  loggedIn: boolean;
  version: string | null;
  how?: string;
}

/** An item in `codex exec --json` events (only the fields used here). */
interface CodexItem {
  id: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string | null;
  exit_code?: number | null;
  server?: string;
  tool?: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  status?: string;
  changes?: { path: string }[];
  query?: string;
  message?: string;
}

interface CodexUsage {
  input_tokens?: number;
  output_tokens?: number;
}

/** One line of `codex exec --json`. */
interface CodexEvent {
  type?: string;
  thread_id?: string;
  usage?: CodexUsage | null;
  error?: { message?: string };
  message?: string;
  item?: CodexItem;
}

let statusCache: { at: number; value: CodexStatus } = { at: 0, value: { installed: false, loggedIn: false, version: null } };
export function status(): CodexStatus & { path: string | null } {
  const exe = which('codex');
  if (Date.now() - statusCache.at > 60_000) {
    statusCache.at = Date.now();
    if (exe) {
      Promise.all([runCmd('codex', ['--version'], { timeout: 20000 }), runCmd('codex', ['login', 'status'], { timeout: 20000 })]).then(([v, l]) => {
        const out = `${l.stdout}\n${l.stderr}`;
        statusCache.value = { installed: true, version: v.stdout.trim().replace(/^codex-cli\s*/, ''), loggedIn: /logged in/i.test(out) && !/not logged in/i.test(out), how: out.trim().split('\n')[0] };
      });
    } else statusCache.value = { installed: false, loggedIn: false, version: null };
  }
  return { ...statusCache.value, installed: !!exe, path: exe };
}
export const refreshStatus = () => (statusCache.at = 0);

// TOML values for -c overrides (Codex parses the value part as TOML).
const tstr = (s: unknown): string => JSON.stringify(String(s).replace(/\\/g, '/'));
const ttable = (o: Record<string, unknown>): string => `{${Object.entries(o).map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}=${JSON.stringify(String(v))}`).join(',')}}`;

// The interactive terminal has no first message to carry the agent brief (see run()), so it goes
// in a file and Codex's developer instructions point there. Only a short path goes on the command line.
export function terminalPromptFile(agent: Agent, systemPrompt: string): string {
  const file = path.join(ensureDir(dataPath('runtime', agent.id)), 'terminal-codex-instructions.md');
  fs.writeFileSync(file, systemPrompt);
  return file;
}

export function codexArgs(agent: Agent, { runId = '', interactive = false, promptFile = '' }: { runId?: string; interactive?: boolean; promptFile?: string } = {}): string[] {
  const args: string[] = interactive ? [] : ['exec', '--json', '--skip-git-repo-check'];
  args.push('-C', workspaceOf(agent));
  if (agent.model) args.push('-m', agent.model);
  const effort = effortFor('codex', agent.effort);
  if (effort) args.push('-c', `model_reasoning_effort=${tstr(effort)}`);
  if (promptFile) args.push('-c', `developer_instructions=${tstr(`Your agent instructions are in ${promptFile}. Read that file before anything else and follow it for this whole session.`)}`);
  // the dashboard's own tools, plus the agent's MCP servers
  const bridge = { DASH_PORT: String(PORT), DASH_TOKEN: internalToken(), DASH_AGENT: agent.id, ...(runId ? { DASH_RUN: runId } : {}) };
  args.push('-c', `mcp_servers.dashboard.command=${tstr(process.execPath)}`);
  args.push('-c', `mcp_servers.dashboard.args=[${tstr(path.join(ROOT, 'server', 'mcp-bridge.ts'))}]`);
  args.push('-c', `mcp_servers.dashboard.env=${ttable(bridge)}`);
  args.push('-c', 'mcp_servers.dashboard.tool_timeout_sec=3600');
  const servers = listServers();
  for (const name of agent.mcpServers || []) {
    const cfg = servers[name];
    if (!cfg || cfg.enabled === false || !/^[\w-]+$/.test(name)) continue;
    if (cfg.type === 'stdio') {
      args.push('-c', `mcp_servers.${name}.command=${tstr(cfg.command)}`);
      args.push('-c', `mcp_servers.${name}.args=[${(cfg.args || []).map(tstr).join(',')}]`);
      if (Object.keys(cfg.env || {}).length) args.push('-c', `mcp_servers.${name}.env=${ttable(cfg.env)}`);
    } else {
      args.push('-c', `mcp_servers.${name}.url=${tstr(cfg.url)}`);
      if (Object.keys(cfg.headers || {}).length) args.push('-c', `mcp_servers.${name}.http_headers=${ttable(cfg.headers)}`);
    }
  }
  // autonomy → Codex sandbox
  const mode = agent.autonomy || 'auto';
  if (mode === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
  else if (mode === 'auto') args.push('-s', 'workspace-write', ...(interactive ? [] : ['--approve-for-me']));
  else args.push('-s', 'read-only');
  return args;
}

export async function run({ agent, chat, text, signal, onEvent, systemPrompt, runId }: EngineRunArgs): Promise<EngineResult> {
  if (!which('codex')) throw new Error('OpenAI Codex is not installed. Install it in Settings > General (or run: npm install -g @openai/codex), then sign in with "codex login".');
  const args = codexArgs(agent, { runId });
  if (chat.sessionId) args.push('resume', chat.sessionId, '-');
  else args.push('-');
  // Codex keeps its own system prompt; the agent brief goes with the first message.
  const prompt = chat.sessionId ? text : `<agent-instructions>\n${systemPrompt}\n</agent-instructions>\n\n${text}`;
  const child = spawnCommand('codex', args, { cwd: workspaceOf(agent), stdio: ['pipe', 'pipe', 'pipe'] });
  const onAbort = () => killTree(child);
  signal.addEventListener('abort', onAbort);
  let buf = '';
  let stderr = '';
  let answer = '';
  let lastError = '';
  // (cast: TypeScript can't see the callback below set it)
  let usage = null as CodexUsage | null;

  const handle = (ev: CodexEvent) => {
    if (ev.type === 'thread.started' && ev.thread_id) chat.sessionId = ev.thread_id;
    else if (ev.type === 'turn.completed') usage = ev.usage || null;
    else if (ev.type === 'turn.failed') lastError = ev.error?.message || 'Codex failed.';
    else if (ev.type === 'error') {
      lastError = ev.message || lastError;
      if (/Reconnecting/.test(ev.message || '')) onEvent({ kind: 'status', text: ev.message!.slice(0, 120) });
    } else if (ev.type === 'item.started' || ev.type === 'item.completed') {
      const it = ev.item || ({} as CodexItem);
      const done = ev.type === 'item.completed';
      if (it.type === 'agent_message' && done) {
        const t = it.text || '';
        onEvent({ kind: 'text', text: (answer ? '\n\n' : '') + t });
        answer += (answer ? '\n\n' : '') + t;
      } else if (it.type === 'reasoning' && done) onEvent({ kind: 'status', text: 'Thinking…' });
      else if (it.type === 'command_execution') {
        if (!done) onEvent({ kind: 'tool', id: it.id, name: 'Bash', args: { command: it.command } });
        else onEvent({ kind: 'tool_result', id: it.id, text: String(it.aggregated_output ?? '').slice(0, 20000), isError: it.exit_code != null && it.exit_code !== 0 });
      } else if (it.type === 'mcp_tool_call') {
        const name = (it.server === 'dashboard' ? it.tool : `${it.server}__${it.tool}`) as string;
        if (!done) onEvent({ kind: 'tool', id: it.id, name, args: it.arguments || {} });
        else onEvent({ kind: 'tool_result', id: it.id, text: JSON.stringify(it.result ?? it.error ?? '').slice(0, 20000), isError: !!it.error || it.status === 'failed' });
      } else if (it.type === 'file_change') {
        const files = (it.changes || []).map((c) => c.path).join(', ');
        if (!done) onEvent({ kind: 'tool', id: it.id, name: 'Edit', args: { file_path: files } });
        else onEvent({ kind: 'tool_result', id: it.id, text: `Changed: ${files}` });
      } else if (it.type === 'web_search') {
        if (!done) onEvent({ kind: 'tool', id: it.id, name: 'WebSearch', args: { query: it.query } });
        else onEvent({ kind: 'tool_result', id: it.id, text: it.query || '' });
      } else if (it.type === 'error' && done) onEvent({ kind: 'status', text: String(it.message || '').slice(0, 140) });
    }
  };

  // stdio is all 'pipe' above, so these streams exist.
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdin!.on('error', () => {});
  child.stdout!.on('data', (d: string) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('{')) continue;
      try {
        handle(JSON.parse(line) as CodexEvent);
      } catch {
        /* skip */
      }
    }
  });
  child.stderr!.on('data', (d: string) => {
    if (stderr.length < 100_000) stderr += d;
  });
  child.stdin!.end(prompt);
  const code = await new Promise<number | null>((resolve) => {
    child.on('close', resolve);
    child.on('error', (e) => {
      stderr += e.message;
      resolve(-1);
    });
  });
  if (buf.trim().startsWith('{')) {
    try {
      handle(JSON.parse(buf.trim()) as CodexEvent);
    } catch {
      /* partial */
    }
  }
  signal.removeEventListener('abort', onAbort);
  if (signal.aborted) throw new Error('Stopped.');
  if (!answer) {
    if (/401|Unauthorized|not logged in|login/i.test(lastError + stderr)) throw new Error('Codex is not signed in. Open Settings > General > OpenAI Codex > Sign in (runs "codex login").');
    throw new Error(lastError || `Codex exited (${code}) without an answer.${stderr ? `\n${stderr.trim().slice(-1200)}` : ''}`);
  }
  return { text: answer, tokens: usage ? (usage.input_tokens || 0) + (usage.output_tokens || 0) : 0 };
}
