// OpenUI's chat state talking to the dashboard: a send posts the message, then the run's live events
// stream in as AG-UI events.
import { describe, expect, it } from 'vitest';
import { EventType } from '@openuidev/react-headless';
import type { AGUIEvent, Message } from '@openuidev/react-headless';
import { dashboardLLM } from '../../web/chat/llm.ts';
import { userContent } from '../../web/chat/convert.ts';
import type { RunEvent, ServerEvent } from '../../shared/types.ts';

function fakeServer({ runId = 'r1', fail = '' } = {}) {
  const listeners = new Set<(ev: ServerEvent) => void>();
  const posts: { path: string; body: unknown }[] = [];
  const emit = (event: RunEvent, rid = runId, chatId = 'c1') => listeners.forEach((fn) => fn({ type: 'run', ts: 0, runId: rid, chatId, event }));
  return {
    posts,
    emit,
    deps: {
      onEvent: (fn: (ev: ServerEvent) => void) => (listeners.add(fn), () => listeners.delete(fn)),
      post: async <T,>(path: string, body: unknown): Promise<T> => {
        posts.push({ path, body });
        if (fail && path.endsWith('/messages')) throw new Error(fail);
        // the server announces the run before it answers
        if (path.endsWith('/messages')) emit({ kind: 'start', text: 'hi' });
        return { runId } as T;
      },
      checkEvery: 10,
    },
    listening: () => listeners.size,
  };
}

const msg = (text: string, attachments: string[] = []): Message => ({ id: 'u1', role: 'user', content: userContent(text, attachments) });

async function collect(it: AsyncIterable<AGUIEvent>, max = 50): Promise<AGUIEvent[]> {
  const out: AGUIEvent[] = [];
  for await (const e of it) if (out.push(e) >= max) break;
  return out;
}

describe('dashboardLLM()', () => {
  it('posts the message (text and files) and streams that run as AG-UI events', async () => {
    const s = fakeServer();
    const statuses: string[] = [];
    const llm = dashboardLLM('a1', { onStatus: (t) => statuses.push(t) }, s.deps);
    const res = await llm.send({ threadId: 'c1', messages: [msg('render it', ['/w/x.png'])], signal: new AbortController().signal });
    expect(res.ok).toBe(true);
    expect(s.posts[0]).toEqual({ path: '/agents/a1/chats/c1/messages', body: { text: 'render it', attachments: ['/w/x.png'] } });
    const events = collect(llm.streamProtocol.parse(res));
    s.emit({ kind: 'text', text: 'Rend' });
    s.emit({ kind: 'status', text: 'Using blender…' });
    s.emit({ kind: 'tool', id: 't1', name: 'blender', args: { code: 'x' } });
    // (another run in the same chat, e.g. before a reload: not this one)
    s.emit({ kind: 'text', text: 'NOT MINE' }, 'r-other');
    s.emit({ kind: 'tool_result', id: 't1', text: 'ok', images: ['/a.png'] });
    s.emit({ kind: 'done', text: '' });
    const got = await events;
    expect(got.map((e) => e.type)).toEqual([EventType.TEXT_MESSAGE_CONTENT, EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END, EventType.TOOL_CALL_RESULT]);
    expect(got[0]).toMatchObject({ delta: 'Rend' });
    expect(got[2]).toMatchObject({ toolCallId: 't1', delta: '{"code":"x"}' });
    expect(JSON.parse((got[4] as { content: string }).content)).toEqual({ text: 'ok', images: ['/a.png'] });
    expect(statuses).toEqual(['Writing…', 'Using blender…', 'Using blender…', 'Thinking…']);
    expect(s.listening()).toBe(0);
  });

  it('events from another chat are not this one', async () => {
    const s = fakeServer();
    const llm = dashboardLLM('a1', {}, s.deps);
    const res = await llm.send({ threadId: 'c1', messages: [msg('x')], signal: new AbortController().signal });
    const events = collect(llm.streamProtocol.parse(res));
    s.emit({ kind: 'text', text: 'elsewhere' }, 'r1', 'c2');
    s.emit({ kind: 'error', text: 'boom' });
    expect(await events).toEqual([]);
  });

  it('a message the server refuses ends with its reason', async () => {
    const s = fakeServer({ fail: 'This chat is already working on something.' });
    const failed: string[] = [];
    const llm = dashboardLLM('a1', { onSendFailed: (m) => failed.push(m) }, s.deps);
    const res = await llm.send({ threadId: 'c1', messages: [msg('x')], signal: new AbortController().signal });
    expect(res.ok).toBe(false);
    expect(await res.json()).toEqual({ error: 'This chat is already working on something.' });
    expect(failed).toEqual(['This chat is already working on something.']);
    expect(s.listening()).toBe(0);
  });

  it('Stop stops the run on the server and ends the stream', async () => {
    const s = fakeServer();
    const llm = dashboardLLM('a1', {}, s.deps);
    const ctl = new AbortController();
    const res = await llm.send({ threadId: 'c1', messages: [msg('x')], signal: ctl.signal });
    const events = collect(llm.streamProtocol.parse(res));
    ctl.abort();
    expect(await events).toEqual([]);
    expect(s.posts.at(-1)?.path).toBe('/agents/a1/chats/c1/stop');
  });

  it('ends when the server no longer runs it (the socket missed the end)', async () => {
    const s = fakeServer();
    let running = true;
    const llm = dashboardLLM('a1', { isRunning: () => running }, s.deps);
    const res = await llm.send({ threadId: 'c1', messages: [msg('x')], signal: new AbortController().signal });
    const events = collect(llm.streamProtocol.parse(res));
    s.emit({ kind: 'text', text: 'partial' });
    running = false;
    expect((await events).map((e) => e.type)).toEqual([EventType.TEXT_MESSAGE_CONTENT]);
  });
});
