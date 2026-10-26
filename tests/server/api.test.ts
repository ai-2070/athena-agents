// The real server under Bun, on a spare port, with throwaway data and home folders:
// the API works and the local-only security checks hold.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

const root = path.resolve(import.meta.dirname, '..', '..');
const port = 4870 + Math.floor(Math.random() * 20);
const base = `http://localhost:${port}`;
let proc: ChildProcess;
let tmp: string;

const req = (p: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(base + p, init);
const json = { 'content-type': 'application/json', 'x-dash': '1' };

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-api-'));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  proc = spawn('bun', ['server/index.ts', '--port', String(port), '--no-open'], {
    cwd: root,
    env: { ...process.env, DASH_DATA: path.join(tmp, 'data'), HOME: home, USERPROFILE: home },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await req('/api/state')).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('the server did not start');
}, 30_000);

afterAll(() => {
  proc?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('API', () => {
  it('serves the state the page needs', async () => {
    const st = await (await req('/api/state')).json();
    expect(st.project.name).toBe('My workspace');
    expect(st.agents).toEqual([]);
    expect(st.port).toBe(port);
    expect(st.dataDir.startsWith(tmp)).toBe(true);
  });

  it('creates an agent and a team', async () => {
    const a = await (await req('/api/agents', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Tester' }) })).json();
    expect(a.id).toMatch(/^tester-/);
    const t = await (await req('/api/workflows', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Crew', members: [a.id], lead: a.id }) })).json();
    const list = await (await req('/api/workflows')).json();
    expect(list.find((x: { id: string }) => x.id === t.id)).toMatchObject({ name: 'Crew', members: [a.id] });
  });

  it('makes and edits a routine that mentions an agent and a team', async () => {
    // its own agent and team, so this test runs on its own too
    const post = async (p: string, body: unknown) => (await req(p, { method: 'POST', headers: json, body: JSON.stringify(body) })).json();
    const a = await post('/api/agents', { name: 'Routine Tester' });
    await post('/api/workflows', { name: 'Routine Crew', members: [a.id], lead: a.id });
    const r = await (await req('/api/routines', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Daily' }) })).json();
    // nobody mentioned yet: running it is a clear 400, not a server fault
    expect((await req(`/api/routines/${r.id}/run`, { method: 'POST', headers: json, body: '{}' })).status).toBe(400);
    const saved = await (await req(`/api/routines/${r.id}`, { method: 'PUT', headers: json, body: JSON.stringify({ text: 'Have @Routine Tester and @Routine Crew check in.' }) })).json();
    expect(saved.mentions.map((m: { kind: string; name: string }) => `${m.kind}:${m.name}`)).toEqual(['agent:Routine Tester', 'team:Routine Crew']);
    const list = await (await req('/api/routines')).json();
    expect(list.find((x: { id: string }) => x.id === r.id)).toMatchObject({ name: 'Daily', lastRun: null });
    expect((await req('/api/routines/nope')).status).toBe(404);
    expect((await req(`/api/routines/${r.id}`, { method: 'DELETE', headers: json })).status).toBe(200);
  });

  it('never sends secrets to the browser', async () => {
    await req('/api/secrets', { method: 'POST', headers: json, body: JSON.stringify({ key: 'openrouterKey', value: 'sk-or-v1-supersecretvalue9999' }) });
    const text = await (await req('/api/state')).text();
    expect(text).not.toContain('supersecretvalue');
    expect(JSON.parse(text).secrets.openrouterKey).toEqual({ set: true, hint: '…9999' });
  });

  it('answers 404 for unknown routes and 400 for bad bodies', async () => {
    expect((await req('/api/nope')).status).toBe(404);
    expect((await req('/api/agents', { method: 'POST', headers: json, body: '{oops' })).status).toBe(400);
    expect((await req('/api/agents', { method: 'POST', headers: json, body: 'null' })).status).toBe(400);
  });
});

describe('backups', () => {
  it('backs up a project into the home folder and restores it from an upload or from the backups folder', async () => {
    const st = await (await req('/api/state')).json();
    const made = await (await req(`/api/projects/${st.project.id}/backup`, { method: 'POST', headers: json })).json();
    expect(made.file.startsWith(path.join(tmp, 'home', 'My Dashboard Backups'))).toBe(true);
    const list = await (await req('/api/backups')).json();
    expect(list.backups.map((b: { name: string }) => b.name)).toContain(made.name);

    const bytes = fs.readFileSync(made.file);
    // the file as the body: bigger than a JSON body may be is fine too, but it needs the x-dash header
    expect((await req('/api/backups/restore', { method: 'POST', body: bytes })).status).toBe(403);
    const up = await req('/api/backups/restore?name=From%20upload', { method: 'POST', headers: { 'x-dash': '1', 'content-type': 'application/octet-stream' }, body: bytes });
    expect(up.status).toBe(200);
    const p1 = await up.json();
    expect(p1).toMatchObject({ name: 'From upload', restored: { agents: made.summary.agents, teams: made.summary.teams } });

    const p2 = await (await req(`/api/backups/restore?file=${encodeURIComponent(made.name)}&name=From%20folder`, { method: 'POST', headers: { 'x-dash': '1' } })).json();
    expect(p2.name).toBe('From folder');
    expect(p2.brainPath).not.toBe(p1.brainPath);

    const bad = await req('/api/backups/restore', { method: 'POST', headers: { 'x-dash': '1' }, body: 'not a backup' });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/isn't a dashboard backup/);
    expect((await req('/api/backups/restore?file=..%2Fsecrets.json', { method: 'POST', headers: { 'x-dash': '1' } })).status).toBe(400);
    expect((await req('/api/backups/restore', { method: 'POST', headers: { 'x-dash': '1' } })).status).toBe(400);
  });
});

describe('local-only security', () => {
  it('rejects requests for another host name (DNS rebinding)', async () => {
    const r = await new Promise<number>((resolve) => {
      // fetch won't let us change Host, so use a raw request
      http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: `evil.example:${port}` } }, (res) => resolve(res.statusCode || 0)).on('error', () => resolve(0));
    });
    expect(r).toBe(421);
  });

  it('needs the x-dash header for changes (no simple cross-site POSTs)', async () => {
    const r = await req('/api/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X' }) });
    expect(r.status).toBe(403);
  });

  it('blocks cross-site requests', async () => {
    const r = await req('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } });
    expect(r.status).toBe(403);
  });

  it('sends a strict content security policy with the page', async () => {
    const r = await req('/');
    const csp = r.headers.get('content-security-policy') || '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('accepts the live-events socket only from its own page', async () => {
    const open = (origin: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { origin } });
        ws.on('open', () => (ws.close(), resolve('open')));
        ws.on('error', () => resolve('refused'));
        ws.on('unexpected-response', () => resolve('refused'));
      });
    expect(await open(base)).toBe('open');
    expect(await open('https://evil.example')).toBe('refused');
  });

  it("won't serve files outside its own folders", async () => {
    expect((await req('/api/file?path=' + encodeURIComponent(path.join(root, 'package.json')))).status).toBeGreaterThanOrEqual(400);
    // fetch would normalise a plain "/../", so encode the slash: the server decodes it after parsing the URL
    expect((await req('/%2e%2e%2fpackage.json')).status).not.toBe(200);
    expect((await req('/..%2fpackage.json')).status).not.toBe(200);
  });

  it("won't delete files outside a collection's folder (encoded slash in an id)", async () => {
    const keep = path.join(tmp, 'data', 'keep.json');
    fs.writeFileSync(keep, '{}');
    await req('/api/outbox/..%2fkeep', { method: 'DELETE', headers: json });
    await req('/api/outbox/..%5ckeep', { method: 'DELETE', headers: json });
    expect(fs.existsSync(keep)).toBe(true);
  });
});

