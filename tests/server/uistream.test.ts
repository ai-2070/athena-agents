// A run as a Vercel AI SDK UI message stream, read back with the AI SDK itself (its HTTP transport and
// stream reader): text as written, tool calls with input and result, status lines, a replay.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DefaultChatTransport, readUIMessageStream } from 'ai';
import type { UIMessage, UIMessageChunk } from 'ai';
import { emit } from '../../server/store.ts';
import { TurnChunks, streamRun } from '../../server/uistream.ts';
import type { ChatItem, RunEvent } from '../../shared/types.ts';

let server: http.Server;
let base = '';
// what the next request streams: the items already there (a replay)
let replayItems: ChatItem[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const runId = new URL(req.url!, 'http://x').searchParams.get('run') || 'r1';
    void streamRun(res, { chatId: 'c1', runId, items: replayItems, keepAliveMs: 20 });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const run = (event: RunEvent, runId = 'r1', chatId = 'c1') => emit('run', { runId, agentId: 'a1', chatId, event });
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

async function read(runId = 'r1', drive: () => Promise<void>): Promise<{ last: UIMessage; data: unknown[] }> {
  const data: unknown[] = [];
  const transport = new DefaultChatTransport({ api: `${base}/?run=${runId}`, prepareReconnectToStreamRequest: () => ({ api: `${base}/?run=${runId}` }) });
  const stream = (await transport.reconnectToStream({ chatId: 'c1' }))!;
  // (transient data parts, the status lines, come through the stream but don't stay in the message)
  const [a, b] = stream.tee();
  void (async () => {
    for await (const c of b as unknown as AsyncIterable<UIMessageChunk>) if (c.type.startsWith('data-')) data.push(c);
  })();
  const reading = (async () => {
    let last: UIMessage | null = null;
    for await (const m of readUIMessageStream({ stream: a })) last = structuredClone(m);
    return last!;
  })();
  await tick(30);
  await drive();
  return { last: await reading, data };
}

describe('streamRun()', () => {
  it('a live run: text, a tool call with its result, a status line, then the end', async () => {
    replayItems = [];
    const { last, data } = await read('r1', async () => {
      run({ kind: 'text', text: 'Rendering ' });
      run({ kind: 'text', text: 'now.' });
      run({ kind: 'status', text: 'Using blender…' });
      run({ kind: 'tool', id: 't1', name: 'blender_run_python', args: { code: 'x' } });
      // another run, another chat: not this one
      run({ kind: 'text', text: 'NOT MINE' }, 'r-other');
      run({ kind: 'text', text: 'NOT MINE' }, 'r1', 'c2');
      await tick(40);
      run({ kind: 'tool_result', id: 't1', text: 'done', images: ['/a.png'] });
      run({ kind: 'tool', id: 't2', name: 'ffmpeg', args: {} });
      run({ kind: 'tool_result', id: 't2', text: 'boom', isError: true });
      run({ kind: 'text', text: 'Saved.' });
      run({ kind: 'done', text: '' });
    });
    expect(last.role).toBe('assistant');
    expect(last.id).toBe('run-r1');
    const parts = last.parts.filter((p) => p.type !== 'step-start');
    expect(parts.map((p) => p.type)).toEqual(['text', 'dynamic-tool', 'dynamic-tool', 'text']);
    expect(parts[0]).toMatchObject({ type: 'text', text: 'Rendering now.', state: 'done' });
    expect(parts[1]).toMatchObject({ toolName: 'blender_run_python', state: 'output-available', input: { code: 'x' }, output: { text: 'done', images: ['/a.png'] } });
    expect(parts[2]).toMatchObject({ toolName: 'ffmpeg', state: 'output-error', errorText: 'boom' });
    expect(parts[3]).toMatchObject({ text: 'Saved.' });
    expect(data).toEqual([expect.objectContaining({ type: 'data-status', data: { text: 'Using blender…' }, transient: true })]);
  });

  it('opening while it runs: the turn so far first, then the rest', async () => {
    replayItems = [
      { type: 'user', text: 'go' },
      { type: 'assistant', text: 'Reading the brief. ' },
      { type: 'tool', id: 'r', name: 'read_file', args: { path: 'brief.md' }, result: 'the brief', status: 'done' },
      { type: 'tool', id: 'w', name: 'write_file', args: { path: 'out.md' }, result: null, status: 'running' },
    ];
    const { last } = await read('r2', async () => {
      run({ kind: 'tool_result', id: 'w', text: 'written' }, 'r2');
      run({ kind: 'text', text: 'All done.' }, 'r2');
      run({ kind: 'error', text: 'Stopped.' }, 'r2');
    });
    const parts = last.parts.filter((p) => p.type !== 'step-start');
    expect(parts.map((p) => (p.type === 'text' ? p.text : (p as { toolName: string }).toolName))).toEqual(['Reading the brief. ', 'read_file', 'write_file', 'All done.']);
    expect(parts[1]).toMatchObject({ state: 'output-available', output: { text: 'the brief', images: [] } });
    expect(parts[2]).toMatchObject({ state: 'output-available', output: { text: 'written', images: [] } });
  });
});

describe('TurnChunks', () => {
  it('opens and closes text around tool calls, and finishes once', () => {
    const out: UIMessageChunk[] = [];
    const w = new TurnChunks((c) => out.push(c));
    w.start('m');
    w.text('a');
    w.tool('t', 'x', null);
    w.text('b');
    w.finish();
    w.finish();
    expect(out.map((c) => c.type)).toEqual(['start', 'start-step', 'text-start', 'text-delta', 'text-end', 'tool-input-available', 'text-start', 'text-delta', 'text-end', 'finish-step', 'finish']);
    expect(out[5]).toMatchObject({ input: {}, dynamic: true });
  });
});
