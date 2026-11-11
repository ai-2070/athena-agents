// opencode engine (opencode 2.x): each run starts its own `opencode serve --stdio` in the agent's workspace,
// talks to it over its HTTP API and event stream, and ends it when the turn is over (closing its stdin ends
// it). Never the shared background service: that one doesn't see the config we give it.
// The run's config (a file in the data folder) names an `athena` agent with the agent's brief, its
// permission rules (from its autonomy) and the dashboard bridge as an MCP server. opencode's questions
// ("may I run this command?") come to the dashboard's approvals. Sessions live in opencode's own database
// (with its logins), so the next run resumes the chat's session by id.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { which, spawnCommand, run as runCmd, BRIDGE_SCRIPT, dataPath, ensureDir } from '../util.ts';
import { agents, log, rememberAlwaysAllow } from '../store.ts';
import { listServers, resolveCommand } from '../mcp.ts';
import { toolDefs, workspaceOf } from '../tools.ts';
import { knowledgeRoots } from '../knowledge.ts';
import { safeUploadsRoot, withAttachments } from '../uploads.ts';
import { requestApproval, withdrawApprovals } from '../approvals.ts';
import { EFFORTS, effortFor, nearestEffort } from '../../shared/effort.ts';
import { bridgeEnv, cliStatus, olderThan, pipeLines, steerEvent, tail, SessionGone } from './cli.ts';
import type { ChildProcess } from 'node:child_process';
import type { Agent, RunEvent } from '../../shared/types.ts';
import type { Engine, EngineRunArgs, EngineResult, TurnMessage, TurnSteering } from './index.ts';

export const INSTALL = 'npm i -g @opencode/cli';
const MIN_VERSION = '2.0.0';
/** The agent every run's config names (and the one the terminal starts on). */
export const AGENT = 'athena';

// ---------- status ----------
export interface OpencodeStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  /** opencode 1.x: a different program as far as we're concerned */
  tooOld: boolean;
}

/** "opencode v2.2.7" → "2.2.7" */
export const parseVersion = (out: string): string =>
  out
    .trim()
    .split('\n')[0]!
    .replace(/^opencode\s+/i, '')
    .replace(/^v/, '')
    .split(/\s/)[0] || '';

export function status(): OpencodeStatus {
  const s = cliStatus('opencode', parseVersion);
  return { ...s, tooOld: !!s.version && olderThan(s.version, MIN_VERSION) };
}

function usable(): void {
  if (!which('opencode'))
    throw new Error(`opencode is not installed (the \`opencode\` command was not found). Install it with: ${INSTALL}`);
  if (status().tooOld)
    throw new Error(
      `This is opencode ${status().version}; agents need opencode 2 or later. Update it with: ${INSTALL}`,
    );
}

// ---------- the run's config ----------
/** One permission rule: the last one that matches decides. */
export interface Rule {
  action: string;
  resource: string;
  effect: 'allow' | 'ask' | 'deny';
}
const rule = (action: string, effect: Rule['effect'], resource = '*'): Rule => ({ action, resource, effect });
/** A folder as opencode names it in an external_directory question: forward slashes, then /* */
const folderRules = (dir: string): Rule[] => {
  const d = path.resolve(dir).replace(/\\/g, '/').replace(/\/$/, '');
  return [rule('external_directory', 'allow', `${d}/*`), rule('external_directory', 'allow', `${d}/**`)];
};

/** The agent's autonomy as opencode's permission rules. */
export function permissionRules(agent: Agent): Rule[] {
  const mode = agent.autonomy || 'auto';
  const rules: Rule[] =
    mode === 'full'
      ? [rule('*', 'allow')]
      : mode === 'auto'
        ? // everything in its folder; outside it (the uploads and its knowledge folders aside) and .env files, it asks
          [
            rule('*', 'allow'),
            rule('external_directory', 'ask'),
            ...[safeUploadsRoot(), ...knowledgeRoots(agent)].filter((d): d is string => !!d).flatMap(folderRules),
            rule('read', 'ask', '*.env'),
            rule('read', 'ask', '*.env.*'),
          ]
        : // Ask first: it looks around freely, and asks before it changes or runs anything
          [
            rule('*', 'ask'),
            rule('read', 'allow'),
            rule('glob', 'allow'),
            rule('grep', 'allow'),
            rule('skill', 'allow'),
            rule('read', 'ask', '*.env'),
            rule('read', 'ask', '*.env.*'),
          ];
  // the dashboard asks about its own tools itself; opencode asking you mid-turn is the dashboard's ask_user
  rules.push(rule('dashboard_*', 'allow'), rule('question', 'deny'));
  return rules;
}

