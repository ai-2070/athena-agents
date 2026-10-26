// /queue: a message typed while an agent (or a team) works waits, then goes once it is done.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { chats, saveSettings, workflows } from '../../server/store.ts';
import { activeRuns, queueMessage, queuedMessages, stopChat, unqueue } from '../../server/engines/index.ts';
import { getThread, queueUserMessage, stopTeam, teamState, unqueueTeam } from '../../server/teams.ts';
import { queuedText } from '../../shared/queue.ts';
import type { Team } from '../../shared/types.ts';

// A fake model: each request waits until the test releases it, then answers "re: <last message>".
let server: http.Server;
const waiting: { last: string; release: () => void }[] = [];
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    let body = '';
    for await (const c of req) body += c;
    const j = JSON.parse(body) as { messages: { content: string }[] };
    const last = String(j.messages.at(-1)?.content || '');
    await new Promise<void>((release) => waiting.push({ last, release }));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `re: ${last.slice(-40)}` } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  saveSettings({ providers: { custom: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, label: 'Fake model' } } });
});
afterAll(() => {
  for (const w of waiting.splice(0)) w.release();
  return new Promise<void>((r) => server.close(() => r()));
});

const until = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};
// let the model answer the next request; returns the message it was answering
const release = async () => {
  await until(() => waiting.length > 0);
  const w = waiting.shift()!;
  w.release();
  return w.last;
};
const agent = (name: string) => newAgent({ name, engine: 'openai', provider: 'custom', model: 'mock', toolGroups: [] });
const userTexts = (agentId: string, chatId: string) => (chats.get(agentId, chatId)?.items || []).filter((i) => i.type === 'user').map((i) => i.text);
const running = (chatId: string) => activeRuns().some((r) => r.chatId === chatId);

describe('queuedText()', () => {
  it('reads "/queue <message>" and nothing else', () => {
    expect(queuedText('/queue then write the tests')).toBe('then write the tests');
    expect(queuedText('  /QUEUE  two\nlines ')).toBe('two\nlines');
    expect(queuedText('/queue')).toBe('');
    expect(queuedText('/queued up')).toBeNull();
    expect(queuedText('please /queue this')).toBeNull();
  });
});

describe('/queue in an agent chat', () => {
  it('goes now when the agent is free', async () => {
    const a = agent('Free');
    const c = chats.create(a.id);
    const r = queueMessage(a, c, 'hello');
    expect('runId' in r).toBe(true);
    await release();
    await until(() => !running(c.id));
    expect(userTexts(a.id, c.id)).toEqual(['hello']);
    expect(queuedMessages(c.id)).toEqual([]);
  });

  it('waits while the agent works, then sends each one in order as its own message', async () => {
    const a = agent('Busy');
    const c = chats.create(a.id);
    queueMessage(a, c, 'first');
    await until(() => waiting.length > 0);
    const second = queueMessage(a, c, 'second');
    const third = queueMessage(a, c, 'third', ['C:/files/notes.txt']);
    expect('queued' in second && 'queued' in third).toBe(true);
    expect(queuedMessages(c.id).map((q) => q.text)).toEqual(['second', 'third']);
    expect(userTexts(a.id, c.id)).toEqual(['first']);

    expect(await release()).toContain('first');
    await until(() => userTexts(a.id, c.id).length === 2);
    expect(queuedMessages(c.id).map((q) => q.text)).toEqual(['third']);
    expect(await release()).toContain('second');
    await until(() => userTexts(a.id, c.id).length === 3);
    const sent = chats.get(a.id, c.id)!.items.findLast((i) => i.type === 'user');
    expect(sent?.type === 'user' && sent.attachments).toEqual(['C:/files/notes.txt']);
    await release();
    await until(() => !running(c.id));
    expect(queuedMessages(c.id)).toEqual([]);
  });

  it('takes one back, and Stop takes back the rest instead of sending them', async () => {
    const a = agent('Stopper');
    const c = chats.create(a.id);
    queueMessage(a, c, 'work');
    await until(() => waiting.length > 0);
    const keep = queueMessage(a, c, 'keep');
    const drop = queueMessage(a, c, 'drop');
    if (!('queued' in drop) || !('queued' in keep)) throw new Error('should wait');
    expect(unqueue(c.id, drop.queued.id).map((q) => q.text)).toEqual(['drop']);
    expect(queuedMessages(c.id).map((q) => q.text)).toEqual(['keep']);
    // what the chat's Stop button does
    expect(unqueue(c.id).map((q) => q.text)).toEqual(['keep']);
    stopChat(c.id);
    await until(() => !running(c.id));
    await new Promise((r) => setTimeout(r, 50));
    expect(running(c.id)).toBe(false);
    expect(userTexts(a.id, c.id)).toEqual(['work']);
    waiting.splice(0).forEach((w) => w.release());
  });

  it('a run stopped from elsewhere drops what was queued behind it', async () => {
    const a = agent('Elsewhere');
    const c = chats.create(a.id);
    queueMessage(a, c, 'work');
    await until(() => waiting.length > 0);
    queueMessage(a, c, 'later');
    stopChat(c.id);
    await until(() => !running(c.id));
    expect(queuedMessages(c.id)).toEqual([]);
    expect(userTexts(a.id, c.id)).toEqual(['work']);
    waiting.splice(0).forEach((w) => w.release());
  });
});

describe('/queue in a team chat', () => {
  const team = () => {
    const solo = agent('Solo');
    return workflows.save({ name: `Q ${Math.random()}`, description: '', members: [solo.id], lead: solo.id, steps: [] } as Partial<Team>);
  };

  it('posts now when nobody is working, else once the team is done', async () => {
    const t = team();
    const now = await queueUserMessage(t.id, 'start');
    expect('message' in now).toBe(true);
    await until(() => teamState(t.id).working.length > 0);
    const later = await queueUserMessage(t.id, 'and then this');
    expect('queued' in later).toBe(true);
    expect(teamState(t.id).held?.map((q) => q.text)).toEqual(['and then this']);
    expect(getThread(t.id).messages.filter((m) => m.from === 'user').map((m) => m.text)).toEqual(['start']);

    await release();
    await until(() => getThread(t.id).messages.filter((m) => m.from === 'user').length === 2);
    expect(teamState(t.id).held).toEqual([]);
    await release();
    await until(() => !teamState(t.id).working.length && !teamState(t.id).queued.length);
    expect(getThread(t.id).messages.map((m) => m.from === 'user' ? `you: ${m.text}` : 'agent')).toEqual(['you: start', 'agent', 'you: and then this', 'agent']);
  });

  it('Stop hands the held messages back and posts none of them', async () => {
    const t = team();
    await queueUserMessage(t.id, 'start');
    await until(() => teamState(t.id).working.length > 0);
    await queueUserMessage(t.id, 'one');
    await queueUserMessage(t.id, 'two');
    expect(unqueueTeam(t.id).map((q) => q.text)).toEqual(['one', 'two']);
    stopTeam(t.id);
    waiting.splice(0).forEach((w) => w.release());
    await until(() => !teamState(t.id).working.length);
    await new Promise((r) => setTimeout(r, 50));
    expect(getThread(t.id).messages.filter((m) => m.from === 'user').map((m) => m.text)).toEqual(['start']);
  });

  it('refuses an empty /queue', async () => {
    const t = team();
    await expect(queueUserMessage(t.id, '  ')).rejects.toThrow('Write the message after /queue.');
  });
});
