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