type McpEntry =
  | {
      type: 'local';
      command: string[];
      environment?: Record<string, string>;
      codemode?: boolean;
      timeout?: { execution: number };
    }
  | { type: 'remote'; url: string; headers?: Record<string, string>; oauth: false };

/** The MCP servers it gets: the dashboard bridge (when the agent has dashboard tools) and the agent's own. */
export function mcpServers(agent: Agent, runId = ''): Record<string, McpEntry> {
  const out: Record<string, McpEntry> = {};
  // (an approval can keep a dashboard tool waiting a long time)
  if (toolDefs(agent).length)
    out.dashboard = {
      type: 'local',
      command: [process.execPath, BRIDGE_SCRIPT],
      environment: bridgeEnv(agent.id, runId),
      codemode: false,
      timeout: { execution: 3_600_000 },
    };
  const servers = listServers();
  for (const name of agent.mcpServers || []) {
    const cfg = servers[name];
    if (!cfg || cfg.enabled === false || name === 'dashboard' || !/^[\w-]+$/.test(name)) continue;
    // its tools are named <server>_<tool>: one called dashboard_… would pass as the dashboard's own (allowed, as the
    // dashboard asks about those itself), so it goes by another name
    const key = /^dashboard_/i.test(name) ? `mcp-${name}` : name;
    if (out[key]) continue;
    if (cfg.type === 'stdio') {
      // (on Windows, npx and uvx are .cmd files it can't start directly)
      const { command, args } = resolveCommand(cfg.command, cfg.args || []);
      out[key] = {
        type: 'local',
        command: [command, ...args],
        ...(Object.keys(cfg.env || {}).length ? { environment: { ...cfg.env } } : {}),
      };
    } else if (cfg.url)
      out[key] = {
        type: 'remote',
        url: cfg.url,
        ...(Object.keys(cfg.headers || {}).length ? { headers: { ...cfg.headers } } : {}),
        oauth: false,
      };
  }
  return out;
}

/** The config a run (or the terminal) starts opencode with. The servers' keys are in it: it is written to
 *  the data folder and removed after the run, never put in opencode's environment (its shell would hand
 *  that to every command it runs). */
export function opencodeConfig(agent: Agent, { briefFile, runId = '' }: { briefFile: string; runId?: string }): object {
  return {
    $schema: 'https://opencode.ai/config.json',
    agents: {
      [AGENT]: {
        mode: 'primary',
        description: `${agent.name} from Athena Agents`,
        system: `{file:${briefFile.replace(/\\/g, '/')}}`,
        permissions: permissionRules(agent),
      },
    },
    default_agent: AGENT,
    mcp: { servers: mcpServers(agent, runId) },
  };
}

interface RunFiles {
  config: string;
  brief: string;
  cleanup: () => void;
}
/** Writes the brief and the config for a run (tag: its id) or the terminal. */
export function writeRunFiles(agent: Agent, systemPrompt: string, tag: string, runId = ''): RunFiles {
  const dir = ensureDir(dataPath('runtime', agent.id));
  const brief = path.join(dir, `opencode-${tag}.md`);
  const config = path.join(dir, `opencode-${tag}.json`);
  fs.writeFileSync(brief, systemPrompt);
  fs.writeFileSync(config, JSON.stringify(opencodeConfig(agent, { briefFile: brief, runId }), null, 2));
  return { config, brief, cleanup: () => [config, brief].forEach((f) => fs.rmSync(f, { force: true })) };
}

// ---------- models ----------
/** "openrouter/deepseek/deepseek-v4.1-flash" → opencode's { providerID, id }: the provider is the part before the first slash. */
export function modelRef(model: string): { providerID: string; id: string } | null {
  const i = model.indexOf('/');
  return i > 0 && i < model.length - 1 ? { providerID: model.slice(0, i), id: model.slice(i + 1) } : null;
}

/** The variant for an effort: the one of that name, or the nearest effort the model has ('' when it has none). */
export function variantFor(effort: unknown, variants: string[]): string {
  const want = effortFor('opencode', effort);
  return want
    ? nearestEffort(
        want,
        EFFORTS.filter((e) => variants.includes(e)),
      )
    : '';
}

/** One of `GET /api/model` (only the fields used here). */
interface ApiModel {
  id: string;
  providerID: string;
  name?: string;
  enabled?: boolean;
  variants?: { id: string }[];
  limit?: { context?: number };
}
export interface OpencodeModel {
  id: string;
  name: string;
  context?: number;
  variants: string[];
}
const toModel = (m: ApiModel): OpencodeModel => ({
  id: `${m.providerID}/${m.id}`,
  name: m.name || m.id,
  ...(m.limit?.context ? { context: m.limit.context } : {}),
  variants: (m.variants || []).map((v) => v.id),
});

