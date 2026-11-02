// The Tasks board: five columns, this project or every project, moves by key and by menu (saved in the task's
// own project), Blocked asking why, Done showing the last 14 days, the New task window, and a task's own page.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, state } from '../../web/core.ts';
import * as tasks from '../../web/views/tasks.tsx';
import type { AppState, BoardTask, ServerEvent } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = (ms = 40) => act(() => new Promise((r) => setTimeout(r, ms)));

const now = Date.now();
let n = 0;
const card = (over: Partial<BoardTask>): BoardTask => ({
  id: 't', number: ++n, projectId: 'p1', projectName: 'Bakery', title: 'Task', description: '', status: 'todo', priority: 'normal', assignee: '', rank: 0,
  createdBy: 'you', createdAt: now, updatedAt: now, assigneeName: 'Unassigned', creatorName: 'You', commentCount: 0, ...over,
});
// live events from the server, through a stand-in for the event socket
class FakeSocket {
  static last: FakeSocket;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
  constructor() { FakeSocket.last = this; }
}
const serverEvent = async (ev: Omit<ServerEvent, 'ts'>) => {
  await act(async () => FakeSocket.last.onmessage!({ data: JSON.stringify({ ts: Date.now(), ...ev }) } as MessageEvent<string>));
  await settle(200);
};
let board: BoardTask[];
let requests: { method: string; url: string; body: unknown }[];
let el: HTMLElement;

beforeEach(() => {
  n = 0;
  localStorage.clear();
  location.hash = '';
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  requests = [];
  board = [
    card({ id: 'a', title: 'Write the menu', rank: 1, priority: 'high' }),
    card({ id: 'b', title: 'Take photos', rank: 2, assignee: 'agent:x', assigneeName: 'Photographer', assigneeEmoji: '📷' }),
    card({ id: 'c', title: 'Print flyers', status: 'in_progress', rank: 1 }),
    card({ id: 'r', title: 'Check the prices', status: 'in_review', rank: 1 }),
    card({ id: 'k', title: 'Order the oven', status: 'blocked', blockedReason: 'Waiting for the quote', rank: 1 }),
    card({ id: 'd', title: 'Open the shop', status: 'done', rank: 1, doneAt: now }),
    card({ id: 'e', title: 'Old thing', status: 'done', rank: 2, doneAt: now - 30 * 86_400_000 }),
    card({ id: 'f', title: 'Plan the podcast', projectId: 'p2', projectName: 'Podcast', rank: 0.5 }),
  ];
  state.data = { project: { id: 'p1', name: 'Bakery' }, agents: [], runs: [], approvals: [] } as unknown as AppState;
  vi.stubGlobal('WebSocket', FakeSocket);
  connectEvents();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url.startsWith('/api/task-board?')) {
      const project = new URLSearchParams(url.split('?')[1]).get('project');
      return json({ projects: [{ id: 'p1', name: 'Bakery', open: 5 }, { id: 'p2', name: 'Podcast', open: 1 }], tasks: board.filter((t) => project === 'all' || t.projectId === project) });
    }
    if (url.startsWith('/api/task-board-people/')) return json({ agents: [{ id: 'x', name: 'Photographer', emoji: '📷' }], teams: [] });
    const one = /^\/api\/task-board\/([^/]+)\/([^/]+)$/.exec(url);
    if (one && method === 'GET') {
      const t = board.find((x) => x.projectId === one[1] && x.id === one[2]);
      return t ? json({ task: t }) : new Response(JSON.stringify({ error: 'That task is unavailable.' }), { status: 404 });
    }
    if (one && method === 'PUT') return json({ task: { ...board.find((t) => t.id === one[2]), ...body } });
    if (url === '/api/task-board-draft') return json({ kind: 'comment', text: 'Is the oven here yet?' });
    const comments = /^\/api\/task-board\/([^/]+)\/([^/]+)\/comments/.exec(url);
    if (comments) return json({ task: { ...board.find((t) => t.id === comments[2]), comments: [{ id: 'c9', by: 'you', byName: 'You', text: body?.text, at: now }] } });
    if (method === 'POST') return json({ task: card({ id: 'new', ...body }) });
    return json({ ok: true });
  });
});
afterEach(() => {
  act(() => tasks.unmount());
  document.querySelectorAll('.modal-back').forEach((m) => m.remove());
  vi.unstubAllGlobals();
});

