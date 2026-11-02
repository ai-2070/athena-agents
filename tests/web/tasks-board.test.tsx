// The Tasks board: three columns, this project or every project, moves by key and by menu (saved in the
// task's own project), Done showing the last 14 days, and a new card typed at the top of a column.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import * as tasks from '../../web/views/tasks.tsx';
import type { AppState, BoardTask } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = (ms = 40) => act(() => new Promise((r) => setTimeout(r, ms)));

const now = Date.now();
const card = (over: Partial<BoardTask>): BoardTask => ({
  id: 't', projectId: 'p1', projectName: 'Bakery', subject: 'Task', preview: '', activeForm: '', status: 'pending', scope: { kind: 'brain' },
  listName: 'The Brain', owner: '', ownerName: 'Unassigned', blockedBy: [], rank: 0, createdAt: now, updatedAt: now, ...over,
});
let board: BoardTask[];
let requests: { method: string; url: string; body: unknown }[];
let el: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  requests = [];
  board = [
    card({ id: 'a', subject: 'Write the menu', rank: 1 }),
    card({ id: 'b', subject: 'Take photos', rank: 2, owner: 'agent:x', ownerName: 'Photographer', ownerEmoji: '📷' }),
    card({ id: 'c', subject: 'Print flyers', status: 'in_progress', activeForm: 'Printing flyers', rank: 1 }),
    card({ id: 'd', subject: 'Open the shop', status: 'completed', rank: 1 }),
    card({ id: 'e', subject: 'Old thing', status: 'completed', rank: 2, updatedAt: now - 30 * 86_400_000 }),
    card({ id: 'f', subject: 'Plan the podcast', projectId: 'p2', projectName: 'Podcast', rank: 0.5, blockedBy: ['zz'] }),
  ];
  state.data = { project: { id: 'p1', name: 'Bakery' }, agents: [], runs: [], approvals: [] } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ method, url, body });
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url.startsWith('/api/task-board?')) {
      const project = new URLSearchParams(url.split('?')[1]).get('project');
      return json({ projects: [{ id: 'p1', name: 'Bakery', open: 3 }, { id: 'p2', name: 'Podcast', open: 1 }], tasks: board.filter((t) => project === 'all' || t.projectId === project) });
    }
    return json({ task: {} });
  });
});
afterEach(() => {
  act(() => tasks.unmount());
  vi.unstubAllGlobals();
});

const open = async () => {
  await act(async () => tasks.render(el, []));
  await settle();
};
const column = (label: string) => el.querySelector<HTMLElement>(`section[aria-label="${label}"]`)!;
const titles = (label: string) => [...column(label).querySelectorAll('[data-task-id]')].map((c) => c.getAttribute('data-task-id'));

describe('the Tasks board', () => {
  it('shows this project in three columns, in rank order, with Done showing the last 14 days', async () => {
    await open();
    expect(requests[0].url).toBe('/api/task-board?project=p1');
    expect(titles('To do')).toEqual(['a', 'b']);
    expect(titles('In progress')).toEqual(['c']);
    expect(titles('Done')).toEqual(['d']);
    expect(column('In progress').textContent).toContain('Printing flyers');
    expect(column('To do').textContent).toContain('Photographer');
    const older = [...column('Done').querySelectorAll('button')].find((b) => b.textContent?.startsWith('Show older'))!;
    expect(older.textContent).toBe('Show older (1)');
    await act(async () => older.click());
    expect(titles('Done')).toEqual(['d', 'e']);
  });

  it('can show every project, each card saying which one it is in', async () => {
    localStorage.setItem('dash-task-board', 'all');
    await open();
    expect(requests[0].url).toBe('/api/task-board?project=all');
    expect(titles('To do')).toEqual(['f', 'a', 'b']);
    const podcast = column('To do').querySelector('[data-task-id="f"]')!;
    expect(podcast.textContent).toContain('Podcast');
    expect(podcast.textContent).toContain('Waiting for 1 task');
  });

  it('moves a card a column with ] and within one with Alt+↓, saving it in its own project', async () => {
    await open();
    const a = () => el.querySelector<HTMLElement>('[data-task-id="a"]')!;
    await act(async () => a().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })));
    expect(titles('To do')).toEqual(['b', 'a']);
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', url: '/api/task-board/p1/a', body: { status: 'pending', rank: 2 + 1024 } });
    await act(async () => a().dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true })));
    expect(titles('In progress')).toEqual(['a', 'c']);
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', url: '/api/task-board/p1/a', body: { status: 'in_progress', rank: 1 - 1024 } });
  });

  it('adds a card at the top of the column it was typed in', async () => {
    await open();
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Add a task to In progress"]')!.click());
    const input = el.querySelector<HTMLInputElement>('input[aria-label="New task title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Call the printer');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.form!.requestSubmit());
    await settle();
    expect(requests.find((r) => r.method === 'POST')).toMatchObject({ url: '/api/task-board/p1', body: { subject: 'Call the printer', status: 'in_progress', rank: 1 - 1024 } });
  });

  it('works out a place between two cards', () => {
    expect(tasks.rankBetween(undefined, undefined)).toBe(0);
    expect(tasks.rankBetween(1, 2)).toBe(1.5);
    expect(tasks.rankBetween(undefined, 5)).toBe(5 - 1024);
    expect(tasks.rankBetween(5, undefined)).toBe(5 + 1024);
  });
});
