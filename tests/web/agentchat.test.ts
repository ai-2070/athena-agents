// The floating window's agent tab: focus asked for before its chat has loaded is given once it has.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import { renderAgentChat } from '../../web/agentchat.tsx';
import { scopeTo } from '../../web/client/connection.ts';
import type { AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('renderAgentChat()', () => {
  it('focus asked for right away lands in the message box once the chat is there', async () => {
    state.data = { runs: [], approvals: [], agents: [{ id: 'a1', name: 'Scout', engine: 'eve', model: 'm', provider: 'custom' }], settings: {} } as unknown as AppState;
    vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url === '/api/agents/a1/chats' ? [] : {}), { headers: { 'content-type': 'application/json' } }));
    const el = document.createElement('div');
    document.body.append(el);
    const tab = renderAgentChat(el, 'a1');
    // (what chatwin.ts does a moment after opening a tab: the chat is still loading)
    tab.focus();
    // (the box you type in is the pill editor that takes the textarea's place)
    const box = () => el.querySelector('[role="textbox"][contenteditable="true"]');
    for (let i = 0; i < 100 && (!box() || document.activeElement !== box()); i++) await settle();
    expect(document.activeElement).toBe(box());
    tab.destroy();
  });
});

describe('the agent chat box', () => {
  it('shows an @mention of another agent as a pill, not the agent it talks to', async () => {
    state.data = { runs: [], approvals: [], agents: [{ id: 'a1', name: 'Scout', engine: 'eve', model: 'm', provider: 'custom' }, { id: 'a2', name: 'Writer', engine: 'eve', model: 'm', provider: 'custom' }], settings: {} } as unknown as AppState;
    vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url === '/api/agents/a1/chats' ? [] : {}), { headers: { 'content-type': 'application/json' } }));
    const el = document.createElement('div');
    document.body.append(el);
    const tab = renderAgentChat(el, 'a1');
    for (let i = 0; i < 100 && !el.querySelector('[role="textbox"][contenteditable="true"]'); i++) await settle();
    const box = el.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      box.value = 'Ask @Writer and @Scout';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const editor = el.querySelector<HTMLElement>('[role="textbox"][contenteditable="true"]')!;
    expect([...editor.querySelectorAll('[data-mention]')].map((p) => p.getAttribute('data-mention'))).toEqual(['@Writer']);
    tab.destroy();
  });
});

describe('a chat of a project that isn\'t open (an Overview pane)', () => {
  it('finds its agent in that project, and its requests and files go there', async () => {
    state.data = { runs: [], approvals: [], agents: [{ id: 'a1', name: 'Scout', engine: 'eve', model: 'm', provider: 'custom' }], settings: {} } as unknown as AppState;
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const body = url === '/api/p/p2/agents' ? [{ id: 'far', name: 'Far writer', engine: 'eve', model: 'm', provider: 'custom' }] : url.endsWith('/chats') ? [] : {};
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    });
    const el = document.createElement('div');
    document.body.append(el);
    const release = scopeTo('p2', 'agents', 'far');
    const tab = renderAgentChat(el, 'far', { projectId: 'p2' });
    for (let i = 0; i < 100 && !el.querySelector('[role="textbox"][contenteditable="true"]'); i++) await settle();
    expect(el.querySelector('[role="textbox"][contenteditable="true"]')).not.toBeNull();
    expect(urls).toContain('/api/p/p2/agents');
    expect(urls).toContain('/api/p/p2/agents/far/chats');
    expect(urls).not.toContain('/api/agents/far/chats');
    // (no Full page link: that page is the open project's)
    expect(el.textContent).not.toContain('Full page');
    tab.destroy();
    release();
  });
});

describe('the agent tab', () => {
  it('New chat clicked before the latest chat was found stays on the new chat', async () => {
    state.data = { runs: [], approvals: [], agents: [{ id: 'a1', name: 'Scout', engine: 'eve', model: 'm', provider: 'custom' }], settings: {} } as unknown as AppState;
    let found!: () => void;
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      // (the list of chats is slow to come)
      if (url === '/api/agents/a1/chats' && init.method !== 'POST') return new Promise<Response>((r) => (found = () => r(json([{ id: 'c7', title: 'Mine' }]))));
      if (url === '/api/agents/a1/chats') return json({ id: 'c8', title: 'New chat', items: [] });
      if (/\/chats\/c\d$/.test(url)) return json({ id: url.split('/').pop(), title: 'Chat', items: [] });
      return json(url.endsWith('/commands') ? [] : {});
    });
    const el = document.createElement('div');
    document.body.append(el);
    const tab = renderAgentChat(el, 'a1');
    await settle();
    const full = () => el.querySelector<HTMLAnchorElement>('a[title="Open the full chat page"]')!.getAttribute('href');
    await act(async () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('New chat'))!.click());
    await settle();
    expect(full()).toBe('#/agents/a1/c8');
    await act(async () => found());
    await settle();
    expect(full()).toBe('#/agents/a1/c8');
    act(() => tab.destroy());
  });


  it('opens its latest own chat (not a team session), and New chat starts a fresh one', async () => {
    state.data = { runs: [], approvals: [], agents: [{ id: 'a1', name: 'Scout', engine: 'eve', model: 'm', provider: 'custom' }], settings: {} } as unknown as AppState;
    const posts: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (init.method === 'POST') posts.push(url);
      const body =
        url === '/api/agents/a1/chats' && init.method !== 'POST'
          ? [{ id: 'team1', title: 'Team: Social', teamId: 't1' }, { id: 'c7', title: 'Mine' }]
          : url === '/api/agents/a1/chats'
            ? { id: 'c8', title: 'New chat', items: [] }
            : /\/chats\/c\d$/.test(url)
              ? { id: url.split('/').pop(), title: 'Chat', items: [] }
              : url.endsWith('/commands')
                ? []
                : {};
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    });
    const el = document.createElement('div');
    document.body.append(el);
    const tab = renderAgentChat(el, 'a1');
    await settle();
    await settle();
    const full = () => el.querySelector<HTMLAnchorElement>('a[title="Open the full chat page"]')!.getAttribute('href');
    expect(full()).toBe('#/agents/a1/c7');
    await act(async () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('New chat'))!.click());
    await settle();
    expect(posts).toEqual(['/api/agents/a1/chats']);
    expect(full()).toBe('#/agents/a1/c8');
    act(() => tab.destroy());
    expect(el.innerHTML).toBe('');
  });
});
