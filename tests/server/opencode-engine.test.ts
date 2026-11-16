// opencode: the run's config (permissions from autonomy, the dashboard bridge, the agent's MCP servers), its
// server's event stream read into the chat, the session a chat keeps, its questions going to approvals, Stop,
// and messages sent while it works. `opencode serve --stdio` is faked by a small HTTP server here that speaks
// the routes and events the engine uses (their shapes checked against opencode 2.2.7).
import fs from 'node:fs';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import type { Agent, Chat, RunEvent } from '../../shared/types.ts';

interface Call {
  method: string;
  route: string;
  body: Record<string, unknown> | null;
}
type Push = (type: string, data?: Record<string, unknown>) => void;
interface Fake {
  calls: Call[];
  spawns: { args: string[]; env: NodeJS.ProcessEnv; config: string; brief: string }[];
  sessions: Map<string, { model?: Record<string, unknown> }>;
  models: Record<string, unknown>[];
  /** what it does with the run's first message */
  onPrompt: (push: Push, sid: string, body: Record<string, unknown>) => void | Promise<void>;
  /** with a message sent while it works */
  onSteer: (push: Push, sid: string, body: Record<string, unknown>) => void;
  /** with an answer to one of its questions */
  onReply: (push: Push, sid: string, id: string) => void;
  /** what DELETE of an inbox entry answers */
  inboxDelete: number;
  /** before it answers that a session was made (a test holds it there) */
  beforeSession: () => void | Promise<void>;
  /** its stdin closed (it ends the polite way) */
  closed: number;
  /** it was killed */
  killed: number;
  /** the last server started dies, printing this to stderr */
  crash: (stderr: string) => void;
}
const fake: Fake = vi.hoisted(
  () =>
    ({
      calls: [],
      spawns: [],
      sessions: new Map(),
      models: [],
      onPrompt: () => {},
      onSteer: () => {},
      onReply: () => {},
      inboxDelete: 204,
      beforeSession: () => {},
      closed: 0,
      killed: 0,
      crash: () => {},
    }) as unknown as Fake,
);
type Decision = { approved: boolean; always?: boolean; message?: string };
type Asked = { title: string; detail?: string; data?: Record<string, unknown> };
const approvals = vi.hoisted(() => ({
  requests: [] as Asked[],
  decide: (_r: Asked): Decision | Promise<Decision> => ({ approved: true }),
  /** the ones still waiting, and what withdrew them */
  waiting: new Map<Asked, (d: Decision) => void>(),
  withdrawn: [] as string[],
}));

function startFake(stdout: PassThrough): http.Server {
  const streams = new Set<http.ServerResponse>();
  const push: Push = (type, data = {}) => {
    for (const res of streams)
      res.write(`id: 1\nevent: message\ndata: ${JSON.stringify({ id: 'evt', created: Date.now(), type, data })}\n\n`);
  };
  const send = (res: http.ServerResponse, status: number, json?: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(json === undefined ? '' : JSON.stringify(json));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const route = req.url || '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      if (route !== '/api/event') fake.calls.push({ method: req.method || '', route, body });
      if (!String(req.headers.authorization).startsWith('Basic ')) return send(res, 401, { message: 'no' });
      let m: RegExpExecArray | null;
      if (route === '/api/event') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'e0', created: 0, type: 'server.connected', data: {} })}\n\n`);
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      if (route === '/api/model') return send(res, 200, { data: fake.models });
      if (route === '/api/model/default') return send(res, 200, { data: fake.models[0] });
      if (route === '/api/session' && req.method === 'POST') {
        void Promise.resolve(fake.beforeSession()).then(() => {
          fake.sessions.set(String(body?.id), { model: body?.model as Record<string, unknown> });
          send(res, 200, { data: { id: body?.id } });
        });
        return;
      }
      if ((m = /^\/api\/session\/([^/]+)$/.exec(route))) {
        const s = fake.sessions.get(decodeURIComponent(m[1]!));
        return s
          ? send(res, 200, { data: { id: m[1], model: s.model } })
          : send(res, 404, { _tag: 'SessionNotFoundError', message: `Session not found: ${m[1]}` });
      }
      if ((m = /^\/api\/session\/([^/]+)\/prompt$/.exec(route))) {
        send(res, 200, { data: { id: body?.id, type: 'user' } });
        const sid = decodeURIComponent(m[1]!);
        if (body?.delivery === 'steer') fake.onSteer(push, sid, body);
        else setImmediate(() => void fake.onPrompt(push, sid, body || {}));
        return;
      }
      if ((m = /^\/api\/session\/([^/]+)\/interrupt$/.exec(route))) {
        send(res, 200, { interrupted: true });
        push('session.execution.interrupted', { sessionID: decodeURIComponent(m[1]!), reason: 'user' });
        return;
      }
      if ((m = /^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/.exec(route))) {
        send(res, 204);
        fake.onReply(push, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
        return;
      }
      if (/^\/api\/session\/[^/]+\/inbox\/[^/]+$/.test(route) && req.method === 'DELETE')
        return send(res, fake.inboxDelete, fake.inboxDelete === 204 ? undefined : { message: 'gone' });
      if (/^\/api\/session\/[^/]+\/model$/.test(route)) return send(res, 200, { data: {} });
      send(res, 404, { message: `no route ${route}` });
    });
  });
  server.listen(0, '127.0.0.1', () =>
    stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })}\n`),
  );
  return server;
}

