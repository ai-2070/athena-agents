// Gateways and the Outbox over oRPC (server/api/gateways.ts, outbox.ts): a body reaches the gateway code as it came
// (a body that isn't a JSON object refused as before, none passed as {}), and the Outbox's own routes: a draft,
// rejecting and removing it, a missing post, and the old test route saying what to do instead.
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';
import type { OutboxPost } from '../../shared/types.ts';

let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await handleRpc(req, res, '/api'))) res.writeHead(404).end();
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const send = async <T = Record<string, unknown>>(method: string, p: string, body?: unknown, raw?: string) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: r.status, json: (await r.json()) as T };
};

describe('gateways over oRPC', () => {
  it('list the connections and the removed ones', async () => {
    expect((await send('GET', '/api/gateways')).json).toEqual({ instances: [], health: expect.any(Array) });
    expect((await send('GET', '/api/gateways/retired')).json).toEqual({ instances: [] });
  });

  it("refuse a body that isn't a JSON object, as the old routes did", async () => {
    expect(await send('POST', '/api/gateways', undefined, '"telegram"')).toEqual({ status: 400, json: { error: 'Body must be a JSON object' } });
    expect(await send('POST', '/api/gateways', undefined, 'null')).toEqual({ status: 400, json: { error: 'Body must be a JSON object' } });
  });

  it('pass the body to the gateway code, which checks it', async () => {
    const refused = await send('POST', '/api/gateways', { platform: 'telegram', name: 'Bot', unexpected: true });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(typeof refused.json.error).toBe('string');
    expect((await send('PUT', '/api/gateways/nobody/credentials', { botToken: 'x' })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('the Outbox over oRPC', () => {
  it('draft a post, list it, reject it and remove it', async () => {
    const draft = (await send<OutboxPost>('POST', '/api/outbox', { platform: 'telegram', text: 'Hello, world' })).json;
    expect(draft).toMatchObject({ platform: 'telegram', status: 'pending', parts: ['Hello, world'] });
    expect(((await send<OutboxPost[]>('GET', '/api/outbox')).json).some((p) => p.id === draft.id)).toBe(true);
    expect((await send<OutboxPost>('POST', `/api/outbox/${draft.id}/reject`, { reason: 'Not now' })).json).toMatchObject({ status: 'rejected' });
    expect(await send('DELETE', `/api/outbox/${draft.id}`)).toEqual({ status: 200, json: { ok: true } });
    expect(await send('POST', `/api/outbox/${draft.id}/gateway-finish`, {})).toEqual({ status: 404, json: { error: 'That post is unavailable.' } });
  });

  it('refuse an approval of the wrong kind, and say what to do instead of the old test route', async () => {
    expect(await send('POST', '/api/outbox/p1/approve', { gatewayApproval: 'yes' })).toEqual({ status: 400, json: { error: 'Review the gateway message again before approving it.' } });
    const old = await send('POST', '/api/social/test', { platform: 'telegram' });
    expect(old.status).toBe(400);
    expect(String(old.json.error)).toContain('Old global tokens');
  });
});
