// Steering an API-model agent (Eve): a message sent while it works joins the turn going on instead of
// stopping it. One that arrives while it writes its final answer misses that turn: Eve starts the next
// turn with it, and a new run follows that turn.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { chats, saveSettings, workflows } from '../../server/store.ts';
import { getThread, postUserMessage, steerTeam, teamState } from '../../server/teams.ts';
import { activeRuns, queueMessage, startRun, steerChat } from '../../server/engines/index.ts';
import { ADOPT_WAIT } from '../../server/engines/eve.ts';
import { readRun } from '../../server/eve/state.ts';
import { readExecution } from '../../server/execution.ts';
import type { ChatItem, Team } from '../../shared/types.ts';

// A fake model. Each request waits for the test; one asked to "write" sends the start of its answer first.
let server: http.Server;
interface Held {
  all: string;
  last: string;
  release: () => void;
  closed: boolean;
  done?: boolean;
}
const held: Held[] = [];
const seen: string[] = [];
let writeFirst = false;
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    let body = '';
    for await (const c of req) body += c;
    const j = JSON.parse(body) as { messages: { content: unknown }[] };
    const text = (c: unknown) => (typeof c === 'string' ? c : JSON.stringify(c));
    const all = j.messages
      .slice(1)
      .map((m) => text(m.content))
      .join('\n\n');
    const last = text(j.messages.at(-1)?.content);
    seen.push(all);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = (content: string) =>
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`);
    if (writeFirst) {
      writeFirst = false;
      delta('Here is the long one: ');
    }
    const h: Held = { all, last, release: () => {}, closed: false };
    await new Promise<void>((release) => {
      h.release = release;
      res.once('close', () => ((h.closed = true), release()));
      held.push(h);
    });
    h.done = true;
    if (h.closed) return;
    delta(`re: ${last.slice(-60)}`);
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  saveSettings({
    providers: {
      custom: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, label: 'Fake model' },
    },
  });
});
afterAll(() => {
  for (const h of held.splice(0)) h.release();
  return new Promise<void>((r) => server.close(() => r()));
});

const until = async (ok: () => boolean, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};
const agent = (name: string) => newAgent({ name, engine: 'eve', provider: 'custom', model: 'mock', toolGroups: [] });
const running = (chatId: string) => activeRuns().filter((r) => r.chatId === chatId);
const said = (items: ChatItem[]) =>
  items.flatMap((i) =>
    i.type === 'user' || i.type === 'steer' || i.type === 'assistant' || i.type === 'error'
      ? [`${i.type}: ${i.text}`]
      : [],
  );
// the next request the model has (not one Eve gave up on)
const next = async (has?: string) => {
  const open = (h: Held) => !h.closed && !h.done && (!has || h.all.includes(has));
  await until(() => held.some(open));
  return held.find(open)!;
};

describe('a message while an API-model agent works', () => {
  it('joins the turn going on: nothing stops, and the agent reads it before it answers', async () => {
    const a = agent('Joiner');
    const c = chats.create(a.id);
    queueMessage(a, c, 'the long job');
    await next('the long job');
    const [first] = running(c.id);
    const { runId } = await steerChat(a, c, 'also make it blue');
    // the same run carries on
    expect(runId).toBe(first!.id);
    expect(running(c.id).map((r) => r.id)).toEqual([first!.id]);
    // the model is asked again within the turn, with your message
    const again = await next('also make it blue');
    expect(again.all).toContain('the long job');
    again.release();
    await until(() => !running(c.id).length);
    const items = chats.get(a.id, c.id)!.items;
    expect(said(items)).toEqual(['user: the long job', 'steer: also make it blue', 'assistant: re: also make it blue']);
    expect(items.some((i) => i.type === 'error')).toBe(false);
    // one turn, finished, with your message taken into it
    const run = readRun(first!.id)!;
    expect(run.status).toBe('completed');
    expect(run.joinedDeliveries).toContain(run.steers![0]!.deliveryId);
    expect(readExecution().runs.find((r) => r.id === first!.id)).toMatchObject({ status: 'completed' });
  }, 40000);

  it('one that comes while it writes its final answer starts the next turn, which a new run follows', async () => {
    const a = agent('Late');
    const c = chats.create(a.id);
    writeFirst = true;
    queueMessage(a, c, 'the long job');
    const writing = await next('the long job');
    const [first] = running(c.id);
    const { runId } = await steerChat(a, c, 'and a short summary');
    expect(runId).toBe(first!.id);
    // it finishes its answer: your message missed that turn
    writing.release();
    const second = await next('and a short summary');
    await until(() => running(c.id).length === 1 && running(c.id)[0]!.id !== first!.id);
    const followed = running(c.id)[0]!.id;
    expect(second.all).toContain('Here is the long one: re: the long job');
    second.release();
    await until(() => !running(c.id).length);
    // your message moved to the turn it started, as that turn's own message
    expect(said(chats.get(a.id, c.id)!.items)).toEqual([
      'user: the long job',
      'assistant: Here is the long one: re: the long job',
      'user: and a short summary',
      'assistant: re: and a short summary',
    ]);
    expect(readRun(first!.id)!.steers![0]).toMatchObject({ adoptedBy: followed });
    expect(readRun(followed)).toMatchObject({
      status: 'completed',
      adopted: true,
      deliveryId: readRun(first!.id)!.steers![0]!.deliveryId,
    });
  }, 40000);

  it('a run following a turn Eve never starts gives up instead of waiting forever', async () => {
    const a = agent('Ghost');
    const c = chats.create(a.id);
    queueMessage(a, c, 'hello');
    (await next('hello')).release();
    await until(() => !running(c.id).length);
    const bindingId = readRun(readExecution().runs.find((r) => r.chatId === c.id)!.id)!.bindingId;
    const wait = ADOPT_WAIT.ms;
    ADOPT_WAIT.ms = 300;
    try {
      const { promise } = startRun(a, c, 'a message Eve never had', {
        adopt: { bindingId, deliveryId: 'never-delivered', steers: [] },
      });
      await promise;
      await until(() => !running(c.id).length);
    } finally {
      ADOPT_WAIT.ms = wait;
    }
    expect(said(chats.get(a.id, c.id)!.items).at(-1)).toBe(
      'error: Eve did not start the turn with your message. Send it again.',
    );
  }, 40000);

  it('with nothing going, it is an ordinary message', async () => {
    const a = agent('Idle');
    const c = chats.create(a.id);
    const { runId } = await steerChat(a, c, 'hello');
    expect(typeof runId).toBe('string');
    (await next('hello')).release();
    await until(() => !running(c.id).length);
    expect(said(chats.get(a.id, c.id)!.items)).toEqual(['user: hello', 'assistant: re: hello']);
  }, 40000);
});

describe('a message while a team works', () => {
  const thread = (team: Team, names: Record<string, string>) =>
    getThread(team.id).messages.map((m) => `${names[m.from] || m.from}: ${m.text.trim()}`);

  it('whoever is working takes it into their turn: nobody stops, and one reply answers both', async () => {
    const worker = agent('Worker');
    const team = workflows.save({
      name: 'Join',
      description: 'x',
      members: [worker.id],
      lead: worker.id,
      steps: [],
    } as Partial<Team>);
    await postUserMessage(team.id, 'do the long job');
    await next('do the long job');
    const msg = await steerTeam(team.id, 'also make it blue');
    expect(msg.text).toBe('also make it blue');
    // the same turn is asked again, with your message
    const again = await next('also make it blue');
    again.release();
    await until(() => !teamState(team.id).working.length && getThread(team.id).messages.length >= 3);
    await new Promise((r) => setTimeout(r, 200));
    const names = { [worker.id]: 'Worker' };
    expect(thread(team, names)).toEqual([
      'user: do the long job',
      'user: also make it blue',
      expect.stringMatching(/^Worker: re: [\s\S]*You \(the user\): also make it blue$/),
    ]);
    // its work shows your message where it came in
    const reply = getThread(team.id).messages[2]!;
    const work = chats.get(worker.id, reply.turn!.chatId)!.items.slice(reply.turn!.from, reply.turn!.to);
    expect(work.find((i) => i.type === 'steer')).toMatchObject({ teamMessageId: msg.id });
    expect(work.some((i) => i.type === 'error')).toBe(false);
  }, 40000);

  it('one that comes while it writes its final reply: it takes it next, as an ordinary turn', async () => {
    const worker = agent('Writer');
    const team = workflows.save({
      name: 'Late join',
      description: 'x',
      members: [worker.id],
      lead: worker.id,
      steps: [],
    } as Partial<Team>);
    writeFirst = true;
    await postUserMessage(team.id, 'write the long one');
    const writing = await next('write the long one');
    await steerTeam(team.id, 'and a short summary');
    writing.release();
    // its next turn has your message (and what it wrote before)
    const second = await next('and a short summary');
    expect(second.last).toContain('Addressed to you:');
    expect(second.all).toContain('and a short summary');
    second.release();
    await until(() => !teamState(team.id).working.length && getThread(team.id).messages.length >= 4);
    const names = { [worker.id]: 'Writer' };
    // (one reply for each turn: the one it was writing, then the one with your message)
    expect(thread(team, names)).toEqual([
      'user: write the long one',
      'user: and a short summary',
      expect.stringMatching(/^Writer: Here is the long one: re: /),
      expect.stringMatching(/^Writer: re: /),
    ]);
    // the turn that missed it doesn't show it as read: it shows in the turn that took it
    const [missed, took] = getThread(team.id).messages.slice(2);
    const work = (m: typeof missed) => chats.get(worker.id, m!.turn!.chatId)!.items.slice(m!.turn!.from, m!.turn!.to);
    expect(work(missed).some((i) => i.type === 'steer')).toBe(false);
    expect(said(work(took))[0]).toMatch(/and a short summary/);
  }, 40000);
});
