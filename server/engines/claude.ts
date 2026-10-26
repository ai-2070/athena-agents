// Claude Code engine: runs the `claude` CLI headless (stream-json), one process per message,
// resuming the same Claude session so the conversation continues.
import fs from 'node:fs';
import path from 'node:path';
import { dataPath, ensureDir, which, spawnCommand, killTree, run as runCmd, HOME, isInside } from '../util.ts';
import { getSecrets } from '../store.ts';
import { claudeMcpConfig } from '../mcp.ts';
import { workspaceOf } from '../tools.ts';
import { knowledgeRoots } from '../knowledge.ts';
import { uploadsRoot } from '../uploads.ts';
import type { Agent, Chat, EngineStatus } from '../../shared/types.ts';
import type { EngineRunArgs, EngineResult } from './index.ts';

/** The per-run files Claude Code reads (prepareFiles). */
export interface ClaudeFiles {
  promptFile: string;
  mcpFile: string;
  cleanup: () => void;
}

/** A content block in Claude Code's stream-json messages (only the fields used here). */
interface ClaudeBlock {
  type: string;
  id: string;
  name: string;
  text: string;
  input?: Record<string, unknown>;
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

/** One line of `claude -p --output-format stream-json`. */
interface ClaudeStreamMsg {
  type?: string;
  subtype?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  event?: { type?: string; message?: { id?: string }; delta?: { type?: string; text: string } };
  message?: { id?: string; content?: ClaudeBlock[] };
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  model?: string;
  mcp_servers?: { name: string; status?: string }[];
}

let versionCache: string | null = null;
export function status(): EngineStatus['claude-code'] {
  const exe = which('claude');
  if (exe && !versionCache) {
    versionCache = 'checking';
    runCmd('claude', ['--version'], { timeout: 20000 }).then((r) => (versionCache = r.stdout.trim() || 'unknown'));
  }
  const loggedIn = fs.existsSync(path.join(HOME, '.claude', '.credentials.json')) || !!process.env.ANTHROPIC_API_KEY;
  return { installed: !!exe, path: exe, loggedIn, version: versionCache === 'checking' ? null : versionCache };
}

export const CLAUDE_MODELS: { id: string; name: string }[] = [
  { id: 'sonnet', name: 'Sonnet · always the latest (now 5.5)' },
  { id: 'opus', name: 'Opus · always the latest (now 5.5)' },
  { id: 'haiku', name: 'Haiku · always the latest (now 5.5)' },
  { id: 'fable', name: 'Fable · always the latest (now 5.1)' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1' },
];

const PERMISSION_TOOL = 'mcp__dashboard__permission_prompt';

// Files Claude Code reads for this agent: instructions and MCP servers.
// One pair of files per run, so two chats with the same agent don't share a run id.
export function prepareFiles(agent: Agent, systemPrompt: string, runId = ''): ClaudeFiles {
  const dir = ensureDir(dataPath('runtime', agent.id));
  const tag = runId || 'terminal';
  const promptFile = path.join(dir, `${tag}-system-prompt.md`);
  const mcpFile = path.join(dir, `${tag}-mcp.json`);
  fs.writeFileSync(promptFile, systemPrompt);
  fs.writeFileSync(mcpFile, JSON.stringify(claudeMcpConfig(agent.id, agent.mcpServers || [], runId), null, 2));
  return { promptFile, mcpFile, cleanup: () => runId && [promptFile, mcpFile].forEach((f) => fs.rm(f, { force: true }, () => {})) };
}

export function claudeEnv(agent: Agent): NodeJS.ProcessEnv {
  // Tool calls may wait for your approval, or run long renders: give them an hour.
  const env: NodeJS.ProcessEnv = { ...process.env, MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT || '3600000' };
  const s = getSecrets();
  if (agent.claudeAuth === 'anthropic') {
    if (!s.anthropicKey) throw new Error('Add an Anthropic API key in Settings, or switch this agent to your Claude login.');
    env.ANTHROPIC_API_KEY = s.anthropicKey;
  } else if (agent.claudeAuth === 'openrouter') {
    if (!s.openrouterKey) throw new Error('Add your OpenRouter key in Settings first.');
    env.ANTHROPIC_BASE_URL = 'https://openrouter.ai/api';
    env.ANTHROPIC_AUTH_TOKEN = s.openrouterKey;
    env.ANTHROPIC_API_KEY = '';
  }
  return env;
}

export function claudeArgs(agent: Agent, { promptFile, mcpFile, interactive = false }: { promptFile: string; mcpFile: string; interactive?: boolean }): string[] {
  const args: string[] = [];
  if (!interactive) args.push('-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages');
  if (agent.model) args.push('--model', agent.model);
  args.push('--append-system-prompt-file', promptFile);
  args.push('--mcp-config', mcpFile);
  const mode = agent.autonomy || 'auto';
  if (mode === 'full') args.push('--permission-mode', 'bypassPermissions');
  else {
    args.push('--permission-mode', mode === 'auto' ? 'auto' : 'acceptEdits');
    if (!interactive) args.push('--permission-prompt-tool', PERMISSION_TOOL);
  }
  args.push('--allowedTools', 'mcp__dashboard', ...(mode !== 'ask' ? (agent.mcpServers || []).map((s) => `mcp__${s}`) : []));
  const dirs = knowledgeRoots(agent);
  if (dirs.length) args.push('--add-dir', ...dirs);
  return args;
}

// Attached files live in the Brain folder's uploads/: an agent with its own workspace needs it added.
// A resumed session doesn't keep --add-dir, so a file attached earlier in the chat counts too.
export function uploadsDirArgs(agent: Agent, chat: Pick<Chat, 'items'>, attachments: string[] = []): string[] {
  const uploads = uploadsRoot();
  const hadFiles = attachments.length > 0 || chat.items.some((i) => i.type === 'user' && !!i.attachments?.length);
  return hadFiles && !isInside(workspaceOf(agent), uploads) ? ['--add-dir', uploads] : [];
}

export async function run({ agent, chat, text, signal, onEvent, systemPrompt, runId, attachments }: EngineRunArgs): Promise<EngineResult> {
  if (!which('claude')) throw new Error('Claude Code is not installed (the `claude` command was not found).');
  const files = prepareFiles(agent, systemPrompt, runId);
  try {
    return await runClaude({ agent, chat, text, signal, onEvent, files, attachments });
  } finally {
    files.cleanup();
  }
}

async function runClaude({ agent, chat, text, signal, onEvent, files, attachments = [] }: Pick<EngineRunArgs, 'agent' | 'chat' | 'text' | 'signal' | 'onEvent'> & { files: ClaudeFiles; attachments?: string[] }): Promise<EngineResult> {
  const args = [...claudeArgs(agent, files), ...uploadsDirArgs(agent, chat, attachments)];
  if (chat.sessionId) args.push('--resume', chat.sessionId);
  const child = spawnCommand('claude', args, { cwd: workspaceOf(agent), env: claudeEnv(agent), stdio: ['pipe', 'pipe', 'pipe'] });
  const onAbort = () => killTree(child);
  signal.addEventListener('abort', onAbort);

  let buf = '';
  let stderr = '';
  // (cast: TypeScript can't see the callback below set it)
  let result = null as ClaudeStreamMsg | null;
  const streamed = new Set<string | undefined>();
  let currentMsg: string | null = null;
  let gotSession = false;

  const handle = (msg: ClaudeStreamMsg) => {
    if (msg.session_id && !gotSession) {
      chat.sessionId = msg.session_id;
      gotSession = true;
    }
    if (msg.parent_tool_use_id) return; // inside a Claude sub-agent: the parent's tool call shows it
    if (msg.type === 'stream_event') {
      const ev: NonNullable<ClaudeStreamMsg['event']> = msg.event || {};
      if (ev.type === 'message_start') currentMsg = ev.message?.id || null;
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        if (currentMsg) streamed.add(currentMsg);
        onEvent({ kind: 'text', text: ev.delta.text });
      }
    } else if (msg.type === 'assistant') {
      const m: NonNullable<ClaudeStreamMsg['message']> = msg.message || {};
      for (const block of m.content || []) {
        if (block.type === 'text' && !streamed.has(m.id)) onEvent({ kind: 'text', text: block.text });
        if (block.type === 'tool_use') onEvent({ kind: 'tool', id: block.id, name: prettyTool(block.name), args: block.input });
      }
    } else if (msg.type === 'user') {
      for (const block of msg.message?.content || []) {
        if (block.type !== 'tool_result') continue;
        const content = Array.isArray(block.content) ? (block.content as { type: string; text?: string }[]).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n') : String(block.content ?? '');
        onEvent({ kind: 'tool_result', id: block.tool_use_id, text: content, isError: !!block.is_error });
      }
    } else if (msg.type === 'result') {
      result = msg;
    } else if (msg.type === 'system' && msg.subtype === 'init') {
      if (msg.model) onEvent({ kind: 'model', model: msg.model });
      const mine = new Set(['dashboard', ...(agent.mcpServers || [])]);
      const failed = (msg.mcp_servers || []).filter((s) => mine.has(s.name) && s.status && s.status !== 'connected' && s.status !== 'pending');
      if (failed.length) onEvent({ kind: 'status', text: `MCP not connected: ${failed.map((s) => `${s.name} (${s.status})`).join(', ')}` });
    }
  };

  const parseLines = (final = false) => {
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1 || (final && buf.trim())) {
      const end = nl === -1 ? buf.length : nl;
      const line = buf.slice(0, end).trim();
      buf = buf.slice(end + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line) as ClaudeStreamMsg);
      } catch {
        /* not JSON: ignore */
      }
    }
  };
  // stdio is all 'pipe' above, so these streams exist.
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (d: string) => {
    buf += d;
    parseLines();
  });
  child.stderr!.on('data', (d: string) => {
    if (stderr.length < 200_000) stderr += d;
  });
  child.stdin!.on('error', () => {});
  child.stdin!.end(text);

  const code = await new Promise<number | null>((resolve) => {
    child.on('close', resolve);
    child.on('error', (e) => {
      stderr += e.message;
      resolve(-1);
    });
  });
  parseLines(true);
  signal.removeEventListener('abort', onAbort);
  if (signal.aborted) throw new Error('Stopped.');
  if (!result) {
    // A resumed session that no longer exists: start a new one next time.
    if (/No conversation found/i.test(stderr) && chat.sessionId) chat.sessionId = null;
    throw new Error(`Claude Code exited (${code}) without an answer.${stderr ? `\n${stderr.trim().slice(-1500)}` : ''}`);
  }
  if (result.is_error) throw new Error(result.result || `Claude Code reported an error (${result.subtype}).`);
  return { text: result.result || '', cost: agent.claudeAuth && agent.claudeAuth !== 'login' ? result.total_cost_usd || 0 : 0 };
}

function prettyTool(name: string): string {
  return name.startsWith('mcp__dashboard__') ? name.slice('mcp__dashboard__'.length) : name;
}