const open = async (params: string[] = []) => {
  await act(async () => tasks.render(el, params));
  await settle();
};
const column = (label: string) => el.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!;
const ids = (label: string) => [...column(label).querySelectorAll('[data-task-id]')].map((c) => c.getAttribute('data-task-id')!.split('/')[1]);
const type = async (input: HTMLInputElement | HTMLTextAreaElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('the Tasks board', () => {
  it('shows this project in five columns, in rank order, with Done showing the last 14 days', async () => {
    await open();
    expect(requests[0].url).toBe('/api/task-board?project=p1');
    expect([...el.querySelectorAll('section[data-column] h2')].map((h) => h.textContent)).toEqual(['To do', 'In progress', 'In review', 'Blocked', 'Done']);
    expect(ids('To do')).toEqual(['a', 'b']);
    expect(ids('In review')).toEqual(['r']);
    expect(column('Blocked').textContent).toContain('Waiting for the quote');
    expect(column('To do').textContent).toContain('#1');
    expect(column('To do').querySelector('[title="Assigned to Photographer"]')).not.toBeNull();
    expect(ids('Done')).toEqual(['d']);
    const older = [...column('Done').querySelectorAll('button')].find((b) => b.textContent?.startsWith('Show'))!;
    expect(older.textContent).toBe('Show 1 older');
    await act(async () => older.click());
    expect(ids('Done')).toEqual(['d', 'e']);
  });

  it('can show every project, each card saying which one it is in', async () => {
    localStorage.setItem('dash-task-board', 'all');
    await open();
    expect(requests[0].url).toBe('/api/task-board?project=all');
    expect(ids('To do')).toEqual(['f', 'a', 'b']);
    expect(column('To do').querySelector('[data-task-id="p2/f"]')!.textContent).toContain('Podcast');
  });

  it('moves a card a column with ] and within one with Alt+↓, saving it in its own project', async () => {
    await open();
    const a = () => el.querySelector<HTMLElement>('[data-task-id="p1/a"]')!;
    await act(async () => a().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })));
    expect(ids('To do')).toEqual(['b', 'a']);
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', url: '/api/task-board/p1/a', body: { status: 'todo', rank: 2 + 1024 } });
    await act(async () => a().dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true })));
    expect(ids('In progress')).toEqual(['a', 'c']);
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', url: '/api/task-board/p1/a', body: { status: 'in_progress', rank: 1 - 1024 } });
  });

  it('asks why before a card goes to Blocked, and leaves it where it was if you cancel', async () => {
    await open();
    const r = () => el.querySelector<HTMLElement>('[data-task-id="p1/r"]')!;
    await act(async () => r().dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true })));
    const box = document.querySelector<HTMLInputElement>('.modal input')!;
    expect(document.querySelector('.modal')!.textContent).toContain('Why is #4 blocked?');
    await type(box, 'Waiting for the owner');
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) => b.textContent === 'Move to Blocked')!.click());
    await settle();
    expect(ids('Blocked')).toEqual(['r', 'k']);
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', url: '/api/task-board/p1/r', body: { status: 'blocked', blockedReason: 'Waiting for the owner' } });
  });

  it('makes a task in the New task window, in the column it was opened from', async () => {
    await open();
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Create a task in In review"]')!.click());
    await settle();
    const modal = document.querySelector<HTMLElement>('.modal')!;
    expect(modal.textContent).toContain('New task');
    await type(modal.querySelector<HTMLInputElement>('input[aria-label="Title"]')!, 'Taste the new cake');
    await type(modal.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]')!, 'Before Friday.');
    expect(modal.querySelector('[aria-label="Status: In review"]')).not.toBeNull();
    // Ctrl+Enter makes it
    await act(async () => modal.querySelector('form')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })));
    await settle();
    expect(requests.find((r) => r.method === 'POST')).toMatchObject({ url: '/api/task-board/p1', body: { title: 'Taste the new cake', description: 'Before Friday.', status: 'in_review', priority: 'normal', assignee: '' } });
  });

  it('works out a place between two cards', () => {
    expect(tasks.rankBetween(undefined, undefined)).toBe(0);
    expect(tasks.rankBetween(1, 2)).toBe(1.5);
    expect(tasks.rankBetween(undefined, 5)).toBe(5 - 1024);
    expect(tasks.rankBetween(5, undefined)).toBe(5 + 1024);
  });
});

