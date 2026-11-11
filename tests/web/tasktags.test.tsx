// Tags on the Tasks board's page: marks on the cards, the Tags filter (any or all, no tags, by name across
// projects), a tag on a card filtering the board, the Tags row on a task's page (picking and making tags) and the
// Manage tags window.
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, state } from '../../web/core.ts';
import * as tasks from '../../web/views/tasks.tsx';
import { TagManager, tagOptions } from '../../web/tasktags.tsx';
import type { AppState, BoardTag, BoardTagUse, BoardTask } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = (ms = 40) => act(() => new Promise((r) => setTimeout(r, ms)));
class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
}
// a change the server tells open tabs about
const serverEvent = (ev: object) =>
  act(async () => FakeSocket.last!.onmessage!({ data: JSON.stringify({ ts: 0, ...ev }) }));

const now = Date.now();
let n = 0;
const tag = (id: string, name: string, emoji?: string, tasks = 0): BoardTagUse => ({
  id,
  name,
  ...(emoji ? { emoji } : {}),
  createdBy: 'you',
  createdAt: now,
  tasks,
});
let tags: Record<string, BoardTagUse[]>;
const pick = (projectId: string, ...ids: string[]): BoardTag[] =>
  ids.map((id) => tags[projectId].find((t) => t.id === id)!);
const card = (over: Partial<BoardTask>): BoardTask => ({
  id: 't',
  number: ++n,
  projectId: 'p1',
  projectName: 'Bakery',
  title: 'Task',
  description: '',
  status: 'todo',
  priority: 'normal',
  assignee: '',
  rank: n,
  createdBy: 'you',
  createdAt: now,
  updatedAt: now,
  assigneeName: 'Unassigned',
  creatorName: 'You',
  commentCount: 0,
  fileCount: 0,
  tagList: [],
  ...over,
});
let board: BoardTask[];
let requests: { method: string; url: string; body: unknown }[];
let el: HTMLElement;
// while set, saving a task waits for it (the server is slow)
let hold: Promise<void> | null;

