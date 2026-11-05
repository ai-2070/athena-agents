// pi and oh-my-pi engines: one `pi --mode rpc` (or `omp --mode rpc`) run per message, continuing the
// chat's own session. The two share one event stream (oh-my-pi is built on pi), so one engine serves both.
// Their input stays open while they work: a message sent meanwhile goes in as a steer, and they read it
// before their next step (or, while they write their final answer, right after it, in the same run).
// They bring their own tools (read, bash, edit, write…), run them without asking, and get the dashboard
// tools once the bridge is added to their mcp.json (addBridge: the MCP servers page).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { which, spawnCommand, run as runCmd, BRIDGE_SCRIPT, PORT, DATA, HOME, dataPath, ensureDir, writeJSON } from '../util.ts';
import { emit, internalToken, log } from '../store.ts';
import { toolDefs, workspaceOf } from '../tools.ts';
import { effortFor } from '../../shared/effort.ts';
import { cliStatus, openInputs, pipeLines, tail, SessionGone } from './cli.ts';
import { splitContent } from '../toolimages.ts';
import { withAttachments } from '../uploads.ts';
import type { ChildProcess } from 'node:child_process';
import type { CliStatus } from './cli.ts';
import type { Agent, RunEvent } from '../../shared/types.ts';
import type { Engine, EngineRunArgs, EngineResult } from './index.ts';

export type PiFlavor = 'pi' | 'omp';
const LABEL: Record<PiFlavor, string> = { pi: 'pi', omp: 'oh-my-pi' };
const INSTALL: Record<PiFlavor, string> = { pi: 'npm install -g @earendil-works/pi-coding-agent', omp: 'bun install -g @oh-my-pi/pi-coding-agent' };

// ---------- the event stream (only the fields used here) ----------
interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}
interface PiContent {
  type?: string;
  text?: string;
}
interface PiMessage {
  role?: string;
  content?: PiContent[] | string;
  provider?: string;
  model?: string;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}
/** One line of `pi --mode json` / `omp --mode json`. */
export interface PiEvent {
  type?: string;
  /** the session header (first line) */
  id?: string;
  message?: PiMessage;
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  attempt?: number;
  maxAttempts?: number;
  errorMessage?: string;
  reason?: string;
  level?: string;
  aborted?: boolean;
  compactionResult?: unknown;
}

/** The images in a tool result ({ content: [{ type: 'image', data, mimeType }] }), as data: URIs. */
export function toolImages(result: unknown): string[] {
  const content = (result as { content?: unknown } | null)?.content;
  return Array.isArray(content) ? splitContent(content).images : [];
}

/** The text in a tool result ({ content: [{ type: 'text', text }] }, or anything else). */
export function toolText(result: unknown): string {
  if (typeof result === 'string') return result;
  const content = (result as { content?: unknown } | null)?.content;
  if (Array.isArray(content))
    return content
      .map((c: PiContent) => (c?.type === 'text' ? c.text || '' : c?.type === 'image' ? '[image]' : ''))
      .filter(Boolean)
      .join('\n');
  return result == null ? '' : JSON.stringify(result);
}

const messageText = (m: PiMessage | undefined): string => (typeof m?.content === 'string' ? m.content : (m?.content || []).filter((c) => c?.type === 'text').map((c) => c.text || '').join(''));

