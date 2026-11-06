// A team's chat over oRPC (server/api/teams.ts): the thread, the held queue, stop and clear, the / commands that
// answer without a run, a message of the wrong kind refused in plain words, and a team that is gone named.
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';
import { newAgent } from '../../server/library.ts';
import { workflows } from '../../server/store.ts';
import type { Team } from '../../shared/types.ts';

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
const team = () => {
  const lead = newAgent({ name: 'Lead' });
  return workflows.save({ name: 'Bakers', members: [lead.id], lead: lead.id, steps: [] } as Partial<Team>);
};

describe('team chats over oRPC', () => {
  it('show the thread with the team, its goal and the other teams', async () => {
    const t = team();
    expect((await send('GET', `/api/teams/${t.id}/chat`)).json).toMatchObject({ team: { id: t.id, name: 'Bakers' }, messages: [], goal: null, others: expect.any(Array) });
    expect(await send('GET', '/api/teams/nobody/chat')).toEqual({ status: 404, json: { error: 'That team is unavailable.' } });
  });

  it('refuse a message of the wrong kind in plain words', async () => {
    const t = team();
    expect(await send('POST', `/api/teams/${t.id}/messages`, { text: 7 })).toEqual({ status: 400, json: { error: 'Type a message first.' } });
    expect(await send('POST', `/api/teams/${t.id}/messages`, { text: 'hi', replyTo: 3 })).toEqual({ status: 400, json: { error: 'replyTo must name a message.' } });
    expect(await send('POST', `/api/teams/${t.id}/goal`, {})).toEqual({ status: 400, json: { error: 'Say what done looks like.' } });
    expect(await send('POST', `/api/teams/${t.id}/queue/order`, { ids: 'a' })).toEqual({ status: 400, json: { error: 'ids must be a list.' } });
    expect(await send('POST', `/api/teams/${t.id}/resend`)).toEqual({ status: 400, json: { error: 'Nothing to send again yet.' } });
  });

  it('answer the held queue, a loop, stop and clear when nobody works', async () => {
    const t = team();
    const at = `/api/teams/${t.id}`;
    expect((await send('POST', `${at}/queue/order`, { ids: [] })).json).toEqual({ held: [] });
    expect((await send('PUT', `${at}/queue/q1`, { text: 'later' })).json).toEqual({ queued: null });
    expect((await send('DELETE', `${at}/queue/q1`)).json).toEqual({ unqueued: [] });
    expect((await send('DELETE', `${at}/loop`)).json).toEqual({ ok: false });
    expect((await send('POST', `${at}/stop`)).json).toMatchObject({ unqueued: [] });
    expect(await send('POST', `${at}/clear`)).toEqual({ status: 200, json: { ok: true } });
    expect(await send('POST', '/api/teams/nobody/clear')).toEqual({ status: 404, json: { error: 'That team is unavailable.' } });
  });
});