vi.mock('../../server/util.ts', async (orig) => {
  const real = await orig<typeof import('../../server/util.ts')>();
  return {
    ...real,
    which: (cmd: string) => (cmd === 'opencode' ? '/usr/bin/opencode' : null),
    run: async () => ({ code: 0, stdout: 'opencode v2.2.7\n', stderr: '' }),
    spawnCommand: (_cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();
      Object.assign(child, { stdout, stderr, stdin, exitCode: null, pid: 0 });
      const env = opts.env || {};
      const config = String(env.OPENCODE_CONFIG || '');
      const text = config ? fs.readFileSync(config, 'utf8') : '';
      const briefFile = /\{file:([^}]+)\}/.exec(text)?.[1] || '';
      fake.spawns.push({ args, env, config: text, brief: briefFile ? fs.readFileSync(briefFile, 'utf8') : '' });
      const server = startFake(stdout);
      const end = () => {
        server.closeAllConnections();
        server.close();
        stdout.end();
        stderr.end();
      };
      // (killTree ends up in child.kill on every system here: the fake has no pid)
      Object.assign(child, {
        kill: () => {
          fake.killed++;
          end();
          return true;
        },
      });
      fake.crash = (text) => {
        stderr.write(text);
        end();
      };
      stdin.resume();
      stdin.on('finish', () => {
        fake.closed++;
        end();
      });
      stdout.on('end', () => setImmediate(() => child.emit('close', 0)));
      return child;
    },
  };
});
vi.mock('../../server/approvals.ts', async (orig) => {
  const real = await orig<typeof import('../../server/approvals.ts')>();
  return {
    ...real,
    requestApproval: (r: Asked) => {
      approvals.requests.push(r);
      return new Promise<Decision>((resolve) => {
        approvals.waiting.set(r, resolve);
        void Promise.resolve(approvals.decide(r)).then((d) => {
          approvals.waiting.delete(r);
          resolve(d);
        });
      });
    },
    withdrawApprovals: (match: (item: Asked) => boolean, message: string) => {
      for (const [r, resolve] of approvals.waiting)
        if (match(r)) {
          approvals.waiting.delete(r);
          approvals.withdrawn.push(String(r.data?.permission));
          resolve({ approved: false, message });
        }
    },
  };
});
vi.mock('../../server/mcp.ts', async (orig) => {
  const real = await orig<typeof import('../../server/mcp.ts')>();
  return {
    ...real,
    listServers: () => ({
      github: {
        type: 'stdio',
        command: 'gh-mcp',
        args: ['serve'],
        env: { GITHUB_TOKEN: 'secret-1' },
        url: '',
        headers: {},
        description: '',
        enabled: true,
      },
      notes: {
        type: 'http',
        command: '',
        args: [],
        env: {},
        url: 'https://notes.example/mcp',
        headers: { Authorization: 'Bearer secret-2' },
        description: '',
        enabled: true,
      },
      off: { type: 'stdio', command: 'x', args: [], env: {}, url: '', headers: {}, description: '', enabled: false },
      dashboard_admin: {
        type: 'http',
        command: '',
        args: [],
        env: {},
        url: 'https://admin.example/mcp',
        headers: {},
        description: '',
        enabled: true,
      },
    }),
  };
});

const oc = await import('../../server/engines/opencode.ts');
const { SessionGone } = await import('../../server/engines/cli.ts');
const { newAgent } = await import('../../server/library.ts');
const { agents } = await import('../../server/store.ts');
const { safeUploadsRoot } = await import('../../server/uploads.ts');
const { resolveCommand } = await import('../../server/mcp.ts');

