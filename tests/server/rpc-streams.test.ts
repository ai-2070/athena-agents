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

  it('refuses nothing to ask before the stream starts', async () => {
    expect(await refused(rpc.brain.stream({ text: '' }))).toEqual({ status: 400, error: 'Type a message first.' });
  });
});