// The list is kept a minute (an empty one ten seconds: you may be signing in), and asked for once however many want it
let modelCache: { at: number; list: OpencodeModel[] } = { at: 0, list: [] };
let loading: Promise<OpencodeModel[]> | null = null;
const cached = (): OpencodeModel[] | null =>
  modelCache.at && Date.now() - modelCache.at < (modelCache.list.length ? 60_000 : 10_000) ? modelCache.list : null;
/** Forgets the list (tests). */
export function forgetModels(): void {
  modelCache = { at: 0, list: [] };
}

/** The models a server lists, kept for the next to ask. */
async function modelsOf(server: Server): Promise<OpencodeModel[]> {
  const r = await server.call<ApiModel[]>('GET', '/api/model');
  const list = (r.data || []).filter((m) => m.enabled !== false).map(toModel);
  modelCache = { at: Date.now(), list };
  return list;
}

/** The models opencode can use (its free ones, and those of the providers it is signed in to). */
export function listModels(): Promise<OpencodeModel[]> {
  const have = cached();
  if (have) return Promise.resolve(have);
  if (!which('opencode') || status().tooOld) return Promise.resolve([]);
  loading ??= (async () => {
    const server = await startServer({
      cwd: ensureDir(dataPath('runtime')),
      env: process.env,
      signal: new AbortController().signal,
    });
    try {
      return await modelsOf(server);
    } finally {
      server.close();
    }
  })().finally(() => (loading = null));
  return loading;
}

// ---------- its server ----------
export interface Server {
  url: string;
  /** a JSON route: its { data }, or throws with its message (status: what it answered) */
  call<T = unknown>(method: string, route: string, body?: unknown): Promise<{ status: number; data?: T }>;
  /** its event stream, from now on (live only: open it before what it should hear about) */
  events(signal: AbortSignal): AsyncGenerator<OcEvent>;
  /** it ends: its stdin closes (killed if it doesn't go) */
  close(): void;
  /** it exited, and what it printed to stderr */
  ended: Promise<{ code: number | null; stderr: string }>;
}

/** How long it may take to say where it listens. */
export const START_WAIT = { ms: 30_000 };

/** An error opencode answered with. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** signal stops it only while it starts. After that close() ends it, so Stop can interrupt the turn first. */
export async function startServer({
  cwd,
  env,
  signal,
}: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<Server> {
  const password = crypto.randomBytes(24).toString('base64url');
  const child: ChildProcess = spawnCommand('opencode', ['serve', '--stdio', '--port', '0'], {
    cwd,
    env: { ...env, OPENCODE_PASSWORD: password },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let found: (url: string) => void = () => {};
  const at = new Promise<string>((resolve) => (found = resolve));
  // (aborting this kills it: only on a failed start, or when it doesn't end after close())
  const kill = new AbortController();
  const ended = pipeLines(child, {
    input: '',
    keepOpen: true,
    signal: kill.signal,
    onLine: (line) => {
      const m = /^\{"url":"([^"]+)"\}$/.exec(line);
      if (m) found(m[1]!);
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onStop = () => {};
  const url = await Promise.race([
    at,
    ended.then((e) =>
      Promise.reject(new Error(`opencode's server stopped before it started (${e.code}).${tail(e.stderr)}`)),
    ),
    new Promise<never>(
      (_, reject) =>
        (timer = setTimeout(() => reject(new Error("opencode's server did not start in time.")), START_WAIT.ms)),
    ),
    new Promise<never>((_, reject) => {
      onStop = () => reject(new Error('Stopped.'));
      if (signal.aborted) onStop();
      else signal.addEventListener('abort', onStop);
    }),
  ])
    .catch((e: unknown) => {
      kill.abort();
      throw e;
    })
    .finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onStop);
    });
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    'content-type': 'application/json',
  };
  let closed = false;
  const server: Server = {
    url,
    ended,
    async call<T>(method: string, route: string, body?: unknown) {
      const r = await fetch(url + route, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await r.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* not JSON */
      }
      if (!r.ok)
        throw new ApiError(
          (json as { message?: string } | null)?.message || text.slice(0, 300) || `opencode answered ${r.status}.`,
          r.status,
        );
      return { status: r.status, data: (json as { data?: T } | null)?.data };
    },
    async *events(stop: AbortSignal) {
      const r = await fetch(`${url}/api/event`, { headers, signal: stop });
      if (!r.ok || !r.body) throw new Error(`opencode's event stream answered ${r.status}.`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let i: number;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const ev = parseFrame(buf.slice(0, i));
            buf = buf.slice(i + 2);
            if (ev) yield ev;
          }
        }
      } catch {
        // a dropped connection (it died, or let go of a slow reader) ends the stream: the run says what that means
      } finally {
        reader.releaseLock();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      child.stdin?.end();
      const t = setTimeout(() => kill.abort(), 5000);
      t.unref?.();
      ended.then(() => clearTimeout(t));
    },
  };
  return server;
}