const chatOf = (sessionId: string | null = null) => ({ id: 'c1', items: [], sessionId }) as unknown as Chat;
const argsOf = (agent: Agent, chat: Chat, events: RunEvent[], signal = new AbortController().signal) => ({
  agent,
  chat,
  text: 'fix the test',
  signal,
  onEvent: (e: RunEvent) => events.push(e),
  depth: 0,
  runId: `r${Math.random().toString(36).slice(2)}`,
  systemPrompt: 'You are Coder.',
  attachments: [],
});
const coder = (fields: Partial<Agent> = {}) => newAgent({ name: 'Coder', engine: 'opencode', ...fields });
const callsTo = (re: RegExp) => fake.calls.filter((c) => re.test(c.route));
const wait = async (until: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!until()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

/** A plain turn: some text, a tool call, more text, then the end. */
const plainTurn = (push: Push, sid: string) => {
  const s = { sessionID: sid };
  push('session.execution.started', s);
  push('session.step.started', {
    ...s,
    assistantMessageID: 'msg_a',
    model: { providerID: 'openrouter', id: 'deepseek/flash' },
  });
  push('session.text.started', { ...s, assistantMessageID: 'msg_a', ordinal: 0 });
  push('session.text.delta', { ...s, assistantMessageID: 'msg_a', ordinal: 0, delta: 'Let me ' });
  push('session.text.delta', { ...s, assistantMessageID: 'msg_a', ordinal: 0, delta: 'look.' });
  push('session.text.ended', { ...s, assistantMessageID: 'msg_a', ordinal: 0, text: 'Let me look.' });
  push('session.tool.input.started', { ...s, assistantMessageID: 'msg_a', id: 'call_1', name: 'shell' });
  push('session.tool.called', { ...s, assistantMessageID: 'msg_a', id: 'call_1', input: { command: 'npm test' } });
  push('session.tool.success', {
    ...s,
    assistantMessageID: 'msg_a',
    id: 'call_1',
    content: [
      { type: 'text', text: '3 passed' },
      { type: 'file', uri: 'data:image/png;base64,AAAA', mime: 'image/png' },
    ],
  });
  push('session.step.ended', {
    ...s,
    assistantMessageID: 'msg_a',
    finish: 'tool-calls',
    cost: 0.002,
    tokens: { input: 9000, output: 40, reasoning: 10, cache: { read: 400, write: 0 } },
  });
  push('session.text.started', { ...s, assistantMessageID: 'msg_b', ordinal: 0 });
  push('session.text.delta', { ...s, assistantMessageID: 'msg_b', ordinal: 0, delta: 'All tests pass.' });
  push('session.text.ended', { ...s, assistantMessageID: 'msg_b', ordinal: 0, text: 'All tests pass.' });
  push('session.step.ended', {
    ...s,
    assistantMessageID: 'msg_b',
    finish: 'stop',
    cost: 0.001,
    tokens: { input: 60, output: 12, reasoning: 0, cache: { read: 9400, write: 0 } },
  });
  // (another session's events on the same server are not this chat's)
  push('session.text.delta', { sessionID: 'ses_other', assistantMessageID: 'x', ordinal: 0, delta: 'NOT MINE' });
  push('session.execution.succeeded', s);
};

beforeEach(() => {
  fake.calls = [];
  fake.spawns = [];
  fake.sessions.clear();
  fake.models = [
    {
      id: 'deepseek/flash',
      providerID: 'openrouter',
      name: 'DeepSeek Flash',
      enabled: true,
      variants: [{ id: 'low' }, { id: 'high' }, { id: 'max' }],
      limit: { context: 200000, output: 8000 },
    },
  ];
  fake.onPrompt = () => {};
  fake.onSteer = () => {};
  fake.onReply = () => {};
  fake.inboxDelete = 204;
  fake.beforeSession = () => {};
  fake.closed = 0;
  fake.killed = 0;
  oc.forgetModels();
  approvals.requests = [];
  approvals.decide = () => ({ approved: true });
  approvals.waiting.clear();
  approvals.withdrawn = [];
});

describe('helpers', () => {
  it('reads its version, and knows 1.x is too old', () => {
    expect(oc.parseVersion('opencode v2.2.7\n')).toBe('2.2.7');
    expect(oc.parseVersion('1.19.5')).toBe('1.19.5');
  });
  it('a model id is provider/model, the provider being the part before the first slash', () => {
    expect(oc.modelRef('openrouter/deepseek/deepseek-v4.1-flash')).toEqual({
      providerID: 'openrouter',
      id: 'deepseek/deepseek-v4.1-flash',
    });
    expect(oc.modelRef('big-pickle')).toBeNull();
    expect(oc.modelRef('opencode/')).toBeNull();
  });
  it('effort becomes the model variant of that name, or the nearest one it has', () => {
    expect(oc.variantFor('high', ['low', 'high', 'max'])).toBe('high');
    expect(oc.variantFor('medium', ['low', 'high'])).toBe('low');
    expect(oc.variantFor('xhigh', ['low', 'high', 'max'])).toBe('high');
    expect(oc.variantFor('high', [])).toBe('');
    expect(oc.variantFor('', ['low'])).toBe('');
  });
  it('reads server-sent frames, and skips keep-alives', () => {
    expect(oc.parseFrame('id: 1\nevent: message\ndata: {"type":"session.idle","data":{"sessionID":"ses_1"}}')).toEqual({
      type: 'session.idle',
      data: { sessionID: 'ses_1' },
    });
    expect(oc.parseFrame(': keep-alive')).toBeNull();
    expect(oc.parseFrame('data: not json')).toBeNull();
  });
  it('makes ids the way opencode does: its prefix, then time and letters', () => {
    expect(oc.newId('ses')).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(oc.newId('msg')).not.toBe(oc.newId('msg'));
  });
});

describe('the run config', () => {
  it('Full allows everything but opencode asking you mid-turn', () => {
    expect(oc.permissionRules(coder({ autonomy: 'full' }))).toEqual([
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'dashboard_*', resource: '*', effect: 'allow' },
      { action: 'question', resource: '*', effect: 'deny' },
    ]);
  });
  it('Auto asks before it works outside its folder (the uploads aside) or reads .env files', () => {
    const rules = oc.permissionRules(coder({ autonomy: 'auto' }));
    expect(rules[0]).toEqual({ action: '*', resource: '*', effect: 'allow' });
    expect(rules).toContainEqual({ action: 'external_directory', resource: '*', effect: 'ask' });
    expect(rules).toContainEqual({ action: 'read', resource: '*.env', effect: 'ask' });
    const uploads = safeUploadsRoot();
    if (uploads)
      expect(rules).toContainEqual({
        action: 'external_directory',
        resource: `${uploads.replace(/\\/g, '/')}/*`,
        effect: 'allow',
      });
    // (the last rule that matches wins: the uploads come after the general ask)
    expect(rules.findIndex((r) => r.action === 'external_directory' && r.effect === 'allow')).toBeGreaterThan(
      rules.findIndex((r) => r.action === 'external_directory' && r.effect === 'ask'),
    );
  });
  it('Ask first looks around freely and asks before anything else', () => {
    const rules = oc.permissionRules(coder({ autonomy: 'ask' }));
    expect(rules[0]).toEqual({ action: '*', resource: '*', effect: 'ask' });
    for (const a of ['read', 'glob', 'grep', 'skill'])
      expect(rules).toContainEqual({ action: a, resource: '*', effect: 'allow' });
    expect(rules.some((r) => (r.action === 'shell' || r.action === 'edit') && r.effect === 'allow')).toBe(false);
    expect(rules.at(-2)).toEqual({ action: 'dashboard_*', resource: '*', effect: 'allow' });
  });
  it('the athena agent with the brief from a file, the bridge (its token stays out), and the agent’s own MCP servers', () => {
    const a = coder({ mcpServers: ['github', 'notes', 'off', 'missing'] });
    const cfg = oc.opencodeConfig(a, { briefFile: 'C:\\data\\brief.md', runId: 'r9' }) as {
      agents: Record<string, { system: string; mode: string }>;
      default_agent: string;
      mcp: { servers: Record<string, Record<string, unknown>> };
    };
    expect(cfg.default_agent).toBe('athena');
    expect(cfg.agents.athena).toMatchObject({ mode: 'primary', system: '{file:C:/data/brief.md}' });
    const s = cfg.mcp.servers;
    expect(Object.keys(s).sort()).toEqual(['dashboard', 'github', 'notes']);
    expect(s.dashboard).toMatchObject({
      type: 'local',
      codemode: false,
      environment: { DASH_AGENT: a.id, DASH_RUN: 'r9' },
    });
    expect(s.dashboard!.environment).not.toHaveProperty('DASH_TOKEN');
    // (started the way the dashboard starts it: on Windows a command without an .exe goes through cmd /c)
    const gh = resolveCommand('gh-mcp', ['serve']);
    expect(s.github).toEqual({
      type: 'local',
      command: [gh.command, ...gh.args],
      environment: { GITHUB_TOKEN: 'secret-1' },
    });
    if (process.platform === 'win32')
      expect(s.github!.command).toEqual([process.env.ComSpec || 'cmd.exe', '/c', 'gh-mcp', 'serve']);
    else expect(s.github!.command).toEqual(['gh-mcp', 'serve']);
    expect(s.notes).toEqual({
      type: 'remote',
      url: 'https://notes.example/mcp',
      headers: { Authorization: 'Bearer secret-2' },
      oauth: false,
    });
  });
  it('a server of yours named dashboard_… goes by another name, so the rule that allows the dashboard’s own tools misses it', () => {
    const a = coder({ autonomy: 'ask', mcpServers: ['dashboard_admin'] });
    const servers = oc.mcpServers(a);
    expect(Object.keys(servers).sort()).toEqual(['dashboard', 'mcp-dashboard_admin']);
    // (opencode names its tools <server>_<tool>: mcp-dashboard_admin_delete_user, not dashboard_*)
    expect(
      Object.keys(servers)
        .filter((k) => k !== 'dashboard')
        .some((k) => /^dashboard_/i.test(`${k}_delete_user`)),
    ).toBe(false);
  });
});

