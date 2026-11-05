// Files and the smaller things around them over oRPC (server/api/files.ts, assist.ts): a chat's files looked up only
// inside the dashboard's folders, an attached file taken back by its ?path=, MEMORY.md read and saved, the map's
// layout kept where it isn't changed, terminals, and the Brain's drafts refused when there is nothing to draft.
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';
import { newAgent } from '../../server/library.ts';
import type { FileInfo, MemoryInfo } from '../../shared/types.ts';

let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await handleRpc(req, res, '/api'))) res.writeHead(404).end();
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const send = async <T = Record<string, unknown>>(method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as T };
};

describe('files over oRPC', () => {
  it('look up a file inside the dashboard folders, and not one outside them', async () => {
    const batch = (await send<{ batch: string; dir: string }>('POST', '/api/uploads')).json;
    const inside = path.join(batch.dir, 'note.txt');
    fs.writeFileSync(inside, 'hello');
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rpc-files-')), 'secret.txt');
    fs.writeFileSync(outside, 'no');
    const [a, b] = (await send<FileInfo[]>('POST', '/api/files/info', { paths: [inside, outside] })).json;
    expect(a).toMatchObject({ ok: true, name: 'note.txt', kind: 'file', size: 5 });
    expect(b).toEqual({ path: outside, ok: false });
    expect(await send('POST', '/api/files/info', { paths: inside })).toEqual({ status: 400, json: { error: 'paths must be a list.' } });
    // taken back by the path the upload gave it
    expect((await send('DELETE', `/api/uploads?path=${encodeURIComponent(inside)}`)).json).toEqual({ ok: true });
    expect(fs.existsSync(inside)).toBe(false);
    expect(await send('DELETE', '/api/uploads')).toEqual({ status: 400, json: { error: 'Say which file.' } });
  });

  it("read and save an agent's MEMORY.md, and the Brain's", async () => {
    const a = newAgent({ name: 'Rememberer' });
    expect((await send<MemoryInfo>('PUT', `/api/memory/${a.id}`, { text: '- likes tea' })).json.text.trim()).toBe('- likes tea');
    expect((await send<MemoryInfo>('GET', `/api/memory/${a.id}`)).json).toMatchObject({ owner: a.id, name: 'Rememberer' });
    expect((await send<MemoryInfo>('GET', '/api/memory/brain')).json.owner).toBe('brain');
    expect(await send('GET', '/api/memory/nobody')).toEqual({ status: 404, json: { error: 'No agent by that id.' } });
    expect(await send('PUT', `/api/memory/${a.id}`, { text: 5 })).toEqual({ status: 400, json: { error: 'Send the whole MEMORY.md as text.' } });
  });

  it("keep the map's layout where a change leaves it, and refuse a place that isn't one", async () => {
    expect(await send('PUT', '/api/layout', { bench: { x: 3, z: 4 } })).toEqual({ status: 200, json: { ok: true } });
    expect((await send('GET', '/api/layout')).json).toEqual({ bench: { x: 3, z: 4 } });
    expect(await send('PUT', '/api/layout', { bench: { x: 'left' } })).toEqual({ status: 400, json: { error: 'A place on the map is x and z.' } });
    expect((await send('PUT', '/api/layout', {})).json).toEqual({ ok: true });
    expect((await send('GET', '/api/layout')).json).toEqual({ bench: { x: 3, z: 4 } });
  });

  it('list artifacts, backups and terminals, and refuse a terminal of a kind there is not', async () => {
    expect(Array.isArray((await send('GET', '/api/artifacts')).json)).toBe(true);
    expect((await send('GET', '/api/backups')).json).toMatchObject({ dir: expect.any(String), backups: expect.any(Array) });
    expect(Array.isArray((await send('GET', '/api/terminals')).json)).toBe(true);
    expect(await send('POST', '/api/terminals', { kind: 'telnet' })).toEqual({ status: 400, json: { error: 'A terminal is a shell, an agent or a command.' } });
    expect(await send('POST', '/api/terminals', { kind: 'agent', agentId: 'nobody' })).toEqual({ status: 404, json: { error: 'That agent is unavailable.' } });
    expect(await send('DELETE', '/api/terminals/nothing')).toEqual({ status: 200, json: { ok: false } });
  });
});

describe("the Brain's drafts over oRPC", () => {
  it('refuse a skill draft with nothing to draft, and a request of the wrong kind', async () => {
    expect(await send('POST', '/api/assist/skill', { text: '  ' })).toEqual({ status: 400, json: { error: 'Say what the skill should do, or what to change.' } });
    expect(await send('POST', '/api/assist/branch', { text: 'a team', allowNew: 'yes' })).toEqual({ status: 400, json: { error: 'allowNew must be true or false.' } });
    expect((await send('GET', '/api/assist/model')).json).toMatchObject({ provider: expect.any(String) });
  });
});
