// The agents' oRPC routes (server/api/agents.ts): a field of the wrong kind is refused in plain words (a save
// used to keep whatever it was sent), an unknown effort is the default as before, and making, changing,
// copying, deleting and an agent's knowledge work as the old routes did.
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';
import { agents } from '../../server/store.ts';

let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await handleRpc(req, res, '/api'))) res.writeHead(404).end();
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const send = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const make = async (fields: Record<string, unknown> = {}) => (await send('POST', '/api/agents', { name: 'Writer', ...fields })).json as { id: string } & Record<string, unknown>;

describe('agents over oRPC', () => {
  it('refuse a field of the wrong kind in plain words, and leave the agent as it was', async () => {
    const a = await make();
    expect(await send('PUT', `/api/agents/${a.id}`, { engine: 'gpt-9' })).toEqual({ status: 400, json: { error: 'Choose an engine: claude-code, eve, hermes, codex, pi, omp or openclaw.' } });
    expect(await send('PUT', `/api/agents/${a.id}`, { autonomy: 'yolo' })).toEqual({ status: 400, json: { error: 'Choose how freely it works: ask, auto or full.' } });
    expect(await send('PUT', `/api/agents/${a.id}`, { temperature: 'hot' })).toEqual({ status: 400, json: { error: 'temperature must be a number, or empty for the default.' } });
    expect(await send('PUT', `/api/agents/${a.id}`, { toolGroups: 'files' })).toEqual({ status: 400, json: { error: 'toolGroups must be a list.' } });
    expect(await send('POST', '/api/agents', { name: 3 })).toEqual({ status: 400, json: { error: 'name must be text.' } });
    expect(agents.get(a.id)).toMatchObject({ engine: a.engine, autonomy: a.autonomy });
  });

  it('save only what an agent has, not the extras its page shows or ids it is sent', async () => {
    const a = await make();
    const changed = (await send('PUT', `/api/agents/${a.id}`, { name: 'Editor', knowledgeFiles: [{ label: 'x' }], tools: ['shell'], source: { type: 'library' } })).json;
    expect(changed).toMatchObject({ id: a.id, name: 'Editor', source: { type: 'custom' } });
    expect(changed).not.toHaveProperty('knowledgeFiles');
    expect((await send('POST', '/api/agents', { name: 'Chosen', id: 'my-own-id' })).json.id).not.toBe('my-own-id');
  });

  it('copy, show and delete an agent, and say when it is gone', async () => {
    const a = await make({ specialty: 'Words' });
    const copy = (await send('POST', `/api/agents/${a.id}/duplicate`)).json;
    expect(copy).toMatchObject({ name: 'Writer (copy)', specialty: 'Words' });
    expect((await send('GET', `/api/agents/${a.id}`)).json).toMatchObject({ id: a.id, knowledgeFiles: [], tools: expect.any(Array), workspacePath: expect.any(String) });
    expect(await send('DELETE', `/api/agents/${a.id}`)).toEqual({ status: 200, json: { ok: true } });
    expect(await send('GET', `/api/agents/${a.id}`)).toEqual({ status: 404, json: { error: 'That agent is unavailable.' } });
  });

  it('add and remove what an agent knows: a file, a linked folder', async () => {
    const a = await make();
    const { file } = (await send('POST', `/api/agents/${a.id}/knowledge`, { name: 'notes.md', content: 'Bread rises.' })).json as { file: string };
    expect(fs.readFileSync(file, 'utf8')).toBe('Bread rises.');
    const label = ((await send('GET', `/api/agents/${a.id}`)).json.knowledgeFiles as { label: string }[])[0].label;
    expect(await send('DELETE', `/api/agents/${a.id}/knowledge`, { label })).toEqual({ status: 200, json: { ok: true } });
    expect(fs.existsSync(file)).toBe(false);

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
    expect(await send('POST', `/api/agents/${a.id}/knowledge`, { folder })).toEqual({ status: 200, json: { ok: true } });
    expect(agents.get(a.id)?.knowledge.folders).toEqual([folder]);
    expect(await send('DELETE', `/api/agents/${a.id}/knowledge`, { folder })).toEqual({ status: 200, json: { ok: true } });
    expect(agents.get(a.id)?.knowledge.folders).toEqual([]);
    expect(await send('POST', `/api/agents/${a.id}/knowledge`, { folder: path.join(folder, 'missing') })).toMatchObject({ status: 400 });
    expect(await send('DELETE', `/api/agents/${a.id}/knowledge`, {})).toEqual({ status: 400, json: { error: 'Say which file or folder to remove.' } });
  });
});
