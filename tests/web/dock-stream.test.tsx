// The Brain chat with the Vercel AI SDK: the Brain's answer streams in as it is written (never its
// actions block), the files it reads show as tool calls, and the whole answer finishes the message.
import { act } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { state } from '../../web/core.ts';
import { brainProgress, initDock } from '../../web/dock.ts';
import type { AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function uiStream() {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  return {
    response: () => new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } }),
    push: (c: UIMessageChunk) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`)),
    end: () => (ctl.enqueue(enc.encode('data: [DONE]\n\n')), ctl.close()),
  };
}
let brain: ReturnType<typeof uiStream> | null = null;
let asked: Record<string, unknown> | null = null;
const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));

beforeAll(() => {
  document.body.append(Object.assign(document.createElement('div'), { id: 'toasts' }));
  state.data = { runs: [], approvals: [], agents: [], project: { id: 'p1', name: 'P' }, settings: { brain: { provider: 'claude', model: 'haiku' } } } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url === '/api/brain/stream') {
      asked = JSON.parse(String(init.body));
      return (brain = uiStream()).response();
    }
    if (url === '/api/brain/history') return json([]);
    if (url === '/api/workflows') return json([]);
    return json({});
  });
  initDock();
});
afterAll(() => vi.unstubAllGlobals());

describe('the Brain chat', () => {
  it('streams the answer in, shows the files it reads, and ends with what it did', async () => {
    const input = document.querySelector('.dock-input') as HTMLTextAreaElement;
    input.value = 'make me a thumbnail team';
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    for (let i = 0; i < 100 && !brain; i++) await settle();
    expect(asked).toEqual({ text: 'make me a thumbnail team', project: 'p1', attachments: [] });
    const list = document.querySelector('.dock-list')!;
    expect(list.textContent).toContain('The Brain is looking at the project…');
    const b = brain!;
    await act(async () => {
      b.push({ type: 'start', messageId: 'brain-1' });
      b.push({ type: 'tool-input-available', toolCallId: 'r', toolName: 'Read', input: { file_path: 'BRAIN.md' }, dynamic: true });
      b.push({ type: 'tool-output-available', toolCallId: 'r', output: { text: '# Brain notes', images: [] }, dynamic: true });
      b.push({ type: 'text-start', id: 't' });
      b.push({ type: 'text-delta', id: 't', delta: 'I am building ' });
    });
    await settle();
    await settle();
    const msg = list.querySelector('.dock-msg.brain')!;
    expect(msg.textContent).toContain('I am building');
    expect(msg.querySelector('details.tool .tname')!.textContent).toBe('Read');
    expect(msg.querySelector('details.tool')!.textContent).toContain('# Brain notes');
    await act(async () => {
      b.push({ type: 'text-delta', id: 't', delta: 'the team.' });
      b.push({ type: 'text-end', id: 't' });
      b.push({ type: 'data-answer', data: { answer: 'I built the team.', done: [{ kind: 'team', text: 'Made the team "Thumbs"', teamId: 'w1' }], delegate: null, model: {}, project: 'P' } } as UIMessageChunk);
      b.push({ type: 'finish' });
      b.end();
    });
    for (let i = 0; i < 40 && !list.textContent!.includes('Made the team'); i++) await settle();
    const done = list.querySelector('.dock-msg.brain')!;
    expect(done.textContent).toContain('I built the team.');
    expect(done.textContent).toContain('Made the team "Thumbs"');
    expect(list.querySelectorAll('.dock-msg.brain')).toHaveLength(1);
  });
});

describe('brainProgress()', () => {
  it('what shows while it streams: the text and tools since it last started over', () => {
    const p = brainProgress({
      id: 'b',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Let me open the skill.' },
        { type: 'data-restart', data: {} },
        { type: 'dynamic-tool', toolName: 'Read', toolCallId: 'r', state: 'output-error', input: {}, errorText: 'not found' },
        { type: 'text', text: 'Here is the plan.' },
      ],
    } as never);
    expect(p.answer).toBe('Here is the plan.');
    expect(p.steps).toEqual([{ id: 'r', name: 'Read', input: {}, state: 'error', output: 'not found' }]);
  });
});