/** One event (only the fields used here). */
export interface OcEvent {
  type: string;
  data: Record<string, unknown>;
}

/** One server-sent frame: its data lines are the event's JSON (a frame without data is a keep-alive). */
export function parseFrame(frame: string): OcEvent | null {
  const data = frame
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    const o = JSON.parse(data) as { type?: unknown; data?: unknown };
    return typeof o.type === 'string'
      ? { type: o.type, data: o.data && typeof o.data === 'object' ? (o.data as Record<string, unknown>) : {} }
      : null;
  } catch {
    return null;
  }
}

// ---------- reading a turn ----------
interface Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const errText = (x: unknown): string => str((x as { message?: unknown } | null)?.message);

/** A tool result's content ([{ type: 'text', text }, { type: 'file', uri, mime }]) as text and pictures. */
export function toolOutput(content: unknown): { text: string; images: string[] } {
  if (!Array.isArray(content)) return { text: '', images: [] };
  const text = content
    .map((c: { type?: string; text?: string; uri?: string; name?: string }) =>
      c?.type === 'text' ? c.text || '' : c?.uri ? `[${c.name || 'file'}]` : '',
    )
    .filter(Boolean)
    .join('\n');
  // (pictures it sent as data: URIs)
  const images = content
    .map((c: { uri?: unknown }) => c?.uri)
    .filter((u): u is string => typeof u === 'string' && u.startsWith('data:image/'));
  return { text, images };
}

/** Turns one session's events into chat events and the turn's answer, usage and outcome. */
export function opencodeReader(onEvent: (ev: RunEvent) => void) {
  let answer = '';
  // the text block being streamed (its message and part): a new one starts a new paragraph
  let block = '';
  let streamed = false;
  let afterUser = false;
  let model = '';
  let tokens = 0;
  let cached = 0;
  let cost = 0;
  let context = 0;
  let error = '';
  const names = new Map<string, string>();
  const gap = () => {
    if (!answer) return;
    if (!afterUser) onEvent({ kind: 'text', text: '\n\n' });
    answer += '\n\n';
  };
  const handle = ({ type: t, data: d }: OcEvent) => {
    if (t === 'session.step.started') {
      const m = d.model as { providerID?: string; id?: string } | undefined;
      if (m?.id && !model) {
        model = m.providerID ? `${m.providerID}/${m.id}` : m.id;
        onEvent({ kind: 'model', model });
      }
    } else if (t === 'session.text.started') {
      block = `${str(d.assistantMessageID)}#${num(d.ordinal)}`;
      streamed = false;
    } else if (t === 'session.text.delta' && str(d.delta)) {
      if (!streamed) gap();
      streamed = true;
      afterUser = false;
      answer += str(d.delta);
      onEvent({ kind: 'text', text: str(d.delta) });
    } else if (t === 'session.text.ended') {
      // a text that came without deltas (some providers): all of it now
      if (!streamed && str(d.text)) {
        gap();
        answer += str(d.text);
        onEvent({ kind: 'text', text: str(d.text) });
        afterUser = false;
      }
      streamed = false;
      block = '';
    } else if (t === 'session.reasoning.started') onEvent({ kind: 'status', text: 'Thinking…' });
    else if (t === 'session.tool.input.started' && str(d.id)) names.set(str(d.id), str(d.name) || 'tool');
    else if (t === 'session.tool.called' && str(d.id)) {
      const args =
        d.input && typeof d.input === 'object' && !Array.isArray(d.input) ? (d.input as Record<string, unknown>) : {};
      onEvent({ kind: 'tool', id: str(d.id), name: names.get(str(d.id)) || 'tool', args });
    } else if ((t === 'session.tool.success' || t === 'session.tool.failed') && str(d.id)) {
      const out = toolOutput(d.content);
      const failed = t === 'session.tool.failed';
      const text = failed ? [errText(d.error), out.text].filter(Boolean).join('\n') : out.text;
      onEvent({
        kind: 'tool_result',
        id: str(d.id),
        text: text.slice(0, 20000),
        isError: failed,
        ...(out.images.length ? { images: out.images } : {}),
      });
    } else if (t === 'session.step.ended' || (t === 'session.step.failed' && d.tokens)) {
      const u = (d.tokens || {}) as Tokens;
      const read = num(u.cache?.read);
      const write = num(u.cache?.write);
      tokens += num(u.input) + num(u.output) + num(u.reasoning) + read + write;
      cached += read;
      cost += num(d.cost);
      const ctx = num(u.input) + read + write + num(u.output) + num(u.reasoning);
      if (ctx) context = ctx;
    } else if (t === 'session.retry.scheduled') {
      const why = errText(d.error);
      onEvent({ kind: 'status', text: `Trying again (${num(d.attempt) || 1})${why ? `: ${why.slice(0, 100)}` : ''}` });
    } else if (t === 'session.compaction.started') onEvent({ kind: 'status', text: 'Compacting its memory…' });
    else if (t === 'session.compaction.ended')
      onEvent({ kind: 'compacted', trigger: d.reason === 'manual' ? 'manual' : 'auto' });
    else if (t === 'session.compaction.failed')
      onEvent({ kind: 'status', text: `Compacting its memory failed: ${errText(d.error).slice(0, 100)}` });
    else if (t === 'session.execution.failed') error = errText(d.error) || 'opencode failed.';
    else if (t === 'session.execution.succeeded') error = '';
    else if (t === 'session.execution.interrupted' && d.reason !== 'user')
      error = `opencode stopped the turn (${str(d.reason) || 'interrupted'}).`;
  };
  return {
    handle,
    /** the chat just showed a message it read: what it says next starts a new block there */
    steered: () => {
      afterUser = true;
      if (block) streamed = false;
    },
    result: () => ({ answer, model, tokens, cached, cost, context, error }),
  };
}

