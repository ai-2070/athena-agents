// The OpenUI chat (web/chat) in a simulated page: a saved chat shows with its COMPACTED mark, tools and
// file previews; a message streams in; /compact compacts; a run started elsewhere shows live.
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, state } from '../../web/core.ts';
import { attachTray } from '../../web/attach.ts';
import { forgetFiles } from '../../web/filepreview.ts';
import { mountChat } from '../../web/chat/mount.tsx';
import { isRichCode } from '../../web/chat/ChatView.tsx';
import type { MountedChat } from '../../web/chat/mount.tsx';
import type { AppState, Chat, ChatItem, RunEvent } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------- a fake server: the saved chat, sends, compaction, file lookups ----------
class FakeSocket {
  static last: FakeSocket | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
}
const SAVED: ChatItem[] = [
  { type: 'user', text: 'old question' },
  { type: 'assistant', text: 'old answer' },
  { type: 'compaction', id: 'k1', text: 'COMPACTED HISTORY TEXT', mode: 'instant', trigger: 'auto', upto: 2 },
  { type: 'user', text: 'make a render' },
  { type: 'tool', id: 't1', name: 'blender_run_python', args: { code: 'bpy.ops.render()' }, result: 'rendered', status: 'done' },
  { type: 'assistant', text: 'Saved it to **/w/render.png**' },
];
let chat: Chat;
let requests: { method: string; url: string; body: Record<string, unknown> }[];
let onSend: ((body: Record<string, unknown>) => void) | null;

const emit = (event: RunEvent, runId = 'r1') => act(() => FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: 'run', ts: 0, runId, agentId: 'a1', chatId: 'c1', event }) }));
const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));

beforeAll(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  connectEvents();
});
beforeEach(() => {
  chat = { id: 'c1', agentId: 'a1', title: 'Renders', items: structuredClone(SAVED), llm: [], sessionId: null, createdAt: 0, updatedAt: 0 };
  requests = [];
  onSend = null;
  forgetFiles();
  // (the page's toast area, as in public/index.html)
  document.body.append(Object.assign(document.createElement('div'), { id: 'toasts' }));
  state.data = { runs: [], approvals: [], agents: [] } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : {};
    requests.push({ method, url, body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url === '/api/agents/a1/chats/c1' && method === 'GET') return json(chat);
    if (url === '/api/agents/a1/chats/c1/messages') {
      setTimeout(() => onSend?.(body), 0);
      return json({ runId: 'r1' });
    }
    if (url === '/api/agents/a1/chats/c1/compact') return json({ compacted: true, item: {} });
    if (url === '/api/files/info') return json((body.paths as string[]).map((p) => ({ path: p, ok: p === '/w/render.png', kind: 'image', name: 'render.png', size: 10, modified: 0 })));
    return json({});
  });
});
let mounted: MountedChat | null = null;
afterEach(() => {
  act(() => mounted?.destroy());
  mounted = null;
  document.body.innerHTML = '';
});

async function open(): Promise<HTMLElement> {
  const el = document.createElement('div');
  document.body.append(el);
  await act(async () => {
    mounted = mountChat(el, { agent: { id: 'a1', name: 'Renderer' }, chatId: 'c1', tray: attachTray() });
  });
  await settle();
  return el;
}

const type = async (el: HTMLElement, text: string) => {
  const box = el.querySelector('textarea')!;
  box.value = text;
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
};

