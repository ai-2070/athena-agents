// The earlier chats beside the Tasks row (web/chatlist.tsx): they open below it like the tasks (one of the two at a
// time), the open one first, empty ones left out, a search box once the list is long, opening one and deleting one
// after asking; and in a team chat, New chat and a conversation opened elsewhere.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, state } from '../../web/core.ts';
import { TasksAndChats } from '../../web/chatlist.tsx';
import type { ChatListItem, ChatListProps } from '../../web/chatlist.tsx';
import { renderTeamChat } from '../../web/teamchat.tsx';
import type { TeamChatApi } from '../../web/teamchat.tsx';
import type { AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));
class FakeSocket {
  static last: FakeSocket | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
}
beforeAll(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  connectEvents();
});
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div>';
});

const now = Date.now();
const item = (id: string, title: string, over: Partial<ChatListItem> = {}): ChatListItem => ({ id, title, updatedAt: now - 60_000, count: 2, open: false, ...over });
const rows = () => [...document.querySelectorAll('.chat-list-row')].map((r) => r.querySelector('button')!.textContent);
const toggle = () => document.querySelector<HTMLButtonElement>('.chat-list-toggle')!;
const openList = async () => {
  if (toggle().getAttribute('aria-expanded') !== 'true') await act(async () => toggle().click());
  await settle();
};
const confirm = async (label: string) => {
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.modal-foot button')].find((b) => b.textContent === label)!.click());
  await settle();
};

