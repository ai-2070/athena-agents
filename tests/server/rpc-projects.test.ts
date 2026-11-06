// The projects' oRPC routes (server/api/projects.ts): a field of the wrong kind is refused in plain words, the
// routes do what the old ones did (make, list, rename, reorder, open, remove, the start screen), and a change to
// a project's opacities tells open tabs. (tests/server/api.test.ts covers more on the real server.)
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';
import { activeProject, bus } from '../../server/store.ts';
import type { ServerEvent } from '../../shared/types.ts';

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
const folderFor = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

describe('projects over oRPC', () => {
  it('refuse a field of the wrong kind in plain words', async () => {
    expect(await send('POST', '/api/projects', {})).toEqual({ status: 400, json: { error: 'Give the project a name.' } });
    const id = activeProject().id;
    expect(await send('PUT', `/api/projects/${id}`, { skills: 'all' })).toEqual({ status: 400, json: { error: 'skills must be a list.' } });
    expect(await send('PUT', `/api/projects/${id}`, { sidebar: 'chat' })).toEqual({ status: 400, json: { error: 'The sidebar shows "status" or "limits".' } });
    expect(await send('PUT', `/api/projects/${id}`, { backgroundOpacity: true })).toEqual({ status: 400, json: { error: 'An opacity is a percent from 0 to 100.' } });
    expect(await send('POST', '/api/projects/order', { ids: 'a,b' })).toEqual({ status: 400, json: { error: 'ids must be a list.' } });
    expect(await send('POST', `/api/projects/${id}/logo`, { data: 5 })).toEqual({ status: 400, json: { error: 'Pick a PNG, JPG, WebP or GIF image.' } });
  });

  it('make a project in an existing folder, list it, rename it, put it first and open it', async () => {
    const made = await send('POST', '/api/projects', { name: 'Bakery', mode: 'existing', folder: folderFor('bakery') });
    expect(made.status).toBe(200);
    const p = made.json as { id: string; name: string; restored: unknown };
    expect(p).toMatchObject({ name: 'Bakery', restored: null });
    const list = (await send('GET', '/api/projects')).json as { projects: { id: string }[]; root: string };
    expect(list.projects.map((x) => x.id)).toContain(p.id);
    expect((await send('PUT', `/api/projects/${p.id}`, { name: 'The bakery', description: 'Bread.' })).json).toMatchObject({ name: 'The bakery', description: 'Bread.' });
    const order = (await send('POST', '/api/projects/order', { ids: [p.id] })).json as { projects: { id: string }[] };
    expect(order.projects[0].id).toBe(p.id);
    expect((await send('POST', `/api/projects/${p.id}/activate`)).json).toMatchObject({ id: p.id });
    expect(activeProject().id).toBe(p.id);
    const shown = (await send('GET', '/api/projects/overview')).json as { active: string; showLauncher: boolean };
    expect(shown).toMatchObject({ active: p.id, showLauncher: false });
  });

  it('tell open tabs when a project’s opacity changes', async () => {
    const seen: ServerEvent[] = [];
    const listen = (e: ServerEvent) => seen.push(e);
    bus.on('event', listen);
    try {
      const id = activeProject().id;
      expect((await send('PUT', `/api/projects/${id}`, { backgroundOpacity: '40%' })).json).toMatchObject({ backgroundOpacity: 40 });
      expect(seen.some((e) => e.type === 'project-logo')).toBe(true);
      seen.length = 0;
      await send('PUT', `/api/projects/${id}`, { description: 'Only words.' });
      expect(seen.some((e) => e.type === 'project-logo')).toBe(false);
    } finally {
      bus.off('event', listen);
    }
  });

  it('list a project’s folder, and say when the project is unavailable', async () => {
    const folder = folderFor('notes');
    fs.writeFileSync(path.join(folder, 'README.md'), '# Notes');
    const p = (await send('POST', '/api/projects', { name: 'Notes', mode: 'existing', folder })).json as { id: string };
    const listing = (await send('GET', `/api/projects/${p.id}/folder?path=`)).json as { entries: { name: string }[] };
    expect(listing.entries.map((e) => e.name)).toContain('README.md');
    expect(await send('GET', '/api/projects/nope/folder')).toEqual({ status: 404, json: { error: 'That project is unavailable.' } });
  });

  it('take a project off the list', async () => {
    const p = (await send('POST', '/api/projects', { name: 'Leaving', mode: 'existing', folder: folderFor('leaving') })).json as { id: string };
    const left = (await send('DELETE', `/api/projects/${p.id}`)).json as unknown as { id: string }[];
    expect(left.map((x) => x.id)).not.toContain(p.id);
  });
});