describe('a run', () => {
  it('starts its own server with the config, makes the chat’s session, and reads the turn into the chat', async () => {
    fake.onPrompt = plainTurn;
    const chat = chatOf();
    const events: RunEvent[] = [];
    const a = coder({ model: 'openrouter/deepseek/flash', effort: 'medium', mcpServers: ['github'] });
    const r = await oc.opencode.run(argsOf(a, chat, events));
    const sid = chat.sessionId!;

    expect(fake.spawns[0]!.args).toEqual(['serve', '--stdio', '--port', '0']);
    const env = fake.spawns[0]!.env;
    expect(env.OPENCODE_PASSWORD).toBeTruthy();
    // the servers' keys are in the config file, never in its environment (its shell passes that on)
    expect(JSON.stringify(env)).not.toContain('secret-1');
    expect(fake.spawns[0]!.config).toContain('secret-1');
    expect(fake.spawns[0]!.brief).toBe('You are Coder.');
    // the files are gone after the run
    expect(fs.existsSync(String(env.OPENCODE_CONFIG))).toBe(false);

    expect(sid).toMatch(/^ses_/);
    const create = callsTo(/^\/api\/session$/)[0]!;
    // (medium is as near to low as to high: the lower one)
    expect(create.body).toMatchObject({
      id: sid,
      agent: 'athena',
      model: { providerID: 'openrouter', id: 'deepseek/flash', variant: 'low' },
    });
    expect((create.body!.location as { directory: string }).directory).toBeTruthy();
    expect(callsTo(/\/prompt$/)[0]!.body).toMatchObject({ text: 'fix the test' });
    expect(callsTo(/\/prompt$/)[0]!.body!.id).toMatch(/^msg_/);

    expect(
      events
        .filter((e) => e.kind === 'text')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Let me look.\n\nAll tests pass.');
    expect(events).toContainEqual({ kind: 'model', model: 'openrouter/deepseek/flash' });
    expect(events).toContainEqual({ kind: 'tool', id: 'call_1', name: 'shell', args: { command: 'npm test' } });
    expect(events).toContainEqual({
      kind: 'tool_result',
      id: 'call_1',
      text: '3 passed\n[file]',
      isError: false,
      images: ['data:image/png;base64,AAAA'],
    });
    expect(r).toEqual({
      text: 'Let me look.\n\nAll tests pass.',
      tokens: 9000 + 40 + 10 + 400 + 60 + 12 + 9400,
      cached: 9800,
      cost: 0.003,
      context: 60 + 9400 + 12,
      window: 200000,
    });
    await wait(() => fake.closed === 1);
  });

  it('continues the session the chat has, and moves it to the agent’s model', async () => {
    fake.sessions.set('ses_old', { model: { providerID: 'opencode', id: 'big-pickle' } });
    fake.onPrompt = plainTurn;
    const chat = chatOf('ses_old');
    await oc.opencode.run(argsOf(coder({ model: 'openrouter/deepseek/flash' }), chat, []));
    expect(callsTo(/^\/api\/session$/)).toHaveLength(0);
    expect(callsTo(/^\/api\/session\/[^/]+\/model$/)[0]!.body).toEqual({
      model: { providerID: 'openrouter', id: 'deepseek/flash' },
    });
    expect(chat.sessionId).toBe('ses_old');
  });

  it('on opencode’s default model, the effort still picks its variant', async () => {
    fake.onPrompt = plainTurn;
    const chat = chatOf();
    const r = await oc.opencode.run(argsOf(coder({ effort: 'high' }), chat, []));
    expect(callsTo(/^\/api\/session$/)[0]!.body!.model).toEqual({
      providerID: 'openrouter',
      id: 'deepseek/flash',
      variant: 'high',
    });
    expect(r.window).toBe(200000);
  });

  it('on opencode’s default model with no effort, a new session is left to follow its default', async () => {
    fake.onPrompt = plainTurn;
    await oc.opencode.run(argsOf(coder(), chatOf(), []));
    expect(callsTo(/^\/api\/session$/)[0]!.body).not.toHaveProperty('model');
  });

  it('a session goes back to opencode’s default when the agent’s model is cleared', async () => {
    fake.sessions.set('ses_old', { model: { providerID: 'opencode', id: 'big-pickle' } });
    fake.onPrompt = plainTurn;
    await oc.opencode.run(argsOf(coder(), chatOf('ses_old'), []));
    expect(callsTo(/^\/api\/session\/[^/]+\/model$/)[0]!.body).toEqual({
      model: { providerID: 'openrouter', id: 'deepseek/flash' },
    });
  });

  it('a session leaves its variant when the agent’s effort is cleared, and stays put when nothing changed', async () => {
    fake.sessions.set('ses_old', { model: { providerID: 'openrouter', id: 'deepseek/flash', variant: 'high' } });
    fake.onPrompt = plainTurn;
    await oc.opencode.run(argsOf(coder({ model: 'openrouter/deepseek/flash', effort: 'high' }), chatOf('ses_old'), []));
    expect(callsTo(/^\/api\/session\/[^/]+\/model$/)).toHaveLength(0);
    await oc.opencode.run(argsOf(coder({ model: 'openrouter/deepseek/flash' }), chatOf('ses_old'), []));
    expect(callsTo(/^\/api\/session\/[^/]+\/model$/)[0]!.body).toEqual({
      model: { providerID: 'openrouter', id: 'deepseek/flash' },
    });
  });

  it('a session opencode no longer has: the chat starts a new one with the chat so far', async () => {
    const chat = chatOf('ses_gone');
    const err = await oc.opencode.run(argsOf(coder(), chat, [])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionGone);
    expect(chat.sessionId).toBeNull();
    expect(chat.reseed).toBe(true);
    // (a session of another engine isn't opencode's either)
    const other = chatOf('5bc68a5e-de26-4882');
    expect(await oc.opencode.run(argsOf(coder(), other, [])).catch((e: unknown) => e)).toBeInstanceOf(SessionGone);
  });

  it('a model id without a provider is refused in plain words', async () => {
    await expect(oc.opencode.run(argsOf(coder({ model: 'big-pickle' }), chatOf(), []))).rejects.toThrow(
      /provider\/model/,
    );
  });

  it('its failure is the run’s error', async () => {
    fake.onPrompt = (push, sid) => {
      push('session.execution.started', { sessionID: sid });
      push('session.execution.failed', {
        sessionID: sid,
        error: { type: 'provider.free-limit', message: 'Free usage limit reached.' },
      });
    };
    await expect(oc.opencode.run(argsOf(coder(), chatOf(), []))).rejects.toThrow('Free usage limit reached.');
  });

  it('a failure after some text is still a failure (the text is in the chat already)', async () => {
    fake.onPrompt = (push, sid) => {
      push('session.execution.started', { sessionID: sid });
      push('session.text.delta', { sessionID: sid, assistantMessageID: 'm', ordinal: 0, delta: 'Half an answ' });
      push('session.execution.failed', {
        sessionID: sid,
        error: { type: 'provider', message: 'The provider hung up.' },
      });
    };
    const events: RunEvent[] = [];
    await expect(oc.opencode.run(argsOf(coder(), chatOf(), events))).rejects.toThrow('The provider hung up.');
    expect(events).toContainEqual({ kind: 'text', text: 'Half an answ' });
  });

  it('it dies in the middle of its answer: an error with the end of what it printed, not half an answer', async () => {
    fake.onPrompt = (push, sid) => {
      push('session.execution.started', { sessionID: sid });
      push('session.text.delta', { sessionID: sid, assistantMessageID: 'm', ordinal: 0, delta: 'Half an answ' });
      setTimeout(() => fake.crash('panic: out of memory'), 20);
    };
    const err = (await oc.opencode.run(argsOf(coder(), chatOf(), [])).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/before it finished its answer/);
    expect(err.message).toContain('panic: out of memory');
  });
});

describe('its questions', () => {
  const asking = (push: Push, sid: string) => {
    push('session.execution.started', { sessionID: sid });
    push('permission.asked', {
      id: 'per_1',
      sessionID: sid,
      action: 'shell',
      resources: ['rm -rf build'],
      save: ['rm *'],
    });
  };
  const answered = (push: Push, sid: string) => {
    push('session.text.delta', { sessionID: sid, assistantMessageID: 'm', ordinal: 0, delta: 'Done.' });
    push('session.execution.succeeded', { sessionID: sid });
  };

  it('go to the approvals; yes answers once', async () => {
    fake.onPrompt = asking;
    fake.onReply = answered;
    expect((await oc.opencode.run(argsOf(coder(), chatOf(), []))).text).toBe('Done.');
    expect(approvals.requests[0]).toMatchObject({
      title: 'Coder wants to run a command',
      detail: 'rm -rf build',
      data: { tool: 'opencode:shell' },
    });
    expect(callsTo(/permission\/per_1\/reply$/)[0]!.body).toEqual({ decision: 'once' });
  });

  it('no refuses with your reason, which the model reads', async () => {
    approvals.decide = () => ({ approved: false, message: 'Not the build folder.' });
    fake.onPrompt = asking;
    fake.onReply = answered;
    await oc.opencode.run(argsOf(coder(), chatOf(), []));
    expect(callsTo(/permission\/per_1\/reply$/)[0]!.body).toEqual({
      decision: 'reject',
      message: 'Not the build folder.',
    });
  });

  it('refusing one refuses every question still open: those leave Needs you', async () => {
    // the command is refused; the file change is never answered by you
    approvals.decide = (r) =>
      /command/.test(r.title) ? { approved: false, message: 'No commands.' } : new Promise<Decision>(() => {});
    fake.onPrompt = (push, sid) => {
      push('session.execution.started', { sessionID: sid });
      push('permission.asked', { id: 'per_edit', sessionID: sid, action: 'edit', resources: ['hello.txt'] });
      push('permission.asked', { id: 'per_cmd', sessionID: sid, action: 'shell', resources: ['echo done'] });
    };
    fake.onReply = (push, sid, id) => {
      push('permission.replied', { sessionID: sid, requestID: id, reply: 'reject' });
      // (opencode refuses the other one too, by itself)
      push('permission.replied', { sessionID: sid, requestID: 'per_edit', reply: 'reject' });
      answered(push, sid);
    };
    await oc.opencode.run(argsOf(coder(), chatOf(), []));
    expect(approvals.withdrawn).toEqual(['per_edit']);
    expect(approvals.waiting.size).toBe(0);
    expect(callsTo(/permission\/per_cmd\/reply$/)[0]!.body).toEqual({ decision: 'reject', message: 'No commands.' });
  });

  it('a helper agent’s questions come too, and the answer goes back to its session; another chat’s do not', async () => {
    let main = '';
    fake.onPrompt = (push, sid) => {
      main = sid;
      push('session.execution.started', { sessionID: sid });
      push('session.created', { sessionID: 'ses_helper', parentID: sid, title: 'Look around' });
      push('session.created', { sessionID: 'ses_helper2', parentID: 'ses_helper' });
      push('permission.asked', {
        id: 'per_stranger',
        sessionID: 'ses_stranger',
        action: 'shell',
        resources: ['rm -rf /'],
      });
      push('permission.asked', { id: 'per_h', sessionID: 'ses_helper2', action: 'shell', resources: ['ls'] });
    };
    fake.onReply = (push) => answered(push, main);
    expect((await oc.opencode.run(argsOf(coder(), chatOf(), []))).text).toBe('Done.');
    expect(approvals.requests).toHaveLength(1);
    expect(approvals.requests[0]).toMatchObject({ title: "Coder's helper agent wants to run a command", detail: 'ls' });
    expect(callsTo(/\/permission\//).map((c) => c.route)).toEqual(['/api/session/ses_helper2/permission/per_h/reply']);
  });

  it('Stop interrupts its helper agents too', async () => {
    fake.onPrompt = (push, sid) => {
      push('session.execution.started', { sessionID: sid });
      push('session.created', { sessionID: 'ses_helper', parentID: sid });
      push('session.tool.input.started', { sessionID: sid, assistantMessageID: 'm', id: 'call_1', name: 'subagent' });
      push('session.tool.called', { sessionID: sid, assistantMessageID: 'm', id: 'call_1', input: {} });
    };
    const ac = new AbortController();
    const events: RunEvent[] = [];
    const pending = oc.opencode.run(argsOf(coder(), chatOf(), events, ac.signal));
    await wait(() => events.some((e) => e.kind === 'tool'));
    ac.abort();
    await expect(pending).rejects.toThrow('Stopped.');
    expect(callsTo(/\/interrupt$/).map((c) => c.route)).toContain('/api/session/ses_helper/interrupt');
  });

  it('always allow: the agent is not asked about that again', async () => {
    approvals.decide = () => ({ approved: true, always: true });
    fake.onPrompt = asking;
    fake.onReply = answered;
    const a = coder();
    agents.save(a);
    for (let i = 0; i < 2; i++) await oc.opencode.run(argsOf(agents.get(a.id)!, chatOf(), []));
    expect(approvals.requests).toHaveLength(1);
    expect(agents.get(a.id)!.alwaysAllow).toContain('opencode:shell');
    expect(callsTo(/permission\/per_1\/reply$/)).toHaveLength(2);
  });

  it('always allow outside its folder covers that folder only, and a .env file that file only', async () => {
    approvals.decide = () => ({ approved: true, always: true });
    let ask = { action: 'external_directory', resources: ['C:/Users/me/Downloads/*'] };
    fake.onPrompt = (push, sid) => {
      push('session.execution.started', { sessionID: sid });
      push('permission.asked', { id: 'per_1', sessionID: sid, ...ask });
    };
    fake.onReply = answered;
    const a = coder();
    agents.save(a);
    const runOnce = () => oc.opencode.run(argsOf(agents.get(a.id)!, chatOf(), []));
    await runOnce();
    expect(approvals.requests[0]!.data).toMatchObject({
      tool: 'opencode:external_directory',
      alwaysMeans: 'Allow this folder for this agent from now on (not every folder)',
    });
    expect(agents.get(a.id)!.alwaysAllow).toEqual(['opencode:external_directory:C:/Users/me/Downloads/*']);
    // the same folder again: not asked
    await runOnce();
    expect(approvals.requests).toHaveLength(1);
    // another folder (with that one): asked
    ask = { action: 'external_directory', resources: ['C:/Users/me/Downloads/*', 'C:/*'] };
    approvals.decide = () => ({ approved: true });
    await runOnce();
    expect(approvals.requests).toHaveLength(2);
    // a .env file: its own name
    ask = { action: 'read', resources: ['.env'] };
    approvals.decide = () => ({ approved: true, always: true });
    await runOnce();
    expect(agents.get(a.id)!.alwaysAllow).toContain('opencode:read:.env');
    expect(agents.get(a.id)!.alwaysAllow).not.toContain('opencode:read');
  });
});

describe('Stop', () => {
  it('interrupts its turn, and the server ends', async () => {
    fake.onPrompt = (push, sid) => {
      push('session.execution.started', { sessionID: sid });
      push('session.tool.input.started', { sessionID: sid, assistantMessageID: 'm', id: 'call_1', name: 'shell' });
      push('session.tool.called', {
        sessionID: sid,
        assistantMessageID: 'm',
        id: 'call_1',
        input: { command: 'sleep 99' },
      });
    };
    const ac = new AbortController();
    const events: RunEvent[] = [];
    const pending = oc.opencode.run(argsOf(coder(), chatOf(), events, ac.signal));
    await wait(() => events.some((e) => e.kind === 'tool'));
    ac.abort();
    await expect(pending).rejects.toThrow('Stopped.');
    expect(callsTo(/\/interrupt$/)).toHaveLength(1);
    await wait(() => fake.closed === 1);
    // (asked to stop, not killed: the interrupt reached it and it saved the turn as stopped)
    expect(fake.killed).toBe(0);
  });

  it('Stop while it sets up its session: the wait ends at once, and its turn never begins', async () => {
    let asked = false;
    fake.beforeSession = () => {
      asked = true;
      return new Promise<void>(() => {});
    };
    const ac = new AbortController();
    const pending = oc.opencode.run(argsOf(coder(), chatOf(), [], ac.signal));
    await wait(() => asked);
    ac.abort();
    await expect(pending).rejects.toThrow();
    expect(callsTo(/\/prompt$/)).toHaveLength(0);
    await wait(() => fake.closed + fake.killed === 1);
  });

  it('Stop while it starts: it is killed, and its turn never begins', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(oc.opencode.run(argsOf(coder(), chatOf(), [], ac.signal))).rejects.toThrow('Stopped.');
    expect(fake.killed).toBe(1);
    expect(callsTo(/\/prompt$/)).toHaveLength(0);
  });
});

describe('a message sent while it works', () => {
  it('goes into the turn, and shows where it read it', async () => {
    const runId = 'r-steer';
    fake.onPrompt = (push, sid) => {
      push('session.execution.started', { sessionID: sid });
      push('session.text.delta', { sessionID: sid, assistantMessageID: 'm1', ordinal: 0, delta: 'Working.' });
    };
    fake.onSteer = (push, sid, body) => {
      setImmediate(() => {
        push('session.inbox.delivered', { sessionID: sid, inboxID: body.id });
        push('session.text.started', { sessionID: sid, assistantMessageID: 'm2', ordinal: 0 });
        push('session.text.delta', { sessionID: sid, assistantMessageID: 'm2', ordinal: 0, delta: 'BANANA' });
        push('session.execution.succeeded', { sessionID: sid });
      });
    };
    const events: RunEvent[] = [];
    const pending = oc.opencode.run({ ...argsOf(coder(), chatOf(), events), runId });
    await wait(() => events.some((e) => e.kind === 'text'));
    await oc.steer.send(runId, { id: 'st1', text: 'end with BANANA' });
    const r = await pending;
    expect(callsTo(/\/prompt$/)[1]!.body).toMatchObject({ text: 'end with BANANA', delivery: 'steer' });
    expect(events).toContainEqual({ kind: 'steer', id: 'st1', text: 'end with BANANA' });
    // (the chat starts a new block after the message it read: no extra gap)
    expect(events.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text)).toEqual([
      'Working.',
      'BANANA',
    ]);
    expect(r.text).toBe('Working.\n\nBANANA');
    expect(oc.steer.can(runId)).toBe(false);
    await expect(oc.steer.send(runId, { id: 'st2', text: 'late' })).rejects.toThrow(/no longer/);
  });

  it('one it never read as its turn ended comes back out of its inbox (it goes next, the ordinary way)', async () => {
    const runId = 'r-late';
    let sid = '';
    fake.onPrompt = (push, s) => {
      sid = s;
      push('session.execution.started', { sessionID: s });
      push('session.text.delta', { sessionID: s, assistantMessageID: 'm1', ordinal: 0, delta: 'Done.' });
    };
    // it takes the message into its inbox, but the turn ends before it reads it
    fake.onSteer = (push, s) => setImmediate(() => push('session.execution.succeeded', { sessionID: s }));
    const events: RunEvent[] = [];
    const pending = oc.opencode.run({ ...argsOf(coder(), chatOf(), events), runId });
    await wait(() => events.some((e) => e.kind === 'text'));
    await oc.steer.send(runId, { id: 'st1', text: 'one more thing' });
    expect((await pending).text).toBe('Done.');
    const steered = callsTo(/\/prompt$/)[1]!.body!.id as string;
    expect(callsTo(/\/inbox\//).map((c) => [c.method, c.route])).toEqual([
      ['DELETE', `/api/session/${sid}/inbox/${steered}`],
    ]);
    expect(events.some((e) => e.kind === 'steer')).toBe(false);
  });

  it('Stop takes one it never read back out of its inbox too', async () => {
    const runId = 'r-stop-unread';
    let sid = '';
    fake.onPrompt = (push, s) => {
      sid = s;
      push('session.execution.started', { sessionID: s });
      push('session.text.delta', { sessionID: s, assistantMessageID: 'm1', ordinal: 0, delta: 'Working.' });
    };
    const ac = new AbortController();
    const events: RunEvent[] = [];
    const pending = oc.opencode.run({ ...argsOf(coder(), chatOf(), events, ac.signal), runId });
    await wait(() => events.some((e) => e.kind === 'text'));
    await oc.steer.send(runId, { id: 'st1', text: 'one more thing' });
    ac.abort();
    await expect(pending).rejects.toThrow('Stopped.');
    const steered = callsTo(/\/prompt$/)[1]!.body!.id as string;
    expect(callsTo(/\/inbox\//).map((c) => [c.method, c.route])).toEqual([
      ['DELETE', `/api/session/${sid}/inbox/${steered}`],
    ]);
  });

  it('one it already took in as its turn ended: the turn it starts for it is followed to its end', async () => {
    fake.inboxDelete = 404;
    const runId = 'r-next';
    fake.onPrompt = (push, sid) => {
      push('session.execution.started', { sessionID: sid });
      push('session.text.delta', { sessionID: sid, assistantMessageID: 'm1', ordinal: 0, delta: 'First.' });
    };
    fake.onSteer = (push, sid, body) => {
      setImmediate(() => {
        push('session.execution.succeeded', { sessionID: sid });
        setTimeout(() => {
          push('session.execution.started', { sessionID: sid });
          push('session.inbox.delivered', { sessionID: sid, inboxID: body.id });
          push('session.text.started', { sessionID: sid, assistantMessageID: 'm2', ordinal: 0 });
          push('session.text.delta', { sessionID: sid, assistantMessageID: 'm2', ordinal: 0, delta: 'Second.' });
          push('session.execution.succeeded', { sessionID: sid });
        }, 30);
      });
    };
    const events: RunEvent[] = [];
    const pending = oc.opencode.run({ ...argsOf(coder(), chatOf(), events), runId });
    await wait(() => events.some((e) => e.kind === 'text'));
    await oc.steer.send(runId, { id: 'st1', text: 'and then?' });
    expect((await pending).text).toBe('First.\n\nSecond.');
    expect(events).toContainEqual({ kind: 'steer', id: 'st1', text: 'and then?' });
  });
});

describe('models', () => {
  it('lists what its server says, as provider/model with the context size', async () => {
    const list = await oc.listModels();
    expect(list).toEqual([
      { id: 'openrouter/deepseek/flash', name: 'DeepSeek Flash', context: 200000, variants: ['low', 'high', 'max'] },
    ]);
    await wait(() => fake.closed === 1);
  });

  it('several asking at once start one server, and the list is kept', async () => {
    const lists = await Promise.all([oc.listModels(), oc.listModels(), oc.listModels()]);
    expect(lists.every((l) => l.length === 1)).toBe(true);
    await oc.listModels();
    expect(fake.spawns).toHaveLength(1);
  });

  it('an empty list is kept a short while too, not asked for on every look', async () => {
    fake.models = [];
    expect(await oc.listModels()).toEqual([]);
    expect(await oc.listModels()).toEqual([]);
    expect(fake.spawns).toHaveLength(1);
  });

  it('a run uses the kept list, and asks again only for a model it doesn’t have', async () => {
    await oc.listModels();
    fake.calls = [];
    fake.onPrompt = plainTurn;
    const r = await oc.opencode.run(
      argsOf(coder({ model: 'openrouter/deepseek/flash', effort: 'high' }), chatOf(), []),
    );
    expect(callsTo(/^\/api\/model$/)).toHaveLength(0);
    expect(r.window).toBe(200000);
    expect(callsTo(/^\/api\/session$/)[0]!.body!.model).toMatchObject({ variant: 'high' });
    fake.models.push({
      id: 'new-one',
      providerID: 'openrouter',
      name: 'New',
      enabled: true,
      variants: [{ id: 'max' }],
      limit: { context: 1000 },
    });
    await oc.opencode.run(argsOf(coder({ model: 'openrouter/new-one', effort: 'max' }), chatOf(), []));
    expect(callsTo(/^\/api\/model$/)).toHaveLength(1);
    expect(callsTo(/^\/api\/session$/)[1]!.body!.model).toEqual({
      providerID: 'openrouter',
      id: 'new-one',
      variant: 'max',
    });
  });
});
