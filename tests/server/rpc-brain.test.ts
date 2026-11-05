// The Brain over oRPC (server/api/brain.ts): a look inside its folder and a note saved there, asking it with
// nothing to ask refused in plain words, /stop and /resume with lists of the wrong kind still answering (/resume
// that nothing was stopped), its history cleared, the project at a glance, and its skills.
import fs from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';

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

describe('the Brain over oRPC', () => {
  it('saves a note in its notes/ folder and lists what is inside it', async () => {
    const { json } = await send('POST', '/api/brain/note', { name: 'plan.md', content: 'Ship it.' });
    expect(fs.readFileSync(String(json.file), 'utf8')).toBe('Ship it.');
    const info = (await send('GET', '/api/brain')).json;
    expect(info).toMatchObject({ project: { id: expect.any(String) }, files: expect.any(Number), summary: { from: expect.toBeOneOf(['description', 'PROJECT.md', 'README.md', null]) } });
    expect(info.entries).toContainEqual(expect.objectContaining({ name: 'notes', dir: true }));
    expect(await send('POST', '/api/brain/note', { name: 'x', content: 3 })).toEqual({ status: 400, json: { error: 'A note is text.' } });
  });

  it('refuses a question with nothing in it, in plain words', async () => {
    expect(await send('POST', '/api/brain/ask', { text: '   ' })).toEqual({ status: 400, json: { error: 'Type a message first.' } });
    expect(await send('POST', '/api/brain/ask', { text: 7 })).toEqual({ status: 400, json: { error: 'Type a message first.' } });
    expect(await send('POST', '/api/brain/ask', { text: 'hi', attachments: 'a.png' })).toEqual({ status: 400, json: { error: 'attachments must be a list.' } });
  });

  it('stops and resumes even when the lists it was sent are of the wrong kind', async () => {
    expect(await send('POST', '/api/brain/stop', { chats: 'not a list', teams: 5 })).toEqual({ status: 200, json: { stopped: [] } });
    expect(await send('POST', '/api/brain/resume', { chats: 'not a list' })).toEqual({ status: 400, json: { error: 'Nothing to resume.' } });
    expect(await send('POST', '/api/brain/steer')).toEqual({ status: 200, json: { ok: true } });
  });

  it('clears its history and shows the project at a glance', async () => {
    expect(await send('POST', '/api/brain/clear')).toEqual({ status: 200, json: { ok: true } });
    expect((await send('GET', '/api/brain/history')).json).toEqual([]);
    expect((await send('GET', '/api/brain/pulse')).json).toMatchObject({ project: expect.any(String), agents: expect.any(Number), approvals: expect.any(Number), questions: expect.any(Number) });
    expect(typeof (await send('GET', '/api/brain/snapshot')).json.text).toBe('string');
  });

  it('keeps the skills it uses, only names it can use', async () => {
    expect((await send('PUT', '/api/brain/skills', { skills: ['research', 'research', '../up'] })).json).toEqual({ skills: ['research'] });
    expect((await send('GET', '/api/brain/skills')).json).toEqual({ skills: ['research'] });
    expect(await send('PUT', '/api/brain/skills', { skills: 'research' })).toEqual({ status: 400, json: { error: 'skills must be a list.' } });
    expect((await send('PUT', '/api/brain/skills', {})).json).toEqual({ skills: [] });
  });
});
