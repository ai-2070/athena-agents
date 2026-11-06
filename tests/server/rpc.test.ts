// The routes that moved to oRPC (server/rpc.ts) answer like the old ones: at their own address, JSON never
// cached, errors as { error } with the status the code gave, a failed input check in plain words, and a
// request that isn't theirs left for the old routes with its body unread.
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { oc, type } from '@orpc/contract';
import { implement } from '@orpc/server';
import { z } from 'zod';
import { rpcError, rpcHandler } from '../../server/rpc.ts';

const contract = {
  things: {
    add: oc.route({ method: 'POST', path: '/things/{listId}' })
      .input(z.object({ listId: z.string(), name: z.string({ error: 'Give the thing a name.' }) }))
      .output(type<{ thing: { listId: string; name: string } }>()),
    make: oc.route({ method: 'POST', path: '/things' })
      .input(z.object({ name: z.string().optional() }))
      .output(type<{ name?: string }>()),
    get: oc.route({ method: 'GET', path: '/things/{listId}/{id}' })
      .input(z.object({ listId: z.string(), id: z.string() }))
      .output(type<{ id: string }>()),
  },
};
const os = implement(contract);
const router = os.router({
  things: {
    add: os.things.add.handler(({ input }) => ({ thing: input })),
    make: os.things.make.handler(({ input }) => input),
    get: os.things.get.handler(({ input }) => {
      if (input.id === 'gone') throw Object.assign(new Error('That thing is gone.'), { status: 404 });
      if (input.id === 'broken') throw new Error('The disk is full.');
      return { id: input.id };
    }),
  },
});
const handler = rpcHandler(router);
// (the same routes with a 64-byte limit, under /small)
const small = rpcHandler(router, 64);

let base = '';
const server = http.createServer(async (req, res) => {
  const scoped = /^\/api\/p\/[^/]+/.exec(req.url || '');
  const { matched } = req.url?.startsWith('/small/')
    ? await small.handle(req, res, { prefix: '/small', context: {} })
    : await handler.handle(req, res, { prefix: scoped ? (scoped[0] as `/${string}`) : '/api', context: {} });
  if (matched) return;
  // (the old routes: they read the body themselves)
  let body = '';
  for await (const chunk of req) body += String(chunk);
  res.end(JSON.stringify({ old: true, body }));
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (p: string, body: string) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

describe('oRPC routes', () => {
  it('answer at their own address with JSON that is never cached', async () => {
    const r = await post('/api/things/list%201', JSON.stringify({ name: 'Cake' }));
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ thing: { listId: 'list 1', name: 'Cake' } });
  });

  it('answer under /api/p/<project> for a project that isn’t open', async () => {
    const r = await fetch(`${base}/api/p/other%20one/things/l/a`);
    expect(await r.json()).toEqual({ id: 'a' });
  });

  it('answer an error with the status and words the code gave', async () => {
    const r = await fetch(`${base}/api/things/l/gone`);
    expect(r.status).toBe(404);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({ error: 'That thing is gone.' });
  });

  it('answer anything else that goes wrong as a 500 with its message, and log it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await fetch(`${base}/api/things/l/broken`);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'The disk is full.' });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('refuse a body that fails its check, in the words the schema gives', async () => {
    const r = await post('/api/things/l', JSON.stringify({ name: 3 }));
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'Give the thing a name.' });
  });

  it('refuse a body that isn’t a JSON object, or isn’t JSON', async () => {
    const r = await post('/api/things/l', '[1, 2]');
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'Give the thing a name.' });
    const bad = await post('/api/things/l', '{nope');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Body must be JSON' });
  });

  it('read no body as {}, as the old routes did', async () => {
    const r = await fetch(`${base}/api/things`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({});
    expect(await (await post('/api/things', '')).json()).toEqual({});
  });

  it('refuse null or a bare value as the body, in plain words', async () => {
    for (const body of ['null', '"Cake"', '3']) {
      const r = await post('/api/things', body);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: 'Body must be a JSON object' });
    }
    // (with the route's own fields in its address too)
    expect(await (await post('/api/things/l', 'null')).json()).toEqual({ error: 'Body must be a JSON object' });
  });

  it('refuse a body over the limit with 413, in the old routes’ words', async () => {
    const body = JSON.stringify({ name: 'x'.repeat(200) });
    const answer = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(`${base}/small/things`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        let text = '';
        res.on('data', (c) => (text += String(c)));
        res.on('end', () => resolve({ status: res.statusCode || 0, text }));
      });
      req.on('error', reject);
      req.end(body);
    });
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.text)).toEqual({ error: 'Too large' });
    // (under the limit is fine)
    expect(await (await fetch(`${base}/small/things`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"a"}' })).json()).toEqual({ name: 'a' });
  });

  it('leave a request that isn’t theirs to the old routes, body unread', async () => {
    const r = await post('/api/other', '{"x":1}');
    expect(await r.json()).toEqual({ old: true, body: '{"x":1}' });
    // (the same address with another method isn't theirs either)
    expect(await (await fetch(`${base}/api/things/l`, { method: 'PUT', body: 'y' })).json()).toEqual({ old: true, body: 'y' });
  });
});

describe('rpcError', () => {
  it('keeps a status from 400 to 599 and its message, and makes anything else a 500', () => {
    expect(rpcError(Object.assign(new Error('Taken'), { status: 409 }))).toMatchObject({ status: 409, message: 'Taken', code: 'CONFLICT' });
    expect(rpcError(Object.assign(new Error('Odd'), { status: 418 }))).toMatchObject({ status: 418, message: 'Odd' });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(rpcError(Object.assign(new Error('Fine?'), { status: 200 }))).toMatchObject({ status: 500, message: 'Fine?' });
    expect(rpcError('just words')).toMatchObject({ status: 500, message: 'just words' });
    logged.mockRestore();
  });
});