describe('the earlier chats beside the tasks', () => {
  let root: Root;
  afterEach(() => act(() => root.unmount()));
  const draw = (props: Partial<ChatListProps> & { items: ChatListItem[] }) => {
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    const opened: string[] = [];
    const removed: string[] = [];
    let list = props.items;
    const chats: ChatListProps = {
      load: async () => list,
      onOpen: (c) => void opened.push(c.id),
      onRemove: async (c) => {
        removed.push(c.id);
        list = list.filter((x) => x.id !== c.id);
        return true;
      },
      removeNote: props.removeNote,
    };
    act(() => root.render(<TasksAndChats tasks={{ view: 'brain' }} chats={chats} />));
    return { opened, removed };
  };

  it('shows the open one first and leaves out empty ones; picking another opens it', async () => {
    const { opened } = draw({ items: [item('now', 'Today’s plan', { open: true, count: 0 }), item('a', 'Social media team'), item('empty', 'New chat', { count: 0 })] });
    await openList();
    expect(rows().map((t) => t?.replace(/\s+/g, ' '))).toEqual(['Today’s planempty', 'Social media team1m ago']);
    expect([...document.querySelectorAll('.chat-list [role="group"]')].map((g) => g.getAttribute('aria-label'))).toEqual(['Open now', 'Today']);
    // (the open one is already there: nothing to open)
    await act(async () => document.querySelector<HTMLButtonElement>('.chat-list-row button[aria-current="true"]')!.click());
    expect(opened).toEqual([]);
    await openList();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.chat-list-row button')].find((b) => b.textContent?.includes('Social media'))!.click());
    expect(opened).toEqual(['a']);
    // (it folds away again)
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('puts the open one first and the rest newest first, whatever order they came in', async () => {
    // (an agent's chats come newest first, so the open one can be in the middle)
    draw({ items: [item('a', 'Ten o’clock', { updatedAt: now - 1000 }), item('b', 'Nine o’clock', { open: true, updatedAt: now - 3000 }), item('c', 'Eight o’clock', { updatedAt: now - 5000 })] });
    await openList();
    expect([...document.querySelectorAll('.chat-list [role="group"]')].map((g) => g.getAttribute('aria-label'))).toEqual(['Open now', 'Today']);
    expect([...document.querySelectorAll('.chat-list-row .truncate')].map((t) => t.textContent)).toEqual(['Nine o’clock', 'Ten o’clock', 'Eight o’clock']);
  });

  it('opens below the Tasks row, and only one of the two is open at a time', async () => {
    draw({ items: [item('now', 'Open', { open: true })] });
    const tasks = [...document.querySelectorAll<HTMLButtonElement>('.task-panel button')].find((b) => b.textContent?.includes('Tasks'))!;
    // (the Chats button sits in the Tasks row)
    expect(tasks.parentElement!.contains(toggle())).toBe(true);
    await act(async () => tasks.click());
    expect(tasks.getAttribute('aria-expanded')).toBe('true');
    await openList();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(tasks.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.chat-list')!.textContent).toContain('No earlier chats.');
  });

  it('deletes one only after you say so, and says what else goes', async () => {
    const { removed } = draw({ items: [item('now', 'Open', { open: true }), item('a', 'Old one')], removeNote: 'Each agent also forgets it.' });
    await openList();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Delete Old one"]')!.click());
    await settle();
    expect(document.querySelector('#modal-root')!.textContent).toContain('Delete “Old one”? Each agent also forgets it.');
    await confirm('Cancel');
    expect(removed).toEqual([]);
    await openList();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Delete Old one"]')!.click());
    await settle();
    await confirm('Delete');
    expect(removed).toEqual(['a']);
  });

  it('has a search box once the list is long', async () => {
    draw({ items: [item('now', 'Open', { open: true }), ...Array.from({ length: 9 }, (_, i) => item(`c${i}`, i === 4 ? 'Find the logo' : `Chat ${i}`))] });
    await openList();
    const find = document.querySelector<HTMLInputElement>('input[aria-label="Find a chat"]')!;
    expect(find).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(find, 'logo');
      find.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows().map((t) => t?.replace(/\d+m ago$/, ''))).toEqual(['Find the logo']);
  });
});

describe("a team's chats", () => {
  let open: TeamChatApi | null = null;
  let requests: string[] = [];
  let messages: object[] = [];
  let working: string[] = [];
  let loop: object | null = null;
  let held: object[] = [];
  let chatsList: object[] = [];
  beforeEach(() => {
    requests = [];
    messages = [{ id: 'u1', ts: 0, from: 'user', text: 'Make a thumbnail', mentions: [] }];
    working = [];
    loop = null;
    held = [];
    chatsList = [];
    state.data = { runs: [], approvals: [], agents: [{ id: 'lead', name: 'Lead', emoji: '🧭', color: '#fff' }] } as unknown as AppState;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      requests.push(`${init.method || 'GET'} ${url}`);
      const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
      if (url === '/api/teams/t1/chat') return json({ team: { id: 't1', name: 'Thumbs', members: ['lead'], lead: 'lead', steps: [] }, messages, working, queued: [], held, loop, sessions: {} });
      if (url === '/api/teams/t1/chats' && init.method === 'POST') return json({ id: 't-new' });
      if (url === '/api/teams/t1/chats') return json(chatsList);
      return json({});
    });
  });
  afterEach(() => {
    open?.destroy();
    open = null;
  });
  const teamEvent = (event: object) => act(async () => FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: 'team', teamId: 't1', ts: 0, event }) }));
  const draw = async () => {
    const el = document.body.appendChild(document.createElement('div'));
    open = renderTeamChat(el, 't1');
    await settle();
    return el;
  };

  it('starts a new chat, asking first while the team works', async () => {
    working = ['lead'];
    const el = await draw();
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="New chat"]')!.click());
    await settle();
    expect(document.querySelector('#modal-root')!.textContent).toContain('Starting a new chat stops the team’s work.');
    await confirm('Stop and switch');
    expect(requests).toContain('POST /api/teams/t1/chats');
  });

  it('asks too while only a /loop runs or messages are held, and says so', async () => {
    loop = { id: 'l1', every: 60_000, text: 'Check the inbox', runs: 0 };
    held = [{ id: 'q1', text: 'Later', ts: 1 }];
    const el = await draw();
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="New chat"]')!.click());
    await settle();
    expect(document.querySelector('#modal-root')!.textContent).toContain('Starting a new chat stops your /loop and 1 held message.');
    await confirm('Cancel');
    expect(requests).not.toContain('POST /api/teams/t1/chats');
  });

  it('says what stops when the open chat is deleted while the team works', async () => {
    working = ['lead'];
    const el = await draw();
    chatsList = [{ id: 't-open', title: 'Make a thumbnail', count: 1, createdAt: 0, updatedAt: Date.now(), open: true }];
    await act(async () => el.querySelector<HTMLButtonElement>('.chat-list-toggle')!.click());
    await settle();
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Delete Make a thumbnail"]')!.click());
    await settle();
    expect(document.querySelector('#modal-root')!.textContent).toContain('Each agent also forgets it, and it stops the team’s work.');
    await confirm('Cancel');
  });

  it('shows the conversation opened instead, from here or another tab', async () => {
    const el = await draw();
    expect(el.querySelector('.tc-list')!.textContent).toContain('Make a thumbnail');
    messages = [{ id: 'u9', ts: 5, from: 'user', text: 'An older brief', mentions: [] }];
    await teamEvent({ kind: 'thread', id: 't-old' });
    await settle();
    const text = el.querySelector('.tc-list')!.textContent;
    expect(text).toContain('An older brief');
    expect(text).not.toContain('Make a thumbnail');
  });
});
