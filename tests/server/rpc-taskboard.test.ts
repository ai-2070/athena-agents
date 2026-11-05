// The Tasks board's oRPC routes (server/api/taskboard.ts) check what comes in before the board sees it:
// a wrong type is refused in plain words, keys a route doesn't take are dropped, and the board's own rules
// still answer in theirs. (tests/server/api.test.ts covers the same routes on the real server.)
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';
import { createProject } from '../../server/projects.ts';
import type { Project } from '../../shared/types.ts';

let base = '';
let project: Project;
const server = http.createServer(async (req, res) => {
  if (!(await handleRpc(req, res, '/api'))) res.writeHead(404).end();
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  project = await createProject({ name: 'Board over oRPC' });
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const send = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

describe('board tags', () => {
  it('refuse a name or an emoji that isn’t text, in plain words', async () => {
    expect(await send('POST', `/api/task-board-tags/${project.id}`, { name: 3 })).toEqual({ status: 400, json: { error: 'Give the tag a name.' } });
    expect(await send('POST', `/api/task-board-tags/${project.id}`, {})).toEqual({ status: 400, json: { error: 'Give the tag a name.' } });
    expect(await send('POST', `/api/task-board-tags/${project.id}`, { name: 'Bug', emoji: 5 })).toEqual({ status: 400, json: { error: 'Choose one emoji for the tag.' } });
  });

  it('leave the board’s own rules to the board', async () => {
    expect(await send('POST', `/api/task-board-tags/${project.id}`, { name: 'Bug', emoji: 'nope' })).toEqual({ status: 400, json: { error: 'Choose one emoji for the tag.' } });
    expect(await send('POST', `/api/task-board-tags/${project.id}`, { name: '  ' })).toEqual({ status: 400, json: { error: 'Give the tag a name.' } });
  });

  it('drop keys they don’t take', async () => {
    const { status, json } = await send('POST', `/api/task-board-tags/${project.id}`, { name: '🐛 Bug', createdBy: 'agent:sneaky', id: 'tagxxxxxxxxxxxxxxxx' });
    expect(status).toBe(200);
    expect(json.tag).toMatchObject({ name: 'Bug', emoji: '🐛', createdBy: 'you', made: true });
    expect((json.tag as { id: string }).id).not.toBe('tagxxxxxxxxxxxxxxxx');
  });

  it('change, list and delete a tag, and say when it is gone', async () => {
    const { json } = await send('POST', `/api/task-board-tags/${project.id}`, { name: 'Design' });
    const id = (json.tag as { id: string }).id;
    expect((await send('PUT', `/api/task-board-tags/${project.id}/${id}`, { emoji: '🎨' })).json.tag).toMatchObject({ name: 'Design', emoji: '🎨' });
    expect(((await send('GET', `/api/task-board-tags/${project.id}`)).json.tags as { name: string }[]).map((t) => t.name)).toContain('Design');
    expect((await send('DELETE', `/api/task-board-tags/${project.id}/${id}`)).json).toMatchObject({ tasks: 0 });
    expect(await send('DELETE', `/api/task-board-tags/${project.id}/${id}`)).toEqual({ status: 404, json: { error: 'That tag is unavailable.' } });
    expect(await send('PUT', `/api/task-board-tags/${project.id}/${id}`, { name: 'Again' })).toEqual({ status: 404, json: { error: 'That tag is unavailable.' } });
  });

  it('say when the project is unavailable', async () => {
    const r = await send('GET', '/api/task-board-tags/nope');
    expect(r.status).toBe(404);
  });
});