describe('agent runs and projects', () => {
  it("tool calls through the MCP bridge stay in the run's project after you open another", async () => {
    // a fake model that holds its answer until the test lets it go
    let release = () => {};
    const model = http.createServer((rq, rs) => {
      if (rq.url?.endsWith('/models')) return rs.end(JSON.stringify({ data: [{ id: 'mock' }] }));
      new Promise<void>((r) => (release = r)).then(() => {
        rs.writeHead(200, { 'content-type': 'text/event-stream' });
        rs.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((r) => model.listen(0, '127.0.0.1', () => r()));
    try {
      const send = async (p: string, body: unknown, method = 'POST') => (await req(p, { method, headers: json, body: JSON.stringify(body) })).json();
      await send('/api/settings', { providers: { custom: { baseUrl: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1` } } }, 'PUT');
      const home = path.join(tmp, 'home');
      const a = await send('/api/projects', { name: 'Bridge A', mode: 'new', folder: path.join(home, 'bridge-a') });
      const agent = await send('/api/agents', { name: 'Bridged', engine: 'openai', provider: 'custom', model: 'mock', toolGroups: ['files'], autonomy: 'auto' });
      const chat = await send(`/api/agents/${agent.id}/chats`, {});
      const { runId } = await send(`/api/agents/${agent.id}/chats/${chat.id}/messages`, { text: 'hello' });
      const b = await send('/api/projects', { name: 'Bridge B', mode: 'new', folder: path.join(home, 'bridge-b') });
      expect((await (await req('/api/state')).json()).project.id).toBe(b.id);

      const internal = { 'content-type': 'application/json', 'x-dash-internal': fs.readFileSync(path.join(tmp, 'data', '.internal-token'), 'utf8').trim() };
      const tools = await (await req(`/api/internal/tools?agent=${agent.id}&run=${runId}`, { headers: internal })).json();
      // the run's own agent (files only), not the outside-client stand-in
      expect(tools.tools.map((t: { name: string }) => t.name)).toContain('write_file');
      expect(tools.tools.map((t: { name: string }) => t.name)).not.toContain('list_programs');
      const r = await (await req('/api/internal/tools/call', { method: 'POST', headers: internal, body: JSON.stringify({ agent: agent.id, run: runId, name: 'write_file', args: { path: 'bridge.txt', content: 'via-bridge' } }) })).json();
      expect(r.isError).toBe(false);
      expect(fs.readFileSync(path.join(a.brainPath, 'bridge.txt'), 'utf8')).toBe('via-bridge');
      expect(fs.existsSync(path.join(b.brainPath, 'bridge.txt'))).toBe(false);
    } finally {
      release();
      await new Promise<void>((r) => model.close(() => r()));
    }
  });
});