/** Reads the event stream into chat events and the run's answer, usage and session. */
export function piReader(onEvent: (ev: RunEvent) => void, onSession: (id: string) => void) {
  let answer = '';
  // text of the assistant message being streamed (a new one after a tool or another message starts a new block)
  let streamed = '';
  let lastError = '';
  let model = '';
  let tokens = 0;
  let cached = 0;
  let cost = 0;
  let context = 0;
  let ended = false;
  // a message sent while it worked was just shown as read: its answer starts a new block in the chat, so no
  // gap there (a user message the chat doesn't show, one an extension added, keeps the gap)
  let afterUser = false;
  const gap = () => {
    if (!afterUser) onEvent({ kind: 'text', text: '\n\n' });
    answer += '\n\n';
  };
  const handle = (ev: PiEvent) => {
    const t = ev.type || '';
    if (t === 'session' && ev.id) onSession(ev.id);
    else if (t === 'message_update') {
      const a = ev.assistantMessageEvent || {};
      if (a.type === 'text_delta' && a.delta) {
        if (!streamed && answer) gap();
        afterUser = false;
        streamed += a.delta;
        answer += a.delta;
        onEvent({ kind: 'text', text: a.delta });
      } else if (a.type === 'thinking_start') onEvent({ kind: 'status', text: 'Thinking…' });
    } else if (t === 'message_end' && ev.message?.role === 'assistant') {
      const m = ev.message;
      // a message that came without deltas (some providers): its whole text now
      const full = messageText(m);
      if (full && !streamed) {
        const sep = answer ? '\n\n' : '';
        onEvent({ kind: 'text', text: (afterUser ? '' : sep) + full });
        answer += sep + full;
      }
      afterUser = false;
      streamed = '';
      if (m.model && !model) {
        model = m.provider ? `${m.provider}/${m.model}` : m.model;
        onEvent({ kind: 'model', model });
      }
      const u = m.usage || {};
      tokens += u.totalTokens || (u.input || 0) + (u.output || 0);
      cached += u.cacheRead || 0;
      cost += u.cost?.total || 0;
      const ctx = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0);
      if (ctx) context = ctx;
      lastError = m.stopReason === 'error' || m.stopReason === 'aborted' ? m.errorMessage || `The model stopped (${m.stopReason}).` : '';
    } else if (t === 'tool_execution_start' && ev.toolCallId) {
      streamed = '';
      onEvent({ kind: 'tool', id: ev.toolCallId, name: ev.toolName || 'tool', args: ev.args && typeof ev.args === 'object' ? ev.args : {} });
    } else if (t === 'tool_execution_end' && ev.toolCallId) {
      // (a picture it read, a screenshot: shown under the tool call)
      const images = toolImages(ev.result);
      const text = toolText(ev.result);
      const taskResult = /(?:^|[_:])Task(?:Create|Update)$/.test(ev.toolName || '');
      onEvent({ kind: 'tool_result', id: ev.toolCallId, text: taskResult ? text : text.slice(0, 20000), isError: !!ev.isError, ...(images.length ? { images } : {}) });
    } else if (t === 'auto_retry_start') onEvent({ kind: 'status', text: `Trying again (${ev.attempt || 1}/${ev.maxAttempts || '?'})${ev.errorMessage ? `: ${ev.errorMessage.slice(0, 100)}` : ''}` });
    else if (t === 'compaction_start' || t === 'auto_compaction_start') onEvent({ kind: 'status', text: 'Compacting its memory…' });
    else if ((t === 'compaction_end' || t === 'auto_compaction_end') && !ev.aborted) {
      const r = (ev as { result?: { tokensBefore?: number } }).result;
      if (r) onEvent({ kind: 'compacted', trigger: ev.reason === 'manual' ? 'manual' : 'auto', ...(r.tokensBefore ? { tokensBefore: r.tokensBefore } : {}) });
    } else if (t === 'notice' && ev.level !== 'info') {
      // (oh-my-pi: its warnings, as { level, message: string })
      const msg: unknown = ev.message;
      if (typeof msg === 'string') onEvent({ kind: 'status', text: msg.slice(0, 140) });
    } else if (t === 'agent_end') ended = true;
  };
  return {
    line: (l: string) => {
      if (l.startsWith('{')) handle(JSON.parse(l) as PiEvent);
    },
    handle,
    /** the chat just showed a message it read (a steer item): what it says next starts a new block */
    steered: () => void (afterUser = true),
    result: () => ({ answer, lastError, model, tokens, cached, cost, context, ended }),
  };
}

// ---------- command line ----------
// The agent brief goes in a file (only a short path on the command line): both read the file's text.
function promptFile(agent: Agent, name: string, systemPrompt: string): string {
  const file = path.join(ensureDir(dataPath('runtime', agent.id)), name);
  fs.writeFileSync(file, systemPrompt);
  return file;
}