const ENDS = new Set(['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted']);

// ---------- messages sent while it works ----------
// the runs that take a message into their turn now: it goes in as a steer, and its event says when it was read
const intake = new Map<string, (m: TurnMessage) => Promise<void>>();
export const steer: TurnSteering = {
  can: (runId) => intake.has(runId),
  send: async (runId, m) => {
    const take = intake.get(runId);
    if (!take) throw new Error('opencode is no longer taking messages for this turn.');
    await take(m);
  },
  saysWhenRead: true,
};

/** opencode's own ids: a prefix, the time, then random letters. */
export function newId(prefix: 'ses' | 'msg'): string {
  const abc = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const rnd = Array.from(crypto.randomBytes(14), (b) => abc[b % abc.length]).join('');
  return `${prefix}_${Date.now().toString(16).padStart(12, '0')}${rnd}`;
}

/** How long a message it took in just as its turn ended may take to start the next one. */
export const NEXT_WAIT = { ms: 30_000 };

// ---------- its questions ----------
const VERBS: Record<string, string> = {
  shell: 'run a command',
  execute: 'run code',
  edit: 'change files',
  read: 'read a file',
  external_directory: 'work outside its folder',
  webfetch: 'open a web page',
  websearch: 'search the web',
  subagent: 'start a helper agent',
  skill: 'use a skill',
  glob: 'list files',
  grep: 'search files',
};

// The guards Auto and Ask first keep (outside its folder, .env files): Always allow covers the folders or files it
// asked about, never every folder or every .env file
const PER_RESOURCE = new Set(['external_directory', 'read']);

/** What Always allow saves for a question (all of them must be saved for it to go by without asking). */
export function allowKeys(action: string, resources: string[]): string[] {
  const key = `opencode:${action}`;
  return PER_RESOURCE.has(action) && resources.length ? resources.map((r) => `${key}:${r}`) : [key];
}

/** One of opencode's questions, to the dashboard's approvals (and the Brain). The answer goes back to it. */
async function askPermission(
  agent: Agent,
  d: Record<string, unknown>,
  runId: string,
  reply: (decision: 'once' | 'reject', message?: string) => Promise<void>,
  helper = false,
): Promise<void> {
  const action = str(d.action) || 'tool';
  const resources = Array.isArray(d.resources) ? d.resources.map(String) : [];
  const keys = allowKeys(action, resources);
  const allowed = agents.get(agent.id)?.alwaysAllow || agent.alwaysAllow || [];
  if (keys.every((k) => allowed.includes(k))) return reply('once');
  const detail = [str(d.message), ...resources].filter(Boolean).join('\n') || action;
  const verb = VERBS[action] || (action.includes('_') ? `use ${action.replace('_', ' › ')}` : `use ${action}`);
  const perResource = PER_RESOURCE.has(action) && resources.length > 0;
  const noun = action === 'read' ? 'file' : 'folder';
  const decision = await requestApproval({
    kind: 'opencode',
    title: `${agent.name}${helper ? "'s helper agent" : ''} wants to ${verb}`,
    detail: detail.slice(0, 4000),
    agentId: agent.id,
    agentName: agent.name,
    data: {
      tool: `opencode:${action}`,
      args: { action, resources },
      runId,
      permission: str(d.id),
      ...(perResource
        ? {
            alwaysMeans: `Allow ${resources.length > 1 ? `these ${noun}s` : `this ${noun}`} for this agent from now on (not every ${noun})`,
          }
        : {}),
    },
  });
  if (decision.approved && decision.always) rememberAlwaysAllow(agent.id, keys);
  return decision.approved
    ? reply('once')
    : reply('reject', decision.message || 'The user declined this. Ask them how to proceed.');
}

