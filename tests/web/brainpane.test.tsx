// Another project's Brain as an Overview pane: its conversation and your question go to that project
// (/api/p/<project>/brain/…), the answer streams in, and the work it hands on opens beside it.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { state } from '../../web/core.ts';
import { BrainPane } from '../../web/brainpane.tsx';
import type { AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));

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

let history: unknown[];
let stream: ReturnType<typeof uiStream> | null;
let requests: { url: string; body?: unknown }[];
let el: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><div id="pane"></div>';
  el = document.getElementById('pane')!;
  state.data = { runs: [], approvals: [], agents: [], project: { id: 'p1', name: 'Bakery' }, settings: {} } as unknown as AppState;
  history = [
    { role: 'user', text: 'What is new?', ts: 1 },
    { role: 'brain', text: 'The intro is edited.', ts: 2 },
  ];
  stream = null;
  requests = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    requests.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url === '/api/p/p2/brain/history') return json(history);
    if (url === '/api/p/p2/brain/stream') return (stream = uiStream()).response();
    return json({});
  });
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("another project's Brain in a pane", () => {
  it('shows its conversation, streams the answer to your question, and opens the work it hands on', async () => {
    const opened: string[] = [];
    root = createRoot(el);
    await act(async () => root.render(<BrainPane projectId="p2" projectName="Podcast" onOpen={(kind, id) => opened.push(`${kind}:${id}`)} />));
    await settle();
    expect(el.textContent).toContain('What is new?');
    expect(el.textContent).toContain('The intro is edited.');
    // its MEMORY.md is that project's Brain's
    await act(async () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('MEMORY.md'))!.click());
    for (let i = 0; i < 20 && !requests.some((r) => r.url === '/api/p/p2/memory/brain'); i++) await settle();
    expect(requests.some((r) => r.url === '/api/p/p2/memory/brain')).toBe(true);
    document.querySelectorAll('.modal-back').forEach((m) => m.remove());

    const box = el.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(box.placeholder).toContain("Ask Podcast's Brain");
    box.value = 'Cut the outro';
    await act(async () => void box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    for (let i = 0; i < 50 && !stream; i++) await settle();
    // (to that project, about that project: the open one stays open)
    expect(requests.find((r) => r.url === '/api/p/p2/brain/stream')!.body).toEqual({ text: 'Cut the outro', project: 'p2', attachments: [] });
    expect(requests.some((r) => r.url.startsWith('/api/brain') || r.url.includes('/activate'))).toBe(false);
    expect(el.textContent).toContain('The Brain is looking at the project…');
    const s = stream!;
    await act(async () => {
      s.push({ type: 'start', messageId: 'b1' });
      s.push({ type: 'text-start', id: 't' });
      s.push({ type: 'text-delta', id: 't', delta: 'Handing it to the editor.' });
    });
    await settle();
    expect(el.textContent).toContain('Handing it to the editor.');
    expect(el.querySelector('button[aria-label="Stop"]')).not.toBeNull();
    // the answer is saved in its history: the pane shows it from there once the stream ends
    history.push({ role: 'user', text: 'Cut the outro', ts: 3 }, { role: 'brain', text: 'Handing it to the editor.', ts: 4, done: [], delegate: { kind: 'agent', id: 'editor', name: 'Editor', message: 'Cut the outro' } });
    await act(async () => {
      s.push({ type: 'text-end', id: 't' });
      s.push({ type: 'data-answer', data: { answer: 'Handing it to the editor.', done: [], delegate: null, model: {}, project: 'Podcast' } } as UIMessageChunk);
      s.push({ type: 'finish' });
      s.end();
    });
    for (let i = 0; i < 20 && !el.textContent?.includes('Handed to'); i++) await settle();
    expect(el.textContent).toContain('Handed to Editor');
    expect(el.querySelector('button[aria-label="Send"]')).not.toBeNull();
    await act(async () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Open')!.click());
    expect(opened).toEqual(['agent:editor']);
  });
});