export function piArgs(flavor: PiFlavor, agent: Agent, { sessionId = '', resume = false, instructions = '', interactive = false }: { sessionId?: string; resume?: boolean; instructions?: string; interactive?: boolean } = {}): string[] {
  // (RPC: a message sent while it works can go in)
  const args: string[] = interactive ? [] : ['--mode', 'rpc'];
  if (agent.model) args.push('--model', agent.model);
  const effort = effortFor(flavor, agent.effort);
  if (effort) args.push('--thinking', effort);
  if (instructions) args.push('--append-system-prompt', instructions);
  // pi picks the session by exact id (made here for a new chat); oh-my-pi resumes the one it named
  if (sessionId && flavor === 'pi') args.push('--session-id', sessionId);
  if (sessionId && flavor === 'omp' && resume) args.push('--resume', sessionId);
  // oh-my-pi: never stop to ask about a tool (it can't ask from here, and these agents run on their own)
  if (flavor === 'omp') args.push('--approval-mode', 'yolo');
  return args;
}

/** Tells the dashboard bridge in their mcp.json which agent and run is calling. */
export function bridgeEnv(agentId: string, runId = ''): Record<string, string> {
  // (the bridge reads the token from the data folder, so it never sits in their environment: made now if it isn't yet)
  internalToken();
  return { DASH_PORT: String(PORT), DASH_DATA: DATA, DASH_AGENT: agentId, ...(runId ? { DASH_RUN: runId } : {}) };
}

export function status(flavor: PiFlavor): CliStatus {
  return cliStatus(flavor, (s) => s.trim().replace(/^omp\//, '').split(/\s/)[0]);
}

// ---------- RPC mode: a message while it works ----------
// the runs whose pi still reads its input: a message sent while it works goes in there
const inputs = openInputs('It');

/** A message sent while it works goes into the turn: it reads it before its next step. */
export const steer = inputs.steer;

/** How long it may go without starting its run once it took the message, or without saying it has settled
 *  once its run ended, before its input closes (it then exits). */
export const SETTLE_WAIT = { ms: 30_000 };
/** oh-my-pi said background work it started (a job, a task) may wake it again: how long that may take. */
export const BACKGROUND_WAIT = { ms: 10 * 60_000 };

/** Its version (Settings shows the same): only older pi needs telling apart. */
export const versionOf = { get: (flavor: PiFlavor): string | null => status(flavor).version };

/** Is version a older than b? (Plain numbers: 0.99.0, 1.5.0; anything else isn't older.) */
export function olderThan(a: string | null, b: string): boolean {
  const nums = (v: string) => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10));
  const x = a ? nums(a) : [];
  if (x.length < 3 || x.some((n) => Number.isNaN(n))) return false;
  const y = nums(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]!;
  return false;
}
/** The fields of their RPC frames (responses, oh-my-pi's prompt_result) and run events used here. */
interface RpcFrame {
  command?: string;
  success?: boolean;
  error?: string | { message?: string };
  data?: { disposition?: string; agentInvoked?: boolean; sessionId?: unknown };
  method?: string;
  willRetry?: boolean;
  isTerminal?: boolean;
  status?: string;
  agentInvoked?: boolean;
  sessionSettled?: boolean;
}
const why = (e: RpcFrame['error']): string => (typeof e === 'string' ? e : e?.message) || 'It refused the message.';
// an extension's question it would wait on an answer for: nobody is there to answer, as when it runs without a screen
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor', 'ask']);

/** Talks their RPC protocol for one run: the prompt, the messages sent while it works (each shown as it reads
 *  it), and closing its input once it has settled (pi: agent_settled; oh-my-pi: its prompt_result or
 *  session_settled). Its other events go to the reader. oh-my-pi names a new session itself: get_state says which. */