// ---------- a run ----------
async function run({ agent, chat, text, signal, onEvent, systemPrompt, runId }: EngineRunArgs): Promise<EngineResult> {
  usable();
  const workspace = workspaceOf(agent);
  const files = writeRunFiles(agent, systemPrompt, runId || Date.now().toString(36), runId);
  const stopStream = new AbortController();
  let server: Server | null = null;
  try {
    server = await startServer({ cwd: workspace, env: { ...process.env, OPENCODE_CONFIG: files.config }, signal });
    const srv = server;
    // the stream first: it only tells what happens after it opens
    const stream = srv.events(stopStream.signal);
    const first = await stream.next();
    if (first.done) throw new Error('opencode closed its event stream at once.');

    // the chat's session: a new one under our own id, or the one it has (gone: a new one, with the chat so far)
    const want = agent.model ? modelRef(agent.model) : null;
    if (agent.model && !want)
      throw new Error(
        `"${agent.model}" isn't an opencode model: it is written provider/model, like openrouter/deepseek/deepseek-v4.1-flash.`,
      );
    // the model the session should be on: the agent's, or else opencode's default (asked for when there is an effort
    // to give it, or a session to bring back to it), with the effort's variant
    let sessionId = chat.sessionId || '';
    let target = want;
    let m: OpencodeModel | undefined;
    if (want) {
      // (the list kept from the model picker; asked for again when it doesn't have this one: it may be new)
      const id = `${want.providerID}/${want.id}`;
      m = cached()?.find((x) => x.id === id) || (await modelsOf(srv).catch(() => [])).find((x) => x.id === id);
    } else if (agent.effort || sessionId) {
      const d = (await srv.call<ApiModel>('GET', '/api/model/default').catch(() => ({ status: 0, data: undefined })))
        .data;
      if (d?.providerID && d.id) {
        target = { providerID: d.providerID, id: d.id };
        m = toModel(d);
      }
    }
    const variant = m ? variantFor(agent.effort, m.variants) : '';
    const window = m?.context || 0;
    const modelBody = target ? { ...target, ...(variant ? { variant } : {}) } : null;
    if (sessionId) {
      const s = /^ses/.test(sessionId)
        ? await srv
            .call<{ model?: { providerID?: string; id?: string; variant?: string } }>(
              'GET',
              `/api/session/${encodeURIComponent(sessionId)}`,
            )
            .catch((e: unknown) =>
              e instanceof ApiError && (e.status === 404 || e.status === 400) ? null : Promise.reject(e),
            )
        : null;
      if (!s) {
        chat.sessionId = null;
        chat.reseed = true;
        throw new SessionGone('Its opencode session is gone.');
      }
      // (moved back too when the agent's model or effort was cleared)
      const has = s.data?.model;
      if (
        modelBody &&
        (has?.providerID !== modelBody.providerID || has?.id !== modelBody.id || (has?.variant || '') !== variant)
      )
        await srv.call('POST', `/api/session/${sessionId}/model`, { model: modelBody });
    } else {
      sessionId = newId('ses');
      chat.sessionId = sessionId;
      // (on opencode's default without an effort, the session is left to follow its default)
      const pin = want || variant ? modelBody : null;
      await srv.call('POST', '/api/session', {
        id: sessionId,
        agent: AGENT,
        location: { directory: workspace },
        ...(pin ? { model: pin } : {}),
      });
    }

    const reader = opencodeReader(onEvent);
    // messages sent while it works: in opencode's inbox (by our id) until it says it read them
    const unread = new Map<string, TurnMessage>();
    const sending = new Set<Promise<unknown>>();
    let taking = false;
    const post = (id: string, body: object) => srv.call('POST', `/api/session/${sessionId}/prompt`, { id, ...body });
    // the chat's session and the helper agents it starts (each in a session of its own): their questions are ours too
    const mine = new Set([sessionId]);
    // its questions we answered (the others it settled itself: refusing one refuses every question still open)
    const answered = new Set<string>();
    const reply = (sid: string, id: string) => (decision: 'once' | 'reject', message?: string) => {
      answered.add(id);
      return srv
        .call('POST', `/api/session/${encodeURIComponent(sid)}/permission/${encodeURIComponent(id)}/reply`, {
          decision,
          ...(message ? { message } : {}),
        })
        .then(
          () => undefined,
          () => undefined,
        );
    };
    const stopTaking = () => {
      taking = false;
      intake.delete(runId);
    };
    // the messages it hasn't read come back out of its inbox (the dashboard sends them next): false when one
    // stays, because it had already taken it in
    const takeBack = async (): Promise<boolean> => {
      await Promise.allSettled([...sending]);
      let all = true;
      for (const key of [...unread.keys()]) {
        const gone = await srv.call('DELETE', `/api/session/${sessionId}/inbox/${encodeURIComponent(key)}`).then(
          () => true,
          () => false,
        );
        if (gone) unread.delete(key);
        else all = false;
      }
      return all;
    };
    // (the server is closed only once these got there, or after a moment)
    let interrupting: Promise<unknown> = Promise.resolve();
    const onAbort = () => {
      stopTaking();
      interrupting = Promise.race([
        Promise.allSettled(
          [...mine].map((sid) => srv.call('POST', `/api/session/${encodeURIComponent(sid)}/interrupt`)),
        ),
        new Promise((resolve) => setTimeout(resolve, 3000).unref?.()),
      ]);
      // (it may not say so: the stream ends after a moment either way)
      setTimeout(() => stopStream.abort(), 3000).unref?.();
    };
    signal.addEventListener('abort', onAbort);
    try {
      await post(newId('msg'), { text });
      taking = true;
      intake.set(runId, (m) => {
        if (!taking || signal.aborted)
          return Promise.reject(new Error('opencode is no longer taking messages for this turn.'));
        const key = newId('msg');
        unread.set(key, m);
        const p = post(key, { text: withAttachments(m.text, m.attachments || []), delivery: 'steer' }).then(
          () => undefined,
          (e: unknown) => {
            unread.delete(key);
            throw e;
          },
        );
        sending.add(p);
        p.catch(() => {}).finally(() => sending.delete(p));
        return p;
      });
      let ended = false;
      let waitingNext: ReturnType<typeof setTimeout> | undefined;
      for await (const ev of stream) {
        const d = ev.data;
        const sid = str(d.sessionID);
        if (ev.type === 'session.created') {
          const parent = str(d.parentID) || str((d.info as { parentID?: unknown } | undefined)?.parentID);
          if (sid && mine.has(parent)) mine.add(sid);
          continue;
        }
        if (ev.type === 'permission.asked') {
          if (mine.has(sid))
            void askPermission(agent, d, runId, reply(sid, str(d.id)), sid !== sessionId).catch((e: unknown) =>
              log('opencode', `A permission question failed: ${(e as Error).message}`),
            );
          continue;
        }
        // one it settled itself leaves Needs you
        if (ev.type === 'permission.replied') {
          const id = str(d.requestID);
          if (mine.has(sid) && id && !answered.has(id))
            withdrawApprovals(
              (item) => item.data?.runId === runId && item.data?.permission === id,
              'opencode no longer needs an answer to this.',
            );
          continue;
        }
        // the rest is the chat's own session (a helper's work shows as its tool call)
        if (d.sessionID !== undefined && sid !== sessionId) continue;
        if (ev.type === 'session.inbox.delivered') {
          const m = unread.get(str(d.inboxID));
          if (m) {
            unread.delete(str(d.inboxID));
            onEvent(steerEvent(m));
            reader.steered();
          }
          continue;
        }
        if (ev.type === 'session.execution.started') {
          clearTimeout(waitingNext);
          ended = false;
        }
        reader.handle(ev);
        if (!ENDS.has(ev.type)) continue;
        if (signal.aborted || ev.type === 'session.execution.interrupted') {
          ended = true;
          break;
        }
        // its turn is over: no more messages go in. One it hasn't read yet comes back (it goes next, the
        // ordinary way), unless it already took it in: then the next turn it starts reads it, and we follow that.
        stopTaking();
        const next = !(await takeBack());
        // (this turn is over either way: if the next one never starts, the run ends with it)
        ended = true;
        if (!next) break;
        waitingNext = setTimeout(() => stopStream.abort(), NEXT_WAIT.ms);
        waitingNext.unref?.();
      }
      clearTimeout(waitingNext);
      if (signal.aborted) throw new Error('Stopped.');
      const r = reader.result();
      // the stream ended in the middle of a turn (it died, or dropped us): an error, even after some text
      if (!ended) {
        const end = await Promise.race([
          srv.ended,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
        ]);
        const what = r.answer ? 'before it finished its answer' : 'without an answer';
        throw new Error(
          end
            ? `opencode exited (${end.code}) ${what}.${tail(end.stderr)}`
            : `opencode stopped telling what it does ${what}.`,
        );
      }
      // (what it wrote before it failed is in the chat already)
      if (r.error) throw new Error(r.error);
      return {
        text: r.answer,
        ...(r.tokens ? { tokens: r.tokens } : {}),
        ...(r.cached ? { cached: r.cached } : {}),
        ...(r.cost ? { cost: r.cost } : {}),
        ...(r.context ? { context: r.context } : {}),
        ...(window ? { window } : {}),
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
      stopTaking();
      await interrupting;
      // (Stopped, or cut off: what it never read goes next, and must not wait in its inbox to be read twice)
      if (unread.size) await takeBack();
    }
  } finally {
    stopStream.abort();
    server?.close();
    files.cleanup();
  }
}

/** The interactive terminal: its own server (not the shared service, which wouldn't see this config), on the
 *  athena agent. The files stay for the terminal's whole session. */
export function terminalLaunch(agent: Agent, systemPrompt: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const files = writeRunFiles(agent, systemPrompt, 'terminal');
  return { args: ['--standalone'], env: { ...process.env, OPENCODE_CONFIG: files.config } };
}

export const opencode: Engine<OpencodeStatus> = { run, status, steer };

// ---------- the Brain's quick questions ----------
/** One line of `opencode run --format json` (the fields used here). */
interface RunLine {
  type?: string;
  part?: {
    id?: string;
    text?: string;
    tool?: string;
    state?: { status?: string; input?: unknown; output?: unknown; error?: unknown };
  };
  error?: { message?: string };
}
export type AskPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; args?: unknown }
  | { kind: 'tool_result'; id: string; text: string; isError?: boolean };

