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

describe('attached files', () => {
  const upload = (batch: string, rel: string, data: string, headers: Record<string, string> = { 'x-dash': '1' }) => req(`/api/uploads/${batch}?path=${encodeURIComponent(rel)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', ...headers }, body: data });

  it('saves dropped files and folders in the project folder, and never outside it', async () => {
    const { batch } = await (await req('/api/uploads', { method: 'POST', headers: json })).json();
    const st = await (await req('/api/state')).json();
    const root = path.join(st.project.brainPath, 'uploads', batch);
    const f = await (await upload(batch, 'brief.md', '# Brief')).json();
    expect(f.path).toBe(path.join(root, 'brief.md'));
    expect(fs.readFileSync(f.path, 'utf8')).toBe('# Brief');
    const sneaky = await (await upload(batch, '../../../escape.txt', 'x')).json();
    expect(sneaky.path).toBe(path.join(root, 'escape.txt'));
    const inFolder = await (await upload(batch, 'assets/logo.svg', '<svg/>')).json();
    expect(inFolder.top).toBe(path.join(root, 'assets') + path.sep);
    // the page can show it
    expect((await req(`/api/file?path=${encodeURIComponent(f.path)}`)).status).toBe(200);
  });

  it('needs the x-dash header to upload or remove, and removes only uploads', async () => {
    const { batch } = await (await req('/api/uploads', { method: 'POST', headers: json })).json();
    expect((await upload(batch, 'a.md', 'x', {})).status).toBe(403);
    expect((await req('/api/uploads', { method: 'POST' })).status).toBe(403);
    const st = await (await req('/api/state')).json();
    const brainMd = path.join(st.project.brainPath, 'BRAIN.md');
    expect((await req(`/api/uploads?path=${encodeURIComponent(brainMd)}`, { method: 'DELETE', headers: json })).status).toBe(403);
    expect(fs.existsSync(brainMd)).toBe(true);
  });

  it('sends attachments with agent and team messages (a message can be files only)', async () => {
    const { batch } = await (await req('/api/uploads', { method: 'POST', headers: json })).json();
    const f = await (await upload(batch, 'data.csv', 'a,b\n1,2')).json();
    const a = await (await req('/api/agents', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Reader' }) })).json();
    const c = await (await req(`/api/agents/${a.id}/chats`, { method: 'POST', headers: json })).json();
    const outside = path.join(root, 'package.json');
    const sent = await req(`/api/agents/${a.id}/chats/${c.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: '', attachments: [f.path, outside] }) });
    expect(sent.status).toBe(200);
    const chat = await (await req(`/api/agents/${a.id}/chats/${c.id}`)).json();
    expect(chat.items[0]).toMatchObject({ type: 'user', text: '', attachments: [f.path] });
    expect(chat.title).toBe('data.csv');
    // nothing to send: no text, no (valid) files
    expect((await req(`/api/agents/${a.id}/chats/${c.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: ' ', attachments: [outside] }) })).status).toBe(400);

    const t = await (await req('/api/workflows', { method: 'POST', headers: json, body: JSON.stringify({ name: 'Readers', members: [a.id], files: [f.path, outside] }) })).json();
    expect(t.files).toEqual([f.path]);
    const m = await (await req(`/api/teams/${t.id}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text: 'Sum it', attachments: [f.path] }) })).json();
    expect(m).toMatchObject({ from: 'user', text: 'Sum it', attachments: [f.path] });
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

  it('keeps versions of an agent, restores one, and brings back a deleted one', async () => {
    const send = async (p: string, body: unknown, method = 'POST') => (await req(p, { method, headers: json, body: JSON.stringify(body) })).json();
    const a = await send('/api/agents', { name: 'Api versions', systemPrompt: 'First.' });
    await send(`/api/agents/${a.id}`, { systemPrompt: 'Second.' }, 'PUT');
    const hist = await (await req(`/api/versions/agent/${a.id}`)).json();
    expect(hist.versions).toHaveLength(1);
    expect(hist.versions[0].changes).toEqual(['instructions']);
    const v = await (await req(`/api/versions/agent/${a.id}/${hist.versions[0].id}`)).json();
    expect(v.text).toContain('First.');
    // changes need the custom header, like every other change
    expect((await req(`/api/versions/agent/${a.id}/${v.id}/restore`, { method: 'POST' })).status).toBe(403);
    await send(`/api/versions/agent/${a.id}/${v.id}/restore`, {});
    expect((await (await req(`/api/agents/${a.id}`)).json()).systemPrompt).toBe('First.');
    await req(`/api/agents/${a.id}`, { method: 'DELETE', headers: json });
    expect((await (await req('/api/versions/agent')).json()).map((x: { id: string }) => x.id)).toContain(a.id);
    await send(`/api/versions/agent/${a.id}/undelete`, {});
    expect((await req(`/api/agents/${a.id}`)).ok).toBe(true);
    expect((await req('/api/versions/routine')).status).toBe(404);
  });
});