function rpcTurn(flavor: PiFlavor, child: ChildProcess, runId: string, text: string, reader: ReturnType<typeof piReader>, onEvent: (ev: RunEvent) => void, signal: AbortSignal) {
  const send = (o: object) => void (child.stdin?.writable && child.stdin.write(`${JSON.stringify(o)}\n`));
  // its own message came by first: the user messages after it are the ones sent while it worked
  let prompted = false;
  let refused = '';
  // a run of its has started (one ended: false again until the next)
  let started = false;
  let live = false;
  // (pi before 0.99 never says it settled: a run that ended is the end)
  const settles = !(flavor === 'pi' && olderThan(versionOf.get(flavor), '0.99.0'));
  // messages sent while it works go in as steers, known by their request id. Until its run has its own message
  // they wait here: one sent while it starts up would wait in its queue with no run to read it.
  let held: object[] | null = [];
  const input = inputs.open(runId, {
    take: (m) => {
      if (signal.aborted) return false;
      const key = `steer-${m.id}`;
      const steer = { id: key, type: 'steer', message: withAttachments(m.text, m.attachments || []) };
      if (held) held.push(steer);
      else send(steer);
      return key;
    },
    end: () => child.stdin?.end(),
    onEvent,
  });
  const close = input.close;
  const shown = (key: string) => {
    if (!input.unread.has(key)) return;
    input.read(key);
    reader.steered();
  };
  const onLine = (line: string) => {
    if (!line.startsWith('{')) return;
    const ev = JSON.parse(line) as PiEvent & RpcFrame;
    if (ev.type === 'response') {
      if (ev.id === 'state' && typeof ev.data?.sessionId === 'string' && ev.data.sessionId) reader.handle({ type: 'session', id: ev.data.sessionId });
      // its own message refused, or taken by a command with no run (pi: handled; oh-my-pi: no agent): nothing more comes
      if (ev.id === 'prompt' && (!ev.success || ev.data?.disposition === 'handled' || ev.data?.agentInvoked === false)) {
        if (!ev.success) refused = why(ev.error);
        close();
      }
      // taken: its run should start now (an older pi doesn't say when it handled one itself, and starts none)
      else if (ev.id === 'prompt' && !started) input.closeIn(SETTLE_WAIT.ms);
      // a message it didn't take: the dashboard sends it next instead (it is still unread there). One an
      // extension took (pi: handled) never reaches the agent as a message, but it was taken: it shows as read.
      if (ev.command === 'steer' && ev.id && !ev.success) input.drop(ev.id);
      else if (ev.command === 'steer' && ev.id && ev.data?.disposition === 'handled') shown(ev.id);
      return;
    }
    if (ev.type === 'extension_ui_request') return void (ev.method && DIALOGS.has(ev.method) && send({ type: 'extension_ui_response', id: ev.id, cancelled: true }));
    if (ev.type === 'message_end' && ev.message?.role === 'user') {
      if (!prompted) {
        prompted = true;
        for (const steer of held || []) send(steer);
        held = null;
        return;
      }
      // one sent while it worked: by its words, or (the oldest still unread) a command it expanded into other
      // words (a skill, a prompt template) or files alone. Anything else is no message of ours (an extension's).
      const said = messageText(ev.message);
      const [first] = input.unread;
      const mine = [...input.unread].find(([, m]) => !!m.text && said.includes(m.text)) ?? (first && (!first[1].text.trim() || first[1].text.startsWith('/')) ? first : undefined);
      if (mine) shown(mine[0]);
      return;
    }
    if (ev.type === 'agent_settled' || ev.type === 'session_settled') return close();
    // oh-my-pi: its message's own outcome, once its run yielded
    if (ev.type === 'prompt_result' && ev.id === 'prompt') {
      if (ev.status === 'error' && !ev.agentInvoked) refused = why(ev.error);
      // done; or background work may wake it again (session_settled says when it is done)
      if (ev.sessionSettled || !ev.agentInvoked) return close();
      if (!live) input.closeIn(BACKGROUND_WAIT.ms);
      return;
    }
    if (ev.type === 'agent_start') {
      started = live = true;
      input.wait();
    }
    // a run that ended should settle at once: if it never says so, its input closes anyway (a later line
    // doesn't stop that: only a new run does)
    if (ev.type === 'agent_end' && !ev.willRetry && ev.isTerminal !== false) {
      live = false;
      if (settles) input.closeIn(SETTLE_WAIT.ms);
      else close();
    }
    reader.handle(ev);
  };
  const prompt = `${JSON.stringify({ id: 'prompt', type: 'prompt', message: text })}\n${flavor === 'omp' ? `${JSON.stringify({ id: 'state', type: 'get_state' })}\n` : ''}`;
  return { onLine, prompt, close, refused: () => refused };
}

/** What oh-my-pi says when --resume names a session it doesn't have. */
const SESSION_NOT_FOUND = /Session "[^"]*" not found/i;