describe('the OpenUI chat', () => {
  it('shows the saved chat: messages, the tool card, the COMPACTED mark, dimmed old messages, file previews', async () => {
    const el = await open();
    const text = el.textContent!;
    expect(text).toContain('make a render');
    expect(el.querySelector('details.tool .tname')!.textContent).toBe('blender_run_python');
    expect(el.querySelector('details.compaction')).not.toBeNull();
    expect(el.querySelector('details.compaction .cmp-text')!.textContent).toBe('COMPACTED HISTORY TEXT');
    // the messages before the kept ones are dimmed; the later ones are not
    const old = [...el.querySelectorAll('.msg.user')].find((n) => n.textContent === 'old question')!;
    expect(old.classList.contains('compacted')).toBe(true);
    const recent = [...el.querySelectorAll('.msg.user')].find((n) => n.textContent === 'make a render')!;
    expect(recent.classList.contains('compacted')).toBe(false);
    // the answer's mentioned file: a preview with Show in Explorer / Finder
    expect(el.querySelector('.fp-card img')!.getAttribute('src')).toBe('/api/file?path=%2Fw%2Frender.png');
    expect(el.querySelector('.fp-card .fp-reveal')).not.toBeNull();
  });

  it('a message streams in as it comes, then the saved chat is shown', async () => {
    const el = await open();
    onSend = (body) => {
      expect(body).toEqual({ text: 'and a video', attachments: [] });
      // what the server would save meanwhile
      chat.items.push({ type: 'user', text: 'and a video' }, { type: 'assistant', text: 'Rendered /w/render.png again.' });
      void emit({ kind: 'start', text: 'and a video' });
      void emit({ kind: 'text', text: 'Render' });
      void emit({ kind: 'text', text: 'ing…' });
    };
    await type(el, 'and a video');
    await settle();
    await settle();
    expect(el.textContent).toContain('and a video');
    expect(el.textContent).toContain('Rendering…');
    // (still running: Stop shows)
    expect([...el.querySelectorAll('button')].some((b) => b.textContent === 'Stop')).toBe(true);
    await emit({ kind: 'done', text: '' });
    await settle();
    await settle();
    expect(el.textContent).toContain('Rendered /w/render.png again.');
    expect(el.textContent).not.toContain('Rendering…');
    expect(requests.filter((r) => r.url === '/api/agents/a1/chats/c1' && r.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });

  it('/compact compacts instead of sending', async () => {
    const el = await open();
    await type(el, '/compact');
    await settle();
    expect(requests.some((r) => r.url === '/api/agents/a1/chats/c1/compact')).toBe(true);
    expect(document.getElementById('toasts')!.textContent).toContain('Compacted');
    expect(requests.some((r) => r.url.endsWith('/messages'))).toBe(false);
  });

  it('a run started elsewhere (a team turn, another tab) shows live', async () => {
    const el = await open();
    await emit({ kind: 'start', text: 'from the team', from: 'team Ops' }, 'r-team');
    await emit({ kind: 'tool', id: 'x1', name: 'read_file', args: { path: 'a.txt' } }, 'r-team');
    await emit({ kind: 'text', text: 'Reading it now' }, 'r-team');
    await settle();
    expect(el.textContent).toContain('from the team');
    expect(el.textContent).toContain('Reading it now');
    expect([...el.querySelectorAll('.tname')].map((n) => n.textContent)).toContain('read_file');
  });
});

describe('Rich answers', () => {
  it('an answer in OpenUI Lang shows as live components, not as code', async () => {
    chat.items = [
      { type: 'user', text: 'compare them' },
      { type: 'assistant', text: 'root = Card([title, body])\ntitle = CardHeader("Plan A wins")\nbody = TextContent("Cheaper and faster to ship.")' },
    ];
    const el = await open();
    for (let i = 0; i < 40 && !el.querySelector('.oc-rich'); i++) await settle();
    for (let i = 0; i < 40 && !el.textContent!.includes('Plan A wins'); i++) await settle();
    const rich = el.querySelector('.msg.assistant.rich .oc-rich')!;
    expect(rich).not.toBeNull();
    expect(rich.textContent).toContain('Plan A wins');
    expect(rich.textContent).toContain('Cheaper and faster to ship.');
    expect(rich.textContent).not.toContain('root =');
    // its stylesheet is linked once
    expect(document.querySelectorAll('link[data-openui]')).toHaveLength(1);
  }, 30_000);
});

describe('isRichCode()', () => {
  it('tells OpenUI Lang from markdown', () => {
    expect(isRichCode('root = Card([t])\nt = TextContent("hi")')).toBe(true);
    expect(isRichCode('Here is the plan:\n\n- one\n- two')).toBe(false);
    expect(isRichCode('```\nroot = Card([t])\n```')).toBe(false);
  });
});