beforeEach(() => {
  n = 0;
  localStorage.clear();
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  requests = [];
  hold = null;
  tags = {
    p1: [
      tag('g1', 'Bug', '🐛', 2),
      tag('g2', 'Design', '🎨', 1),
      tag('g3', 'Mobile', undefined, 1),
      tag('g4', 'Docs', '📝', 1),
    ],
    p2: [tag('h1', 'bug', undefined, 1)],
  };
  board = [
    card({ id: 'a', title: 'Fix the login', tags: ['g1', 'g3'], tagList: pick('p1', 'g1', 'g3') }),
    card({ id: 'b', title: 'New icons', tags: ['g2'], tagList: pick('p1', 'g2') }),
    card({ id: 'c', title: 'Plain task' }),
    card({ id: 'm', title: 'Many tags', tags: ['g1', 'g2', 'g3', 'g4'], tagList: pick('p1', 'g1', 'g2', 'g3', 'g4') }),
    card({
      id: 'f',
      title: 'Podcast bug',
      projectId: 'p2',
      projectName: 'Podcast',
      tags: ['h1'],
      tagList: pick('p2', 'h1'),
    }),
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
      const project = new URLSearchParams(url.split('?')[1]).get('project')!;
      const shown = project === 'all' ? ['p1', 'p2'] : [project];
      return json({
        projects: [
          { id: 'p1', name: 'Bakery', open: 4 },
          { id: 'p2', name: 'Podcast', open: 1 },
        ],
        tasks: board.filter((t) => shown.includes(t.projectId)),
        tags: Object.fromEntries(shown.map((p) => [p, tags[p]])),
      });
    }
    if (url.startsWith('/api/task-board-people/')) return json({ agents: [], teams: [] });
    const tagList = /^\/api\/task-board-tags\/([^/]+)$/.exec(url);
    if (tagList && method === 'GET') return json({ tags: tags[tagList[1]] });
    if (tagList && method === 'POST') {
      const same = tags[tagList[1]].find((t) => t.name.toLowerCase() === String(body.name).toLowerCase());
      if (same) return json({ tag: { ...same, made: false } });
      const made = tag(
        'new1',
        String(body.name).replace(/^🍰\s*/, ''),
        String(body.name).startsWith('🍰') ? '🍰' : body.emoji,
      );
      tags[tagList[1]] = [...tags[tagList[1]], made];
      return json({ tag: { ...made, made: true } });
    }
    const oneTag = /^\/api\/task-board-tags\/([^/]+)\/([^/]+)$/.exec(url);
    if (oneTag && method === 'PUT') {
      if (
        body.name &&
        tags[oneTag[1]].some((t) => t.id !== oneTag[2] && t.name.toLowerCase() === String(body.name).toLowerCase())
      ) {
        return new Response(JSON.stringify({ error: `There's a tag called "${body.name}" already.` }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
      }
      tags[oneTag[1]] = tags[oneTag[1]].map((t) => (t.id === oneTag[2] ? { ...t, ...body } : t));
      return json({ tag: tags[oneTag[1]].find((t) => t.id === oneTag[2]) });
    }
    if (oneTag && method === 'DELETE') {
      tags[oneTag[1]] = tags[oneTag[1]].filter((t) => t.id !== oneTag[2]);
      return json({ tasks: 2 });
    }
    const one = /^\/api\/task-board\/([^/]+)\/([^/]+)$/.exec(url);
    if (one) {
      const i = board.findIndex((t) => t.projectId === one[1] && t.id === one[2]);
      if (method === 'PUT') {
        if (hold) await hold;
        if (typeof body.expectedUpdatedAt === 'number' && body.expectedUpdatedAt !== board[i].updatedAt) {
          return new Response(JSON.stringify({ error: 'This task changed meanwhile. Reload it before saving.' }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          });
        }
        let ids: string[] = body.tags ?? board[i].tags ?? [];
        ids = [...ids, ...(body.addTags ?? []).filter((x: string) => !ids.includes(x))].filter(
          (x) => !(body.removeTags ?? []).includes(x),
        );
        board[i] = { ...board[i], tags: ids, tagList: pick(one[1], ...ids), updatedAt: board[i].updatedAt + 1 };
      }
      return json({ task: board[i] });
    }
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
const cards = () =>
  [...el.querySelectorAll('[data-task-id]')].map((c) => c.getAttribute('data-task-id')!.split('/')[1]);
const click = async (b: Element | null | undefined) => {
  expect(b).toBeTruthy();
  await act(async () => (b as HTMLElement).click());
  await settle();
};
const row = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((b) => b.textContent?.includes(text));
const type = async (input: HTMLInputElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('tags on the board', () => {
  it("shows a card's tags, up to three and then how many more", async () => {
    await open();
    const login = el.querySelector('[data-task-id="p1/a"]')!;
    expect([...login.querySelectorAll('.tag')].map((t) => t.textContent)).toEqual(['🐛Bug', 'Mobile']);
    const many = el.querySelector('[data-task-id="p1/m"]')!;
    expect(many.querySelectorAll('.tag')).toHaveLength(3);
    expect(many.textContent).toContain('+1');
    expect(el.querySelector('[data-task-id="p1/c"]')!.querySelector('.tag')).toBeNull();
  });

  it('filters by any or all of the tags picked, or tasks with no tags, and Clear shows everything again', async () => {
    await open();
    const filter = () => el.querySelector<HTMLButtonElement>('button[aria-label^="Tags shown"]')!;
    await click(filter());
    await click(row('Bug'));
    expect(cards()).toEqual(['a', 'm']);
    expect(filter().textContent).toBe('🐛 Bug');
    await click(row('Design'));
    expect(cards()).toEqual(['a', 'b', 'm']);
    expect(filter().textContent).toBe('2 tags');
    // two or more: any or all of them
    await click([...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'All'));
    expect(cards()).toEqual(['m']);
    await click(row('Bug'));
    await click(row('Design'));
    await click(row('No tags'));
    expect(cards()).toEqual(['c']);
    await click([...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Clear'));
    expect(cards()).toEqual(['a', 'b', 'c', 'm']);
  });

  it('filters by a tag clicked on a card, and finds tags by search', async () => {
    await open();
    await click(el.querySelector('[data-task-id="p1/b"] button[aria-label="Show tasks tagged 🎨 Design"]'));
    expect(cards()).toEqual(['b', 'm']);
    // (the click didn't open the task)
    expect(location.hash).not.toContain('/tasks/p1/b');
    await click([...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Clear'));
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!, 'mobile');
    expect(cards()).toEqual(['a', 'm']);
  });

  it('drops a tag from the filter when the projects shown no longer have it, so the cards come back', async () => {
    await open();
    const filter = () => el.querySelector<HTMLButtonElement>('button[aria-label^="Tags shown"]')!;
    await click(filter());
    await click(row('Bug'));
    expect(cards()).toEqual(['a', 'm']);
    // Bug is renamed somewhere else: the board loads again without it
    tags.p1 = tags.p1.map((t) => (t.id === 'g1' ? { ...t, name: 'Defect' } : t));
    await serverEvent({ type: 'board', projectId: 'p1', ids: [] });
    await settle(250);
    expect(cards()).toEqual(['a', 'b', 'c', 'm']);
    expect(filter().textContent).toBe('Tags');
  });

  it('merges same-named tags of every project in All projects', async () => {
    localStorage.setItem('dash-task-board', 'all');
    await open();
    await click(el.querySelector('button[aria-label^="Tags shown"]'));
    // one Bug, counting both projects' tasks; no Manage tags with every project shown
    expect(row('Bug')!.textContent).toContain('3');
    expect([...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Manage tags'))).toBe(false);
    await click(row('Bug'));
    expect(cards()).toEqual(['a', 'm', 'f']);
    expect(tagOptions({ p1: [tag('x', 'Bug', '🐛', 1)], p2: [tag('y', 'bug', undefined, 2)] })).toEqual([
      { key: 'bug', name: 'Bug', emoji: '🐛', tasks: 3 },
    ]);
  });
});

describe("tags on a task's page", () => {
  it('puts tags on and takes them off, and makes a new one with its emoji', async () => {
    await open(['p1', 'b']);
    const picker = () => el.querySelector<HTMLButtonElement>('button[aria-label^="Tags:"]')!;
    expect(picker().getAttribute('aria-label')).toBe('Tags: 🎨 Design');
    await click(picker());
    await click(row('Bug'));
    expect(requests.at(-1)).toEqual({
      method: 'PUT',
      url: '/api/task-board/p1/b',
      body: { addTags: ['g1'], expectedUpdatedAt: now },
    });
    expect(picker().getAttribute('aria-label')).toBe('Tags: 🎨 Design, 🐛 Bug');
    await click(row('Design'));
    expect(requests.at(-1)).toEqual({
      method: 'PUT',
      url: '/api/task-board/p1/b',
      body: { removeTags: ['g2'], expectedUpdatedAt: now + 1 },
    });

    await type(document.querySelector<HTMLInputElement>('input[aria-label="Find or make a tag"]')!, '🍰 Cake');
    const make = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === 'Make “🍰 Cake”',
    );
    await click(make);
    expect(requests.find((r) => r.method === 'POST')).toMatchObject({
      url: '/api/task-board-tags/p1',
      body: { name: '🍰 Cake' },
    });
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', body: { addTags: ['new1'] } });
    expect(board.find((t) => t.id === 'b')!.tags).toEqual(['g1', 'new1']);
    // a name that is there already is picked, not made again (Enter)
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Find or make a tag"]')!;
    await type(search, 'docs');
    await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', body: { addTags: ['g4'] } });
    expect(board.find((t) => t.id === 'b')!.tags).toEqual(['g1', 'new1', 'g4']);
  });

  it('saves quick clicks one after another, each on the version the last one left, so none is lost', async () => {
    await open(['p1', 'b']);
    const picker = () => el.querySelector<HTMLButtonElement>('button[aria-label^="Tags:"]')!;
    await click(picker());
    let release = () => {};
    hold = new Promise((r) => (release = r));
    // both clicks before the first save is back: the menu shows them at once
    await click(row('Bug'));
    await click(row('Mobile'));
    expect(picker().getAttribute('aria-label')).toBe('Tags: 🎨 Design, 🐛 Bug, Mobile');
    hold = null;
    await act(async () => release());
    await settle();
    expect(requests.filter((r) => r.method === 'PUT').map((r) => r.body)).toEqual([
      { addTags: ['g1'], expectedUpdatedAt: now },
      { addTags: ['g3'], expectedUpdatedAt: now + 1 },
    ]);
    expect(board.find((t) => t.id === 'b')!.tags).toEqual(['g2', 'g1', 'g3']);
    expect(picker().getAttribute('aria-label')).toBe('Tags: 🎨 Design, 🐛 Bug, Mobile');
    expect(document.querySelector('#toasts')!.textContent).not.toContain('changed meanwhile');
  });

  it("loads the project's tags when the menu opens, and not on every change to the board while it is closed", async () => {
    await open(['p1', 'b']);
    const tagLoads = () => requests.filter((r) => r.method === 'GET' && r.url === '/api/task-board-tags/p1').length;
    // the task's own tags show without them
    expect(el.querySelector('button[aria-label^="Tags:"]')!.getAttribute('aria-label')).toBe('Tags: 🎨 Design');
    await serverEvent({ type: 'board', projectId: 'p1', ids: ['a'] });
    await settle();
    expect(tagLoads()).toBe(0);
    await click(el.querySelector('button[aria-label^="Tags:"]'));
    expect(tagLoads()).toBe(1);
    await serverEvent({ type: 'board', projectId: 'p1', ids: ['a'] });
    await settle();
    expect(tagLoads()).toBe(2);
  });
});

describe('Manage tags', () => {
  let root: Root;
  let box: HTMLElement;
  const mount = async () => {
    box = document.createElement('div');
    document.body.append(box);
    root = createRoot(box);
    await act(async () => root.render(<TagManager projectId="p1" />));
    await settle();
  };
  afterEach(() => act(() => root.unmount()));

  it('makes, renames, takes the emoji off and deletes tags, asking first and saying how many tasks it comes off', async () => {
    await mount();
    expect([...box.querySelectorAll('li')].map((li) => li.querySelector('input')!.value)).toEqual([
      'Bug',
      'Design',
      'Mobile',
      'Docs',
    ]);
    expect(box.querySelector('li')!.textContent).toContain('2 tasks');

    await type(box.querySelector<HTMLInputElement>('input[aria-label="New tag"]')!, 'Ovens');
    await click([...box.querySelectorAll('button')].find((b) => b.textContent === 'Add tag'));
    expect(requests.at(-2)).toMatchObject({ method: 'POST', url: '/api/task-board-tags/p1', body: { name: 'Ovens' } });

    const name = box.querySelector<HTMLInputElement>('input[aria-label="Name of Mobile"]')!;
    await type(name, 'Phones');
    await act(async () => name.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await settle();
    expect(requests.find((r) => r.method === 'PUT')).toMatchObject({
      url: '/api/task-board-tags/p1/g3',
      body: { name: 'Phones' },
    });

    await click(box.querySelector('button[aria-label="Take the emoji off Design"]'));
    expect(requests.filter((r) => r.method === 'PUT').at(-1)).toMatchObject({
      url: '/api/task-board-tags/p1/g2',
      body: { emoji: '' },
    });

    await click(box.querySelector('button[aria-label="Delete the tag Bug"]'));
    expect(document.querySelector('.modal')!.textContent).toContain('It comes off 2 tasks.');
    await click(
      [...document.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) => b.textContent === 'Delete'),
    );
    expect(requests.find((r) => r.method === 'DELETE')).toMatchObject({ url: '/api/task-board-tags/p1/g1' });
    expect(
      [...box.querySelectorAll('li input[aria-label^="Name of"]')].map((i) => (i as HTMLInputElement).value),
    ).not.toContain('Bug');
  });

  it("puts a refused name back, and says so when a new tag's name is taken, keeping what was typed", async () => {
    await mount();
    const name = box.querySelector<HTMLInputElement>('input[aria-label="Name of Mobile"]')!;
    await type(name, 'Design');
    await act(async () => name.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    await settle();
    expect(document.querySelector('#toasts')!.textContent).toContain('There\'s a tag called "Design" already.');
    expect(box.querySelector<HTMLInputElement>('input[aria-label="Name of Mobile"]')!.value).toBe('Mobile');

    const add = box.querySelector<HTMLInputElement>('input[aria-label="New tag"]')!;
    await type(add, 'bug');
    await click([...box.querySelectorAll('button')].find((b) => b.textContent === 'Add tag'));
    expect(document.querySelector('#toasts')!.textContent).toContain("There's a tag called “🐛 Bug” already.");
    expect(add.value).toBe('bug');
  });
});