async function run(flavor: PiFlavor, { agent, chat, text, signal, onEvent, systemPrompt, runId }: EngineRunArgs): Promise<EngineResult> {
  if (!which(flavor)) throw new Error(`${LABEL[flavor]} is not installed (the \`${flavor}\` command was not found). Install it with: ${INSTALL[flavor]}`);
  // pi: a new chat gets its own session id now; oh-my-pi names a new session itself (in its first line)
  const resume = !!chat.sessionId;
  const sessionId = chat.sessionId || (flavor === 'pi' ? crypto.randomUUID() : '');
  // the dashboard tools reach it only through the bridge in its mcp.json: put it there now if it's missing,
  // so the agent is never told about tools it doesn't have
  let brief = systemPrompt;
  const bridge = toolDefs(agent).length ? ensureBridge(flavor) : null;
  if (bridge && 'added' in bridge) {
    log('mcp', `Gave ${LABEL[flavor]} the dashboard tools (${bridge.added})`);
    onEvent({ kind: 'status', text: `Gave ${LABEL[flavor]} the dashboard tools` });
  } else if (bridge) {
    log('mcp', `${LABEL[flavor]} has no dashboard tools: ${bridge.problem}`);
    emit('toast', { text: `${agent.name} can't use the dashboard tools: ${bridge.problem}` });
    brief += `\n\n(The dashboard's own tools can't be used in this run: ${bridge.problem} Use only your built-in tools, and tell the user this when a task needs the dashboard's tools.)`;
  }
  const instructions = promptFile(agent, `${flavor}-${runId || Date.now().toString(36)}.md`, brief);
  const child = spawnCommand(flavor, piArgs(flavor, agent, { sessionId, resume, instructions }), { cwd: workspaceOf(agent), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...bridgeEnv(agent.id, runId) } });
  // (pi makes the session with that id even if its first line goes missing)
  if (sessionId) chat.sessionId = sessionId;
  const reader = piReader(onEvent, (id) => (chat.sessionId = id));
  const rpc = rpcTurn(flavor, child, runId, text, reader, onEvent, signal);
  try {
    const end = await pipeLines(child, { input: rpc.prompt, keepOpen: true, signal, onLine: rpc.onLine });
    rpc.close();
    if (signal.aborted) throw new Error('Stopped.');
    const r = reader.result();
    if (r.lastError) throw new Error(r.lastError);
    if (rpc.refused()) throw new Error(`${LABEL[flavor]} refused the message: ${rpc.refused()}`);
    if (!r.answer) {
      const msg = `${LABEL[flavor]} exited (${end.code}) without an answer.${tail(end.stderr)}`;
      // oh-my-pi: a session it no longer has (deleted, or made by another engine): a new one, with the chat so far
      if (resume && SESSION_NOT_FOUND.test(end.stderr)) {
        chat.sessionId = null;
        chat.reseed = true;
        throw new SessionGone(msg);
      }
      throw new Error(msg);
    }
    return { text: r.answer, ...(r.tokens ? { tokens: r.tokens } : {}), ...(r.cached ? { cached: r.cached } : {}), ...(r.cost ? { cost: r.cost } : {}), ...(r.context ? { context: r.context } : {}) };
  } finally {
    rpc.close();
    fs.rmSync(instructions, { force: true });
  }
}

/** The interactive terminal: the agent brief stays in a file for the whole session. */
export function terminalArgs(flavor: PiFlavor, agent: Agent, systemPrompt: string): string[] {
  return piArgs(flavor, agent, { interactive: true, instructions: promptFile(agent, `terminal-${flavor}-instructions.md`, systemPrompt) });
}

export const pi: Engine<CliStatus> = { run: (a) => run('pi', a), status: () => status('pi'), steer };
export const omp: Engine<CliStatus> = { run: (a) => run('omp', a), status: () => status('omp'), steer };

// ---------- models ----------
export interface PiModel {
  id: string;
  name: string;
  context?: number;
}

/** pi's `--list-models` table: provider, model, context (200K, 1M), … */
export function parseModelTable(out: string): PiModel[] {
  const list: PiModel[] = [];
  const size = (s: string) => {
    const m = /^([\d.]+)([KM]?)$/i.exec(s);
    return m ? Math.round(Number(m[1]) * (m[2].toUpperCase() === 'M' ? 1e6 : m[2] ? 1e3 : 1)) : 0;
  };
  for (const line of out.split(/\r?\n/)) {
    const [provider, model, ctx] = line.trim().split(/\s{2,}|\t/);
    if (!provider || !model || /^provider$/i.test(provider) || /\s/.test(provider) || /\s/.test(model)) continue;
    const context = size(ctx || '');
    list.push({ id: `${provider}/${model}`, name: model, ...(context ? { context } : {}) });
  }
  return list;
}

