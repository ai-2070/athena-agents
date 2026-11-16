// The agent chat page (React around the AI SDK chat): a gone agent, picking a chat, the list, memory, delete.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dayGroups, dayOf, state } from '../../web/core.ts';
import * as chatPage from '../../web/views/chat.tsx';
import type { AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = (ms = 40) => act(() => new Promise((r) => setTimeout(r, ms)));
class FakeSocket {
  onmessage = null;
  onclose = null;
  onopen = null;
}
let requests: { method: string; url: string }[];
let titles: string[];
let el: HTMLElement;
const agent = {
  id: 'a1',
  name: 'Writer',
  emoji: '✍️',
  engine: 'claude-code',
  tools: ['read_file', 'web_search'],
  specialty: 'Posts',
};
const chats = [
  { id: 'c1', title: 'Launch post', updatedAt: Date.now(), count: 4 },
  { id: 'c2', title: 'Old', updatedAt: Date.now() - 86_400_000, count: 1 },
  { id: 'c3', title: 'Routine: Morning news', updatedAt: Date.now() - 40 * 86_400_000, count: 2 },
];

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  requests = [];
  titles = [];
  state.data = {
    agents: [agent],
    runs: [],
    approvals: [],
    settings: { defaults: {} },
    engines: {},
  } as unknown as AppState;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    requests.push({ method, url });
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/agents/a1') return json(agent);
    if (url === '/api/agents/gone') return json({ error: 'Unknown agent' }, 404);
    if (url === '/api/agents/a1/chats' && method === 'GET') return json(chats);
    if (url === '/api/agents/a1/chats/c1' && method === 'GET')
      return json({ id: 'c1', title: 'Launch post', items: [] });
    if (url === '/api/agents/a1/chats/c1/memory')
      return json({ tokens: 170_000, window: 200_000, compactAt: 160_000, percent: 85, auto: true });
    if (url.endsWith('/stream')) return new Response(null, { status: 204 });
    return json(url.includes('/commands') ? [] : { ok: true });
  });
});
afterEach(() => {
  act(() => chatPage.unmount());
  vi.unstubAllGlobals();
});

const open = async (params: string[]) => {
  await act(async () => chatPage.render(el, params, { setTitle: (t) => titles.push(t) }));
  await settle();
};

describe('the agent chat page', () => {
  it("doesn't list empty chats, and New chat goes to one instead of making another", async () => {
    chats.push({ id: 'c4', title: 'New chat', updatedAt: Date.now(), count: 0 });
    try {
      await open(['a1', 'c1']);
      await settle(80);
      const nav = el.querySelector('nav[aria-label="Chats"]')!;
      expect([...nav.querySelectorAll('a .t')].map((t) => t.textContent)).not.toContain('New chat');
      const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'New chat')!;
      await act(async () => button.click());
      expect(location.hash).toBe('#/agents/a1/c4');
      expect(requests.some((r) => r.method === 'POST' && r.url === '/api/agents/a1/chats')).toBe(false);
    } finally {
      chats.pop();
    }
  });

  it('loads the chat again from the project you open, never leaving the last one showing', async () => {
    const { refreshState } = await import('../../web/core.ts');
    state.data = { ...state.data, project: { id: 'pa', name: 'A' } } as unknown as AppState;
    await open(['a1', 'c1']);
    await settle(80);
    expect(el.querySelector('.chat-title')!.textContent).toBe('Launch post');
    const before = requests.filter((r) => r.url === '/api/agents/a1/chats/c1').length;
    // another project opens (its copy of the agent and chat has the same ids)
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const method = init.method || 'GET';
      requests.push({ method, url });
      const json = (v: unknown) =>
        new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url === '/api/state') return json({ ...state.data, project: { id: 'pb', name: 'B' } });
      if (url === '/api/agents/a1') return json(agent);
      if (url === '/api/agents/a1/chats' && method === 'GET') return json(chats);
      if (url === '/api/agents/a1/chats/c1' && method === 'GET')
        return json({ id: 'c1', title: "B's launch post", items: [] });
      if (url.endsWith('/stream')) return new Response(null, { status: 204 });
      return json(url.includes('/commands') ? [] : { ok: true });
    });
    await act(async () => refreshState());
    await settle(80);
    expect(requests.filter((r) => r.url === '/api/agents/a1/chats/c1').length).toBeGreaterThan(before);
    expect(el.querySelector('.chat-title')!.textContent).toBe("B's launch post");
  });

  it('says so when the agent no longer exists', async () => {
    await open(['gone']);
    expect(el.textContent).toBe('That agent no longer exists. Back to agents');
  });

  it('without a chat in the address, goes to the latest one', async () => {
    await open(['a1']);
    expect(location.hash).toBe('#/agents/a1/c1');
    expect(titles).toEqual(['✍️ Writer']);
  });

  it('shows the agent, its chats (this one marked), the title and how full its memory is', async () => {
    await open(['a1', 'c1']);
    await settle(80);
    const nav = el.querySelector('nav[aria-label="Chats"]')!;
    expect(
      [...nav.querySelectorAll('a')].map(
        (a) => `${a.querySelector('.t')!.textContent}${a.getAttribute('aria-current') ? '*' : ''}`,
      ),
    ).toEqual(['Launch post*', 'Old', 'Routine: Morning news']);
    // grouped by the day they were last used
    expect(nav.textContent).toContain('Today');
    expect(nav.textContent).toContain('Yesterday');
    expect(nav.textContent).toContain('Older');
    expect(el.querySelector('.chat-title')!.textContent).toBe('Launch post');
    const mem = el.querySelector('.chat-head .mem')!;
    expect(mem.textContent).toBe('Memory85%');
    expect(mem.classList.contains('warn')).toBe(true);
    expect(mem.querySelector<HTMLElement>('[aria-hidden="true"]')!.style.width).toBe('85%');
    expect([...el.querySelectorAll('.chat-tools code')].map((c) => c.textContent)).toEqual(['read_file', 'web_search']);
  });

  it('deletes the chat only after you confirm, then goes back to the agent', async () => {
    await open(['a1', 'c1']);
    // Rename, Clear memory and Delete are in the "…" menu
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-head [aria-label="Chat options"]')!.click());
    await settle();
    expect([...document.querySelectorAll('.st-menu .st-menu-item')].map((i) => i.textContent)).toEqual([
      'Rename',
      'Clear memory',
      'Delete',
    ]);
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('.st-menu .st-menu-item')]
        .find((b) => b.textContent === 'Delete')!
        .click(),
    );
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('.modal-foot button')]
        .find((b) => b.textContent === 'Delete')!
        .click(),
    );
    await settle();
    expect(requests.some((r) => r.method === 'DELETE' && r.url === '/api/agents/a1/chats/c1')).toBe(true);
    expect(location.hash).toBe('#/agents/a1');
  });

  it('puts a chat under Today, Yesterday, This week, This month or Older', () => {
    const now = new Date(2026, 10, 2, 15).getTime();
    const day = 86_400_000;
    expect([now - 60_000, now - day, now - 3 * day, now - 20 * day, now - 60 * day].map((t) => dayOf(t, now))).toEqual([
      'Today',
      'Yesterday',
      'This week',
      'This month',
      'Older',
    ]);
  });

  it('keeps one group per heading, even for a chat out of place', () => {
    const at = (updatedAt: number, id: string) => ({ id, updatedAt });
    const t = Date.now();
    const groups = dayGroups([at(t, 'a'), at(t - 40 * 86_400_000, 'old'), at(t - 1000, 'b')]);
    expect(groups.map((g) => [g.day, g.list.map((c) => c.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Older', ['old']],
    ]);
  });
});
