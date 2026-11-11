// The voxel world over oRPC (server/api/world.ts): the world shown before there is one, WORLD.md written (which
// makes the project's world) with its versions, the lists, a field of the wrong kind refused in plain words, and
// /worlds/default answered as the default world, not as a world called "default".
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';
import type { ShownWorld, WorldListing, WorldMdInfo, WorldMdVersionEntry } from '../../shared/types.ts';

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
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as T };
};

describe('the voxel world over oRPC', () => {
  it('say there is no world yet, then make one by writing WORLD.md, and keep its versions', async () => {
    const before = (await send<ShownWorld>('GET', '/api/world')).json;
    if (before.how === 'none') {
      expect(await send('GET', '/api/world/md')).toEqual({ status: 404, json: { error: 'No world yet.' } });
      expect((await send('GET', '/api/world/prefabs')).json).toEqual([]);
    }
    expect((await send<WorldMdInfo>('PUT', '/api/world/md', { text: '# A harbour town' })).json.text).toContain(
      'A harbour town',
    );
    expect((await send<ShownWorld>('GET', '/api/world')).json.world).not.toBeNull();
    await send('PUT', '/api/world/md', { text: '# A harbour town at night' });
    const versions = (await send<WorldMdVersionEntry[]>('GET', '/api/world/md/versions')).json;
    expect(versions.length).toBeGreaterThan(0);
    expect(
      (await send<{ item: { text: string } }>('GET', `/api/world/md/versions/${versions[0].id}`)).json.item.text,
    ).toContain('harbour');
    expect(await send('GET', '/api/world/md/versions/nothing')).toEqual({
      status: 404,
      json: { error: 'No such version.' },
    });
    expect(Array.isArray((await send('GET', '/api/world/changes')).json)).toBe(true);
  });

  it('list the worlds and the prefab library, and answer /worlds/default as the default world', async () => {
    expect((await send<WorldListing[]>('GET', '/api/worlds')).json.length).toBeGreaterThan(0);
    expect(Array.isArray((await send('GET', '/api/prefab-library?q=house')).json)).toBe(true);
    expect(await send('PUT', '/api/worlds/default', { worldId: null })).toEqual({ status: 200, json: { ok: true } });
  });

  it('refuse a field of the wrong kind in plain words', async () => {
    expect(await send('PUT', '/api/world/md', { text: 3 })).toEqual({
      status: 400,
      json: { error: 'Send the whole WORLD.md as text.' },
    });
    expect(await send('PUT', '/api/project-world', { mode: 'merge' })).toEqual({
      status: 400,
      json: { error: 'mode is share, copy, new or auto.' },
    });
    expect(await send('PUT', '/api/world/skins', { to: 'robot' })).toEqual({
      status: 400,
      json: { error: 'to is agent, team or brain.' },
    });
    expect(await send('POST', '/api/world/export', { what: 'everything' })).toEqual({
      status: 400,
      json: { error: 'what is object, prefab or world.' },
    });
    expect(await send('GET', '/api/worlds/nowhere/objects/nothing')).toEqual({
      status: 404,
      json: { error: 'No such object.' },
    });
    expect((await send('PUT', '/api/world/objects/nothing', { hidden: true })).status).toBe(404);
  });
});
