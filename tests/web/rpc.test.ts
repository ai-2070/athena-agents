// Typed calls (web/client/rpc.ts) go out the way api() sends a request, to the same address with the same
// headers, and fail the same way: an Error with the server's words and the status.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import { setConnection, setPageProject } from '../../web/client/connection.ts';
import { rpcClient } from '../../web/client/rpc.ts';

const contract = {
  things: {
    list: oc.route({ method: 'GET', path: '/things' }).input(z.object({ q: z.string() })).output(type<{ things: string[] }>()),
    add: oc.route({ method: 'POST', path: '/things/{listId}' }).input(z.object({ listId: z.string(), name: z.string() })).output(type<{ ok: boolean }>()),
    remove: oc.route({ method: 'DELETE', path: '/things/{listId}/{id}' }).input(z.object({ listId: z.string(), id: z.string() })).output(type<{ ok: boolean }>()),
  },
};
const rpc = rpcClient(contract);

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
const answer = (body: unknown, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }));

beforeEach(() => {
  calls = [];
  setConnection();
});
afterEach(() => {
  vi.unstubAllGlobals();
  setConnection();
  setPageProject(null);
});

describe('rpc calls', () => {
  it('send a change like api() does: the address, the method, the JSON body and the dashboard headers', async () => {
    answer({ ok: true });
    setPageProject('p1');
    expect(await rpc.things.add({ listId: 'list 1', name: 'Cake' })).toEqual({ ok: true });
    const [c] = calls;
    expect(c.url).toBe('/api/things/list%201');
    expect(c.init.method).toBe('POST');
    expect(JSON.parse(String(c.init.body))).toEqual({ name: 'Cake' });
    expect(c.init.headers).toMatchObject({ 'x-dash': '1', 'x-dash-project': 'p1', 'content-type': 'application/json' });
  });

  it('put a read’s input in the query, and send no body', async () => {
    answer({ things: [] });
    await rpc.things.list({ q: 'a b' });
    expect(calls[0].url).toMatch(/^\/api\/things\?q=a(\+|%20)b$/);
    expect(calls[0].init).toMatchObject({ method: 'GET', body: undefined });
    answer({ ok: true });
    await rpc.things.remove({ listId: 'l', id: 'x' });
    expect(calls[1]).toMatchObject({ url: '/api/things/l/x', init: { method: 'DELETE', body: undefined } });
  });

  it('go to the server the connection names', async () => {
    answer({ ok: true });
    setConnection({ base: 'http://127.0.0.1:4900/' });
    await rpc.things.remove({ listId: 'l', id: 'x' });
    expect(calls[0].url).toBe('http://127.0.0.1:4900/api/things/l/x');
  });

  it('fail with the server’s own words and the status, as api() does', async () => {
    answer({ error: 'That thing is gone.' }, 404);
    const e: unknown = await rpc.things.remove({ listId: 'l', id: 'x' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ message: 'That thing is gone.', status: 404 });
  });

  it('fail with the status when the server gave no words', async () => {
    answer({}, 500);
    const e: unknown = await rpc.things.remove({ listId: 'l', id: 'x' }).catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 500 });
    expect((e as Error).message).toBeTruthy();
  });

  it('pass on a server that can’t be reached as it is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(rpc.things.remove({ listId: 'l', id: 'x' })).rejects.toThrow('Failed to fetch');
  });
});