/** The Brain asks opencode one thing: `opencode run` on its own private server, as an agent that can at most
 *  read (read, glob, grep) in cwd, with nothing kept in its session lists. The prompt goes in on stdin. */
export async function ask({
  system,
  user,
  model = '',
  effort = '',
  cwd,
  read = false,
  timeout = 90000,
  onPart,
}: {
  system: string;
  user: string;
  model?: string;
  effort?: string;
  cwd?: string;
  read?: boolean;
  timeout?: number;
  onPart?: (p: AskPart) => void;
}): Promise<string> {
  usable();
  const ref = model ? modelRef(model) : null;
  if (model && !ref)
    throw new Error(
      `"${model}" isn't an opencode model: it is written provider/model, like openrouter/deepseek/deepseek-v4.1-flash.`,
    );
  const variant =
    effort && model
      ? variantFor(effort, (await listModels().catch(() => [])).find((m) => m.id === model)?.variants || [])
      : '';
  const dir = ensureDir(dataPath('tmp'));
  const tag = `opencode-brain-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const brief = path.join(dir, `${tag}.md`);
  const config = path.join(dir, `${tag}.json`);
  fs.writeFileSync(brief, system);
  // nothing but reading (when asked to), not even the MCP servers of the user's own opencode config
  const permissions = [
    rule('*', 'deny'),
    ...(read
      ? [
          rule('read', 'allow'),
          rule('glob', 'allow'),
          rule('grep', 'allow'),
          rule('read', 'deny', '*.env'),
          rule('read', 'deny', '*.env.*'),
        ]
      : []),
  ];
  fs.writeFileSync(
    config,
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      agents: {
        [BRAIN_AGENT]: {
          mode: 'primary',
          description: 'The Athena Agents Brain',
          system: `{file:${brief.replace(/\\/g, '/')}}`,
          permissions,
        },
      },
    }),
  );
  const texts: string[] = [];
  let err = '';
  const onLine = (line: string) => {
    if (!line.startsWith('{')) return;
    let ev: RunLine;
    try {
      ev = JSON.parse(line) as RunLine;
    } catch {
      return;
    }
    const p = ev.part || {};
    if (ev.type === 'text' && p.text) {
      onPart?.({ kind: 'text', text: (texts.length ? '\n\n' : '') + p.text });
      texts.push(p.text);
    } else if (ev.type === 'tool_use' && p.id) {
      const st = p.state || {};
      onPart?.({ kind: 'tool', id: p.id, name: p.tool || 'tool', args: st.input });
      onPart?.({
        kind: 'tool_result',
        id: p.id,
        text: (typeof st.output === 'string' ? st.output : errText(st.error) || JSON.stringify(st.output ?? '')).slice(
          0,
          20000,
        ),
        isError: st.status === 'error',
      });
    } else if (ev.type === 'error') err = ev.error?.message || 'opencode failed.';
  };
  try {
    const args = [
      'run',
      '--standalone',
      '--format',
      'json',
      '--archived',
      '--agent',
      BRAIN_AGENT,
      ...(ref ? ['-m', `${model}${variant ? `#${variant}` : ''}`] : []),
    ];
    const r = await runCmd('opencode', args, {
      input: user,
      timeout,
      cwd,
      env: { ...process.env, OPENCODE_CONFIG: config },
      onLine: (l) => onLine(l.trim()),
    });
    const answer = texts.join('\n\n');
    if (!answer)
      throw new Error(`opencode didn't answer (${(err || r.stderr || '').trim().slice(-300) || `exit ${r.code}`})`);
    return answer;
  } finally {
    fs.rmSync(brief, { force: true });
    fs.rmSync(config, { force: true });
  }
}
const BRAIN_AGENT = 'athena-brain';
