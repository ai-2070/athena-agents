// The chat views' streams over oRPC (server/api/agents.ts, brain.ts), read the way the page reads them: an oRPC
// client, its events turned back into the AI SDK's chunks. A message's run as it goes, picking up a run (nothing
// when none runs), a reader that goes away no longer listening, the Brain's answer, and refusals before a stream
// starts in plain words.
import http from 'node:http';
import type net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createORPCClient, eventIteratorToUnproxiedDataStream } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { readUIMessageStream } from 'ai';
import type { UIMessage } from 'ai';
import { contract } from '../../shared/api/index.ts';
import { handleRpc } from '../../server/rpc.ts';
import * as engines from '../../server/engines/index.ts';
import * as overseer from '../../server/overseer.ts';
import { newAgent } from '../../server/library.ts';
import { bus, chats, emit } from '../../server/store.ts';
import type { RunEvent, UIStream } from '../../shared/types.ts';

let rpc: ContractRouterClient<typeof contract>;
const server = http.createServer(async (req, res) => {
  if (!(await handleRpc(req, res, '/api'))) res.writeHead(404).end();
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  rpc = createORPCClient(new OpenAPILink(contract, { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/api` }));
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => vi.restoreAllMocks());

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const run = (chatId: string, runId: string, event: RunEvent) => emit('run', { runId, agentId: 'a', chatId, event });
const listening = () => bus.listenerCount('event');
/** A refusal as the page's client reads it (web/client/rpc.ts): its status, and the server's words. */
const refused = (call: Promise<unknown>) =>
  call.then(
    () => null,
    (e: { status?: number; data?: { body?: { error?: string } } }) => ({ status: e.status, error: e.data?.body?.error }),
  );

/** Reads a stream to its end, as the AI SDK does: the message as it ends up. */
async function readAll(it: UIStream): Promise<UIMessage> {
  let last: UIMessage | null = null;
  for await (const m of readUIMessageStream({ stream: eventIteratorToUnproxiedDataStream(it) })) last = structuredClone(m);
  return last!;
}
const shown = (m: UIMessage) => m.parts.flatMap((p) => (p.type === 'text' ? [p.text] : p.type === 'dynamic-tool' ? [`[${p.toolName}]`] : []));

/** A run that the engines say goes on (no engine needed): its id, and its chat. */
function fakeRun(runId: string) {
  const a = newAgent({ name: 'Scout' });
  const c = chats.create(a.id);
  const started = vi.spyOn(engines, 'startRun').mockReturnValue({ runId, promise: Promise.resolve(''), signal: new AbortController().signal });
  vi.spyOn(engines, 'runActive').mockReturnValue(true);
  return { a, c, started };
}

describe('an agent chat’s stream over oRPC', () => {
  it('sends the message and streams its run: text, a tool call with its result, then the end', async () => {
    const { a, c, started } = fakeRun('r-send');
    const it = await rpc.agents.chats.stream({ id: a.id, chatId: c.id, text: '  Render it  ' });
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ id: a.id }), expect.objectContaining({ id: c.id }), 'Render it', { attachments: [] });
    const reading = readAll(it);
    await tick();
    run(c.id, 'r-send', { kind: 'text', text: 'Rendering. ' });
    run(c.id, 'r-send', { kind: 'tool', id: 't1', name: 'blender', args: { x: 1 } });
    run(c.id, 'r-send', { kind: 'tool_result', id: 't1', text: 'ok', images: [] });
    run(c.id, 'r-send', { kind: 'text', text: 'Done.' });
    run(c.id, 'r-send', { kind: 'done', text: '' });
    const m = await reading;
    expect(m.id).toBe('run-r-send');
    expect(shown(m)).toEqual(['Rendering. ', '[blender]', 'Done.']);
  });

  it('refuses before streaming, in plain words: nothing typed, an agent or chat that isn’t there', async () => {
    const a = newAgent({ name: 'Scout' });
    const c = chats.create(a.id);
    expect(await refused(rpc.agents.chats.stream({ id: a.id, chatId: c.id, text: '  ' }))).toEqual({ status: 400, error: 'Type a message first.' });
    expect(await refused(rpc.agents.chats.stream({ id: 'nobody', chatId: c.id, text: 'hi' }))).toEqual({ status: 404, error: 'That agent is unavailable.' });
    expect(await refused(rpc.agents.chats.stream({ id: a.id, chatId: 'gone', text: 'hi' }))).toEqual({ status: 404, error: 'That chat is unavailable.' });
  });

  it('picks up the run going in a chat (the turn so far, then the rest), and is nothing when none runs', async () => {
    const a = newAgent({ name: 'Scout' });
    const c = chats.create(a.id);
    expect(await rpc.agents.chats.reconnect({ id: a.id, chatId: c.id })).toBeNull();
    vi.spyOn(engines, 'chatRunId').mockReturnValue('r-again');
    vi.spyOn(engines, 'liveChat').mockReturnValue({ ...c, items: [{ type: 'user', text: 'go' }, { type: 'assistant', text: 'So far. ' }] });
    const it = await rpc.agents.chats.reconnect({ id: a.id, chatId: c.id });
    const reading = readAll(it!);
    await tick();
    run(c.id, 'r-again', { kind: 'text', text: 'The rest.' });
    run(c.id, 'r-again', { kind: 'done', text: '' });
    expect(shown(await reading)).toEqual(['So far. The rest.']);
  });

  it('a steered message waits for the run before it, then shows all its new run said, even before it listened', async () => {
    const a = newAgent({ name: 'Scout' });
    const c = chats.create(a.id);
    vi.spyOn(engines, 'runActive').mockReturnValue(true);
    let start: (runId: string) => void = () => {};
    vi.spyOn(engines, 'steerChat').mockResolvedValue({ runId: new Promise<string | null>((r) => (start = r)) });
    const live = vi.spyOn(engines, 'liveChat').mockReturnValue(null);
    const it = await rpc.agents.chats.stream({ id: a.id, chatId: c.id, text: 'New plan', steer: true });
    const reading = readAll(it);
    await tick();
    // the new run starts and speaks in the moment before the stream hears its id
    run(c.id, 'r-next', { kind: 'text', text: 'On the new plan. ' });
    live.mockReturnValue({ ...c, items: [{ type: 'user', text: 'New plan' }, { type: 'assistant', text: 'On the new plan. ' }] });
    start('r-next');
    await tick();
    run(c.id, 'r-next', { kind: 'text', text: 'Done.' });
    run(c.id, 'r-next', { kind: 'done', text: '' });
    expect(shown(await reading)).toEqual(['On the new plan. Done.']);
  });

  it('a message that joined the turn going on doesn’t replay that turn (the view shows it already)', async () => {
    const a = newAgent({ name: 'Scout' });
    const c = chats.create(a.id);
    vi.spyOn(engines, 'runActive').mockReturnValue(true);
    vi.spyOn(engines, 'steerChat').mockResolvedValue({ runId: 'r-join', steerId: 's1' });
    vi.spyOn(engines, 'liveChat').mockReturnValue({ ...c, items: [{ type: 'user', text: 'go' }, { type: 'assistant', text: 'Shown already. ' }] });
    const it = await rpc.agents.chats.stream({ id: a.id, chatId: c.id, text: 'Also this', steer: true });
    const reading = readAll(it);
    await tick();
    run(c.id, 'r-join', { kind: 'text', text: 'And this too.' });
    run(c.id, 'r-join', { kind: 'done', text: '' });
    expect(shown(await reading)).toEqual(['And this too.']);
  });

  it('refuses attachments that aren’t files in plain words', async () => {
    const a = newAgent({ name: 'Scout' });
    const c = chats.create(a.id);
    expect(await refused(rpc.agents.chats.stream({ id: a.id, chatId: c.id, text: 'hi', attachments: [1 as unknown as string] }))).toEqual({ status: 400, error: 'Each attachment is a file of the project.' });
  });

  it('stops listening when the page stops reading (the run goes on)', async () => {
    const { a, c } = fakeRun('r-gone');
    const before = listening();
    const stop = new AbortController();
    const it = await rpc.agents.chats.stream({ id: a.id, chatId: c.id, text: 'go' }, { signal: stop.signal });
    const reading = readAll(it).catch(() => null);
    await tick();
    expect(listening()).toBe(before + 1);
    stop.abort();
    await reading;
    await vi.waitFor(() => expect(listening()).toBe(before));
  });
});

describe('the Brain’s streamed answer over oRPC', () => {
  it('streams the answer as it is written, without its actions, then the whole answer', async () => {
    const asked = vi.spyOn(overseer, 'ask').mockImplementation(async (_text, opts = {}) => {
      opts.onPart?.({ kind: 'text', text: 'On it.\n```actions\n[]\n```' });
      return { answer: 'On it.', done: [], delegate: null } as unknown as Awaited<ReturnType<typeof overseer.ask>>;
    });
    const m = await readAll(await rpc.brain.stream({ text: 'Plan the week', project: null, goal: true }));
    expect(asked).toHaveBeenCalledWith('Plan the week', expect.objectContaining({ project: null, attachments: [], goal: true }));
    expect(shown(m)).toEqual(['On it.\n']);
    expect(m.parts.find((p) => p.type === 'data-answer')).toMatchObject({ data: { answer: 'On it.' } });
  });

  it('refuses before the stream starts, in plain words: nothing to ask, a project that isn’t an id', async () => {
    expect(await refused(rpc.brain.stream({ text: '' }))).toEqual({ status: 400, error: 'Type a message first.' });
    expect(await refused(rpc.brain.stream({ text: 'hi', project: 7 as unknown as string }))).toEqual({ status: 400, error: 'project must be the id of a project.' });
    expect(await refused(rpc.brain.stream({ text: 'hi', attachments: [{}] as unknown as string[] }))).toEqual({ status: 400, error: 'Each attachment is a file of the project.' });
  });
});

describe('a stream’s answer', () => {
  it('asks a proxy not to hold it back, and isn’t cached', async () => {
    vi.spyOn(overseer, 'ask').mockResolvedValue({ answer: 'Hi.', done: [], delegate: null } as unknown as Awaited<ReturnType<typeof overseer.ask>>);
    const port = (server.address() as net.AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/brain/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi' }) });
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('cache-control')).toBe('no-store');
    await res.text();
    // (a plain JSON answer isn't a stream)
    const plain = await fetch(`http://127.0.0.1:${port}/api/brain/skills`);
    expect(plain.headers.get('x-accel-buffering')).toBeNull();
    await plain.text();
  });
});