const modelCache = new Map<PiFlavor, { at: number; list: PiModel[] }>();
/** The models it has a login or key for. */
export async function listModels(flavor: PiFlavor): Promise<PiModel[]> {
  const hit = modelCache.get(flavor);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.list;
  if (!which(flavor)) return [];
  let list: PiModel[] = [];
  if (flavor === 'pi') list = parseModelTable((await runCmd('pi', ['--list-models'], { timeout: 60000 })).stdout);
  else {
    const r = await runCmd('omp', ['models', '--json'], { timeout: 60000, maxBytes: 20_000_000 });
    try {
      const j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as { models?: { selector?: string; provider?: string; id?: string; name?: string; contextWindow?: number; kind?: string }[] };
      list = (j.models || [])
        .filter((m) => (m.kind || 'chat') === 'chat' && (m.selector || m.id))
        .map((m) => ({ id: m.selector || `${m.provider}/${m.id}`, name: m.name || m.id || '', ...(m.contextWindow ? { context: m.contextWindow } : {}) }));
    } catch {
      /* not JSON */
    }
  }
  if (list.length) modelCache.set(flavor, { at: Date.now(), list });
  return list;
}

// ---------- the dashboard tools ----------
/** Where each keeps its MCP servers. */
export function mcpFile(flavor: PiFlavor): string {
  if (flavor === 'pi') return path.join(process.env.PI_CODING_AGENT_DIR || path.join(HOME, '.pi', 'agent'), 'mcp.json');
  return path.join(HOME, '.omp', 'agent', 'mcp.json');
}

/** Adds the dashboard bridge to pi's or oh-my-pi's mcp.json (the rest of the file stays as it is).
 *  It has no agent of its own there: runs from the dashboard tell it theirs (bridgeEnv), and the
 *  bridge finds the port and token by itself when you use pi on your own. */
export function addBridge(flavor: PiFlavor): string {
  const file = mcpFile(flavor);
  let cfg: { mcpServers?: Record<string, unknown> } & Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    // a file we can't read is left alone, never replaced
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch {
      throw new Error(`${file} isn't valid JSON, so it was left as it is. Fix it (or add the dashboard there yourself) and try again.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} isn't an MCP config (a JSON object), so it was left as it is.`);
    cfg = parsed as typeof cfg;
  }
  const servers = cfg.mcpServers && typeof cfg.mcpServers === 'object' && !Array.isArray(cfg.mcpServers) ? cfg.mcpServers : {};
  // a call can wait while you decide on an approval: pi counts seconds, oh-my-pi milliseconds
  servers.dashboard = { command: process.execPath, args: [BRIDGE_SCRIPT], timeout: flavor === 'pi' ? 3600 : 3_600_000 };
  ensureDir(path.dirname(file));
  writeJSON(file, { ...cfg, mcpServers: servers });
  return file;
}

/** Is the dashboard bridge in their mcp.json, naming programs that are there? If not it is added (or put
 *  right: the app was moved or reinstalled). A file it can't read is left alone and says why. Null: it was fine. */
export function ensureBridge(flavor: PiFlavor): { added: string } | { problem: string } | null {
  const file = mcpFile(flavor);
  let entry: { command?: unknown; args?: unknown } | undefined;
  if (fs.existsSync(file)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as { mcpServers?: Record<string, typeof entry> } | null;
      entry = cfg?.mcpServers?.dashboard;
    } catch {
      return { problem: `${file} isn't valid JSON, so the dashboard wasn't added to it. Fix it, then use the MCP servers page to add the dashboard.` };
    }
  }
  // a program by name is found on the PATH; one by path must be there (a hand-made entry is kept when it works)
  const there = (p: unknown) => typeof p === 'string' && (path.isAbsolute(p) ? fs.existsSync(p) : !!which(p));
  const script = Array.isArray(entry?.args) ? entry.args[0] : undefined;
  if (entry && there(entry.command) && (typeof script !== 'string' || !path.isAbsolute(script) || fs.existsSync(script))) return null;
  try {
    return { added: addBridge(flavor) };
  } catch (e) {
    return { problem: e instanceof Error ? e.message : String(e) };
  }
}