describe('a task\'s own page', () => {
  it('shows the task with its properties, and saves a new title when you leave it', async () => {
    await open(['p1', 'k']);
    expect(el.querySelector('nav[aria-label="Breadcrumb"]')!.textContent).toBe('TasksBakery#5');
    expect(el.textContent).toContain('Waiting for the quote');
    expect(el.querySelector('[aria-label="Status: Blocked"]')).not.toBeNull();
    const title = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Title"]')!;
    await type(title, 'Order the new oven');
    await act(async () => title.dispatchEvent(new FocusEvent('blur')));
    await act(async () => title.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await settle();
    // (with the version it was made on, so a change made meanwhile isn't overwritten)
    expect(requests.find((r) => r.method === 'PUT')).toMatchObject({ url: '/api/task-board/p1/k', body: { title: 'Order the new oven', expectedUpdatedAt: now } });
  });

  it('asks before a description edit replaces one made meanwhile, and saves it on the newest version', async () => {
    await open(['p1', 'a']);
    await act(async () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Add a description…')!.click());
    await type(el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]')!, 'Mine');
    // the Brain writes one while the editor is open
    board[0] = { ...board[0], description: 'Theirs', updatedAt: now + 5 };
    await serverEvent({ type: 'board', projectId: 'p1', ids: ['a'] });
    const saveButton = () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Save')!;
    await act(async () => saveButton().click());
    await settle();
    expect(document.querySelector('.modal')!.textContent).toContain('Someone changed this description while you were editing it.');
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) => b.textContent === 'Cancel')!.click());
    await settle();
    expect(requests.some((r) => r.method === 'PUT')).toBe(false);
    expect(el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Description"]')!.value).toBe('Mine');
    await act(async () => saveButton().click());
    await settle();
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) => b.textContent === 'Replace')!.click());
    await settle();
    expect(requests.find((r) => r.method === 'PUT')).toMatchObject({ url: '/api/task-board/p1/a', body: { description: 'Mine', expectedUpdatedAt: now + 5 } });
  });

  it('shows the description as Markdown, and its comments, and adds one', async () => {
    board[0] = { ...board[0], description: 'Use **real** butter.', comments: [{ id: 'c1', by: 'brain', byName: 'The Brain', text: 'Checked the *price*.', at: now }] };
    await open(['p1', 'a']);
    expect(el.querySelector('strong')?.textContent).toBe('real');
    expect(el.querySelector('section[aria-label="Activity"]')!.textContent).toContain('The Brain');
    expect(el.querySelector('section[aria-label="Activity"] em')?.textContent).toBe('price');
    await type(el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!, 'Looks *good*');
    await act(async () => el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!.form!.requestSubmit());
    await settle();
    expect(requests.find((r) => r.method === 'POST')).toMatchObject({ url: '/api/task-board/p1/a/comments', body: { text: 'Looks *good*' } });
  });

  it('drafts a comment with the Brain, and Undo takes it back', async () => {
    await open(['p1', 'a']);
    const box = () => el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!;
    await type(box(), 'mine');
    const draft = [...el.querySelectorAll<HTMLButtonElement>('section[aria-label="Activity"] button')].find((b) => b.textContent === 'Draft with the Brain')!;
    await act(async () => draft.click());
    await settle();
    await type(document.querySelector<HTMLInputElement>('input[placeholder^="e.g. make it a checklist"]')!, 'ask about the oven');
    await act(async () => document.querySelector<HTMLInputElement>('input[placeholder^="e.g. make it a checklist"]')!.form!.requestSubmit());
    await settle();
    expect(requests.find((r) => r.url === '/api/task-board-draft')).toMatchObject({ method: 'POST', body: { projectId: 'p1', kind: 'comment', taskId: 'a', text: 'mine', instruction: 'ask about the oven' } });
    expect(box().value).toBe('Is the oven here yet?');
    // (drafting never sends the comment)
    expect(requests.some((r) => r.url.endsWith('/comments'))).toBe(false);
    await act(async () => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Undo')!.click());
    expect(box().value).toBe('mine');
  });

  it('shows @mentions of agents as pills, and @ in the comment box offers the project\'s agents', async () => {
    board[0] = { ...board[0], comments: [{ id: 'c1', by: 'you', byName: 'You', text: 'Ask @Photographer for the shots.', at: now }] };
    await open(['p1', 'a']);
    await settle(60);
    const pill = el.querySelector('section[aria-label="Activity"] .task-mention');
    expect(pill?.textContent).toBe('@Photographer');
    const box = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Comment"]')!;
    // (the box is the pill editor now: the textarea stays the text behind it)
    expect(box.hidden).toBe(true);
    box.focus();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Thanks @Pho');
      box.setSelectionRange(11, 11);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
    const menu = document.querySelector('.rt-menu')!;
    expect([...menu.querySelectorAll('.rt-menu-item')].map((b) => b.textContent)).toEqual(['📷Photographer']);
    await act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(box.value).toBe('Thanks @Photographer ');
    expect(el.querySelector('section[aria-label="Activity"] [data-mention="@Photographer"]')).not.toBeNull();
  });

  it('says so when the task is gone', async () => {
    await open(['p1', 'missing']);
    expect(el.textContent).toContain('Back to tasks');
  });
});
