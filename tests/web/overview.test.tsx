// The Overview page: every project's sessions in one sidebar, sorted Needs you first, with pins, a scope and search;
// what needs you and what works; chats, terminals and Brains of any project as panes on a strip.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, state } from '../../web/core.ts';
import * as overview from '../../web/views/overview.tsx';
import type { AppState, OverviewData, OverviewSession } from '../../shared/types.ts';

const opened = vi.hoisted(() => ({ chats: [] as string[], dock: 0 }));
vi.mock('../../web/chatwin.tsx', () => ({
  openChat: (kind: string, id: string) => {
    opened.chats.push(`${kind}:${id}`);
  },
}));
vi.mock('../../web/dock.tsx', () => ({
  openDock: () => {
    opened.dock++;
  },
}));
// (stand-ins for the chats and terminals a pane shows: what matters here is the strip)
const drawn = vi.hoisted(() => ({ live: new Set<string>(), projects: [] as (string | undefined)[] }));
vi.mock('../../web/agentchat.tsx', () => ({
  renderAgentChat: (el: HTMLElement, id: string, o: { projectId?: string } = {}) => (
    (el.textContent = `agent chat ${id}`),
    drawn.live.add(`agent:${id}`),
    drawn.projects.push(o.projectId),
    { focus() {}, destroy: () => drawn.live.delete(`agent:${id}`) }
  ),
}));
vi.mock('../../web/teamchat.tsx', () => ({
  renderTeamChat: (el: HTMLElement, id: string) => (
    (el.textContent = `team chat ${id}`),
    drawn.live.add(`team:${id}`),
    { focus() {}, mention() {}, destroy: () => drawn.live.delete(`team:${id}`) }
  ),
}));
vi.mock('../../web/brainpane.tsx', async () => {
  const { createElement } = await import('react');
  return {
    BrainPane: ({ projectId }: { projectId: string }) =>
      createElement('div', { className: 'brain-stand-in' }, `brain of ${projectId}`),
  };
});
vi.mock('../../web/terminalview.tsx', async () => {
  const { createElement } = await import('react');
  return { XTerm: ({ id }: { id: string }) => createElement('div', { className: 'xterm-stand-in' }, `terminal ${id}`) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = (ms = 40) => act(() => new Promise((r) => setTimeout(r, ms)));
class FakeSocket {
  static last: FakeSocket | null = null;
  constructor() {
    FakeSocket.last = this;
  }
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
}

const now = Date.now();
const card = {
  description: '',
  priority: 'normal',
  rank: 0,
  createdAt: 1,
  updatedAt: 1,
  assignee: '',
  assigneeName: 'Unassigned',
  tagList: [],
  commentCount: 0,
  fileCount: 0,
};
const session = (over: Partial<OverviewSession>): OverviewSession => ({
  kind: 'agent',
  id: 'x',
  name: 'X',
  status: 'idle',
  updatedAt: now - 60_000,
  ...over,
});
let data: OverviewData;
let requests: { method: string; url: string; body?: unknown }[];
let el: HTMLElement;
// how long the server takes to answer /api/overview (0: at once)
let slowOverview = 0;

beforeEach(() => {
  localStorage.clear();
  opened.chats = [];
  opened.dock = 0;
  drawn.projects = [];
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  requests = [];
  slowOverview = 0;
  data = {
    active: 'p1',
    projects: [
      {
        id: 'p1',
        name: 'Bakery',
        working: 1,
        needsYou: 1,
        boardOpen: 3,
        sessions: [
          session({ kind: 'brain', id: 'brain', name: 'The Brain', updatedAt: now - 10_000 }),
          session({ id: 'writer', name: 'Writer', emoji: '✍️', status: 'working', updatedAt: now - 5_000 }),
          session({ id: 'baker', name: 'Baker', status: 'needs-you', why: 'Approval: Run a command' }),
          session({ kind: 'team', id: 't1', name: 'Shop team', updatedAt: now - 1_000 }),
          session({ kind: 'terminal', id: 'term1', name: 'PowerShell', updatedAt: now - 2_000 }),
        ],
      },
      {
        id: 'p2',
        name: 'Podcast',
        working: 0,
        needsYou: 1,
        boardOpen: 0,
        sessions: [
          session({ id: 'host', name: 'Host' }),
          session({
            kind: 'task',
            id: 'bt1',
            number: 4,
            name: 'Edit the intro',
            status: 'needs-you',
            why: 'Its work needs a look',
          }),
        ],
      },
    ],
  };
  state.data = { project: { id: 'p1', name: 'Bakery' }, agents: [], runs: [], approvals: [] } as unknown as AppState;
  vi.stubGlobal('WebSocket', FakeSocket);
  connectEvents();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    requests.push({ method: init.method || 'GET', url, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url === '/api/overview')
      return slowOverview ? new Promise<Response>((r) => setTimeout(() => r(json(data)), slowOverview)) : json(data);
    if (url === '/api/task-board?project=all')
      return json({
        projects: [],
        tasks: [
          {
            ...card,
            id: 'bt1',
            number: 4,
            title: 'Edit the intro',
            status: 'in_progress',
            projectId: 'p2',
            projectName: 'Podcast',
            assignee: 'agent:host',
            assigneeName: 'Host',
            work: { state: 'working' },
            workerName: 'Host',
          },
          {
            ...card,
            id: 'bt2',
            number: 7,
            title: 'Order flour',
            status: 'todo',
            projectId: 'p1',
            projectName: 'Bakery',
            updatedAt: 70,
          },
          { ...card, id: 'bt3', number: 1, title: 'Old', status: 'done', projectId: 'p1', projectName: 'Bakery' },
          {
            ...card,
            id: 'bt4',
            number: 9,
            title: 'Bake bread',
            status: 'done',
            projectId: 'p1',
            projectName: 'Bakery',
            doneAt: Date.now() - 60_000,
          },
        ],
      });
    if (url === '/api/task-board/p1/bt2' && init.method === 'PUT')
      return json({ task: { ...card, id: 'bt2', projectId: 'p1', updatedAt: 71 } });
    if (url.startsWith('/api/projects/p1/folder')) {
      const path = decodeURIComponent(url.split('path=')[1] || '');
      return json(
        path === 'notes'
          ? {
              rel: 'notes',
              entries: [{ name: 'idea.md', dir: false, size: 2048, path: '/b/notes/idea.md', rel: 'notes/idea.md' }],
              more: 0,
            }
          : {
              rel: '',
              entries: [
                { name: 'notes', dir: true, path: '/b/notes', rel: 'notes' },
                { name: 'PROJECT.md', dir: false, size: 12, path: '/b/PROJECT.md', rel: 'PROJECT.md' },
              ],
              more: 0,
            },
      );
    }
    if (url.startsWith('/api/projects/p2/folder'))
      return json({
        rel: '',
        entries: [{ name: 'episodes', dir: true, path: '/pod/episodes', rel: 'episodes' }],
        more: 0,
      });
    if (url === '/api/terminals' && init.method === 'POST') {
      data.projects[0].sessions.push(session({ kind: 'terminal', id: 'term2', name: 'PowerShell 2' }));
      return json({ id: 'term2', title: 'PowerShell 2' });
    }
    // (once opened, the page's state shows the podcast)
    if (url === '/api/state') return json({ ...state.data, project: { id: 'p1', name: 'Bakery' } });
    return json({});
  });
});
afterEach(() => {
  act(() => overview.unmount());
  document.querySelectorAll('.modal-back').forEach((m) => m.remove());
  vi.unstubAllGlobals();
});

const open = async () => {
  await act(async () => overview.render(el, []));
  await settle();
};
const group = (name: string) => el.querySelector<HTMLElement>(`.overview-project[aria-label="${name}"]`)!;
const rows = (name: string) => [...group(name).querySelectorAll('.session-name')].map((b) => b.textContent);
const panes = () => [...el.querySelectorAll('.strip-pane')].map((p) => p.getAttribute('aria-label'));
const row = (project: string, name: string) =>
  [...group(project).querySelectorAll<HTMLButtonElement>('.session-open')].find(
    (b) => b.querySelector('.session-name')!.textContent === name,
  )!;

const panel = async (label: string) => {
  await act(async () =>
    [...el.querySelectorAll<HTMLButtonElement>('[aria-label="Panels"] button')]
      .find((b) => b.textContent === label)!
      .click(),
  );
  await settle();
  return el.querySelector<HTMLElement>(`.overview-panel[aria-label="${label}"]`)!;
};

describe('the Overview', () => {
  it("lists every project's sessions, Needs you first, with what needs you and what works", async () => {
    await open();
    expect(rows('Bakery')).toEqual(['Baker', 'Writer', 'Shop team', 'The Brain']);
    expect(rows('Podcast')).toEqual(['#4 Edit the intro', 'Host']);
    expect(group('Bakery').querySelector('.session-status[aria-label="Working"]')).not.toBeNull();
    const needs = el.querySelector<HTMLElement>('section[aria-label="Needs you"]')!;
    expect(needs.textContent).toContain('Baker · Bakery');
    expect(needs.textContent).toContain('Approval: Run a command');
    expect(needs.textContent).toContain('#4 Edit the intro · Podcast');
    expect(el.querySelector('section[aria-label="Working now"]')!.textContent).toContain('Writer');
    expect(el.querySelector('.overview-status')!.textContent).toContain('2 need you');
    expect(el.querySelector('.overview-status')!.textContent).toContain('1 of 5 working');
    expect(el.textContent).toContain('Click an agent, a team or the Brain, of any project, to open it here.');
    expect(el.querySelector('.overview-status')!.textContent).toContain('2 projects');
  });

  it('says under each name what needs you, that it works, or what it is and when it last changed', async () => {
    await open();
    const line = (name: string) => row('Bakery', name).querySelector('.session-name')!.nextElementSibling!.textContent;
    expect(line('Baker')).toBe('Approval: Run a command');
    expect(line('Writer')).toBe('Working…');
    expect(line('Shop team')).toBe('Team · just now');
    expect(line('The Brain')).toBe('Brain · just now');
    expect(
      group('Bakery').querySelector('.session-status[aria-label="Needs you: Approval: Run a command"]'),
    ).not.toBeNull();
  });

  it("folds the app's sidebar to its icons, as the Station does, and leaves out the Ask the Brain button", () => {
    expect(overview.slimNav).toBe(true);
    expect(overview.brainButton).toBe(false);
  });

  it('pins a session to the top of its project, and remembers it', async () => {
    await open();
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="Pin The Brain"]')!.click());
    expect(rows('Bakery')[0]).toBe('The Brain');
    act(() => overview.unmount());
    await open();
    expect(rows('Bakery')[0]).toBe('The Brain');
    expect(el.querySelector('button[aria-label="Unpin The Brain"]')!.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows only this project when asked, and narrows by search', async () => {
    localStorage.setItem('dash-overview-scope', 'here');
    await open();
    expect(el.querySelector('.overview-project[aria-label="Podcast"]')).toBeNull();
    expect(el.querySelector('.overview-status')!.textContent).not.toContain('projects');
    const box = el.querySelector<HTMLInputElement>('input[aria-label="Search sessions"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, 'writ');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(rows('Bakery')).toEqual(['Writer']);
  });

  it("opens the open project's chats and its Brain as panes side by side", async () => {
    await open();
    await act(async () => row('Bakery', 'Writer').click());
    await act(async () => row('Bakery', 'Shop team').click());
    await settle();
    expect(panes()).toEqual(['Writer', 'Shop team']);
    expect(el.querySelector('[data-pane="p1/agent:writer"]')!.textContent).toContain('agent chat writer');
    expect(el.querySelector('[data-pane="p1/team:t1"]')!.textContent).toContain('team chat t1');
    expect(el.querySelector('[data-pane="p1/agent:writer"]')!.textContent).toContain('Working');
    // the sidebar marks what is open, and opening one again only focuses it
    expect(row('Bakery', 'Writer').getAttribute('aria-current')).toBe('true');
    await act(async () => row('Bakery', 'Writer').click());
    expect(panes()).toEqual(['Writer', 'Shop team']);
    // the Brain opens beside them too, next to the pane in use (its whole chat is Ctrl+K)
    await act(async () => row('Bakery', 'The Brain').click());
    await settle();
    expect(panes()).toEqual(['Writer', 'The Brain', 'Shop team']);
    expect(el.querySelector('[data-pane="p1/brain:brain"]')!.textContent).toContain('brain of p1');
    expect(opened.dock).toBe(0);
    expect(opened.chats).toEqual([]);
    expect(requests.some((r) => r.url.includes('/activate'))).toBe(false);
    // and it is all there again next time
    act(() => overview.unmount());
    await open();
    expect(panes()).toEqual(['Writer', 'The Brain', 'Shop team']);
  });

  it('lets the strip be narrower than its panes, so it scrolls instead of growing', async () => {
    await open();
    await act(async () => row('Bakery', 'Writer').click());
    await settle();
    // (without min-w-0 the strip grows to fit its panes, and pane widths, taken from its width, grow with it)
    const strip = el.querySelector<HTMLElement>('.strip')!;
    for (let box: HTMLElement | null = strip; box && box !== el; box = box.parentElement) {
      if (box.parentElement?.classList.contains('flex-col')) break;
      expect(box.classList.contains('min-w-0'), box.className).toBe(true);
    }
    // and it comes to rest at a pane's edge
    expect(strip.classList.contains('snap-x')).toBe(true);
    expect(strip.querySelector('.strip-column')!.classList.contains('snap-start')).toBe(true);
  });

  it('moves, stacks, pins and closes panes with Ctrl+Alt keys, and changes the columns per view', async () => {
    await open();
    for (const name of ['Writer', 'Shop team', 'Baker']) await act(async () => row('Bakery', name).click());
    expect(panes()).toEqual(['Writer', 'Shop team', 'Baker']);
    const key = (code: string, shiftKey = false) =>
      act(
        async () =>
          void document.dispatchEvent(
            new KeyboardEvent('keydown', {
              code,
              ctrlKey: true,
              altKey: true,
              shiftKey,
              bubbles: true,
              cancelable: true,
            }),
          ),
      );
    // Baker is in use: move it left, then stack it under the Writer
    await key('BracketLeft', true);
    expect(panes()).toEqual(['Writer', 'Baker', 'Shop team']);
    await key('KeyS');
    expect(el.querySelectorAll('.strip-column')).toHaveLength(2);
    expect(
      [...el.querySelectorAll('.strip-column')[0].querySelectorAll('.strip-pane')].map((p) =>
        p.getAttribute('aria-label'),
      ),
    ).toEqual(['Writer', 'Baker']);
    // pane 3 (the team), pinned at the left
    await key('Digit3');
    await key('KeyP');
    expect(el.querySelector('.strip-column')!.getAttribute('data-pinned')).toBe('true');
    expect(panes()[0]).toBe('Shop team');
    await key('KeyW');
    expect(panes()).toEqual(['Writer', 'Baker']);
    await settle(10);
    expect(drawn.live.has('team:t1')).toBe(false);
    await key('Minus');
    expect(el.querySelector('.strip-per-view')!.textContent).toBe('1');
    await key('Equal');
    await key('Equal');
    expect(el.querySelector('.strip-per-view')!.textContent).toBe('3');
  });

  it('keeps a chat as it is (an unsent message, attached files) when its pane is stacked, moved or scrolled away', async () => {
    await open();
    for (const name of ['Writer', 'Baker']) await act(async () => row('Bakery', name).click());
    const chatOf = (name: string) =>
      el.querySelector<HTMLElement>(`.strip-pane[aria-label="${name}"] .strip-chat > div`)!;
    // (stands in for what was typed)
    chatOf('Baker').dataset.draft = 'Half a message';
    const renders = drawn.projects.length;
    const key = (code: string, shiftKey = false) =>
      act(
        async () =>
          void document.dispatchEvent(
            new KeyboardEvent('keydown', {
              code,
              ctrlKey: true,
              altKey: true,
              shiftKey,
              bubbles: true,
              cancelable: true,
            }),
          ),
      );
    await key('KeyS');
    expect(el.querySelectorAll('.strip-column')).toHaveLength(1);
    expect(chatOf('Baker').dataset.draft).toBe('Half a message');
    await key('KeyS');
    await key('BracketLeft', true);
    expect(panes()).toEqual(['Baker', 'Writer']);
    expect(chatOf('Baker').dataset.draft).toBe('Half a message');
    expect(drawn.projects.length).toBe(renders);
    expect(drawn.live.has('agent:baker')).toBe(true);
  });

  it("leaves AltGr alone: Ctrl+Alt that types a character isn't a shortcut", async () => {
    const press = (code: string, key: string) => ({ code, key });
    // a German keyboard: AltGr+8 is [, AltGr+ß is \; a Polish one: AltGr+O is ó
    expect(overview.typesCharacter(press('Digit8', '['), false)).toBe(true);
    expect(overview.typesCharacter(press('Minus', '\\'), false)).toBe(true);
    expect(overview.typesCharacter(press('KeyO', 'ó'), false)).toBe(true);
    expect(overview.typesCharacter(press('KeyS', 'ś'), false)).toBe(true);
    // a US keyboard, and a Mac (⌃⌥ types nothing there): shortcuts
    expect(overview.typesCharacter(press('Digit8', '8'), false)).toBe(false);
    expect(overview.typesCharacter(press('KeyO', 'O'), false)).toBe(false);
    expect(overview.typesCharacter(press('Minus', '-'), false)).toBe(false);
    expect(overview.typesCharacter(press('KeyO', 'ø'), true)).toBe(false);

    await open();
    for (const name of ['Writer', 'Shop team']) await act(async () => row('Bakery', name).click());
    const before = el.querySelector('.strip-per-view')!.textContent;
    const typed = new KeyboardEvent('keydown', {
      code: 'Minus',
      key: '\\',
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => void document.dispatchEvent(typed));
    expect(typed.defaultPrevented).toBe(false);
    expect(el.querySelector('.strip-per-view')!.textContent).toBe(before);
  });

  it('leaves terminals out: not in the list, and a terminal pane saved before goes', async () => {
    localStorage.setItem(
      'dash-overview-strip:all',
      JSON.stringify({
        perView: 2,
        focus: null,
        columns: [
          { panes: [{ kind: 'terminal', id: 'term1', projectId: 'p1' }], width: 1, heights: [1], pinned: false },
          { panes: [{ kind: 'agent', id: 'writer', projectId: 'p1' }], width: 1, heights: [1], pinned: false },
        ],
      }),
    );
    await open();
    expect(rows('Bakery')).not.toContain('PowerShell');
    expect(el.querySelector('button[aria-label="New terminal in Bakery"]')).toBeNull();
    expect(panes()).toEqual(['Writer']);
  });

  it('leaves out panes whose agent is gone', async () => {
    await open();
    for (const name of ['Writer', 'Baker']) await act(async () => row('Bakery', name).click());
    data.projects[0].sessions = data.projects[0].sessions.filter((x) => x.id !== 'baker');
    act(() => overview.unmount());
    await open();
    expect(panes()).toEqual(['Writer']);
  });

  it('closes a pane with a double-click on it in the list', async () => {
    await open();
    for (const name of ['Writer', 'Baker']) await act(async () => row('Bakery', name).click());
    expect(panes()).toEqual(['Writer', 'Baker']);
    await act(async () => void row('Bakery', 'Writer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(panes()).toEqual(['Baker']);
    expect(row('Bakery', 'Writer').getAttribute('aria-current')).toBeNull();
  });

  it('reads the overview again while a reply streams, not only once it stops', async () => {
    await open();
    const asked = () => requests.filter((r) => r.url === '/api/overview').length;
    const before = asked();
    // a run event every 100 ms for 2.5 s: each one alone would put the reload off again
    for (let i = 0; i < 25; i++) {
      await act(async () =>
        FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: 'run', ts: 0 }) } as MessageEvent<string>),
      );
      await settle(100);
    }
    expect(asked()).toBeGreaterThan(before);
  });

  it("opens another project's agent and its Brain as panes that talk to that project, without opening it", async () => {
    data.projects[1].sessions.push(session({ kind: 'brain', id: 'brain', name: 'The Brain' }));
    await open();
    await act(async () => row('Podcast', 'Host').click());
    await settle();
    expect(panes()).toEqual(['Host']);
    const pane = el.querySelector<HTMLElement>('[data-pane="p2/agent:host"]')!;
    expect(pane.textContent).toContain('Host · Podcast');
    // (its chat is told its project: its requests go there)
    expect(drawn.projects.at(-1)).toBe('p2');
    await act(async () =>
      [...pane.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.getAttribute('aria-label') === 'Actions for Host')!
        .click(),
    );
    await settle();
    // (no chat window for another project's agent)
    expect(document.body.textContent).not.toContain('Open in a chat window');
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

    // its Brain opens beside it; the Brain chat stays the open project's
    await act(async () => row('Podcast', 'The Brain').click());
    await settle();
    expect(panes()).toEqual(['Host', 'The Brain']);
    expect(el.querySelector('[data-pane="p2/brain:brain"]')!.textContent).toContain('brain of p2');
    expect(opened.dock).toBe(0);
    expect(requests.some((r) => r.url.includes('/activate'))).toBe(false);
    // the open project's Brain is a pane as well, whose menu opens the whole Brain chat
    await act(async () => row('Bakery', 'The Brain').click());
    await settle();
    expect(panes()).toEqual(['Host', 'The Brain', 'The Brain']);
    const mine = el.querySelector<HTMLElement>('[data-pane="p1/brain:brain"]')!;
    await act(async () => mine.querySelector<HTMLButtonElement>('button[aria-label="Actions for The Brain"]')!.click());
    await settle();
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((m) => m.textContent === 'Open in the Brain chat')!
        .click(),
    );
    expect(opened.dock).toBe(1);
  });

  it('puts an agent beside its twin of a copied project (the same id), each talking to its own project', async () => {
    data.projects[1].sessions.push(session({ id: 'writer', name: 'Writer' }));
    await open();
    await act(async () => row('Bakery', 'Writer').click());
    await act(async () => row('Podcast', 'Writer').click());
    await settle();
    expect([...el.querySelectorAll('.strip-pane')].map((p) => p.getAttribute('data-pane'))).toEqual([
      'p1/agent:writer',
      'p2/agent:writer',
    ]);
    expect([...new Set(drawn.projects)]).toEqual([undefined, 'p2']);
  });

  it('shows what needs you in its panel: approvals to decide right there, then the rest', async () => {
    state.data = {
      ...state.data!,
      approvals: [
        {
          id: 'ap1',
          kind: 'tool',
          title: 'Run a command',
          detail: 'rm -rf build',
          agentId: 'baker',
          agentName: 'Baker',
          data: {},
          editable: null,
          createdAt: 1,
          projectId: 'p1',
        },
        {
          id: 'ap2',
          kind: 'tool',
          title: 'Elsewhere',
          detail: '',
          agentId: 'z',
          agentName: 'Z',
          data: {},
          editable: null,
          createdAt: 1,
          projectId: 'p9',
        },
      ],
    } as AppState;
    await open();
    const needs = await panel('Needs you');
    expect(needs.textContent).toContain('Run a command');
    expect(needs.textContent).not.toContain('Elsewhere');
    expect(needs.textContent).toContain('#4 Edit the intro');
    // (the approval isn't listed twice)
    expect(needs.textContent?.match(/Run a command/g)).toHaveLength(1);
    // the panel stays open next time
    act(() => overview.unmount());
    await open();
    expect(el.querySelector('.overview-panel[aria-label="Needs you"]')).not.toBeNull();
  });

  it('lists the open tasks of what is shown by column in the Tasks panel', async () => {
    await open();
    const tasks = await panel('Tasks');
    // the open statuses, each a place to drop a card even when empty
    expect([...tasks.querySelectorAll('section h3')].map((h) => h.textContent)).toEqual([
      'In progress1',
      'To do1',
      'In review0',
      'Blocked0',
    ]);
    expect(tasks.textContent).toContain('All projects · 2 tasks');
    // the Tasks board's own cards
    const cards = [...tasks.querySelectorAll<HTMLElement>('li[data-task-id]')];
    expect(cards.map((c) => c.getAttribute('aria-label'))).toEqual([
      '#4 Edit the intro, In progress, Podcast',
      '#7 Order flour, To do, Bakery',
    ]);
    expect(cards[0].querySelector('a')!.getAttribute('href')).toBe('#/tasks/p2/bt1');
    expect(cards[0].querySelector('.work-mark[aria-label="Host is working on it"]')).not.toBeNull();
    expect(tasks.textContent).not.toContain('Old');
    // a card's menu moves it, saved in its own project
    await act(async () =>
      cards[1].querySelector<HTMLButtonElement>('button[aria-label="Actions for Order flour"]')!.click(),
    );
    await settle();
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
        .find((m) => m.textContent === 'In review')!
        .click(),
    );
    await settle();
    expect(requests.find((r) => r.method === 'PUT')).toMatchObject({
      url: '/api/task-board/p1/bt2',
      body: { status: 'in_review', expectedUpdatedAt: 70 },
    });
  });

  it('shows the statuses you pick in the Tasks panel, several at once, and remembers them', async () => {
    await open();
    const tasks = await panel('Tasks');
    const pick = async (label: string) => {
      await act(async () =>
        [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')]
          .find((m) => m.textContent?.startsWith(label))!
          .click(),
      );
      await settle();
    };
    await act(async () =>
      tasks.querySelector<HTMLButtonElement>('button[aria-label="Statuses shown: Open tasks"]')!.click(),
    );
    await settle();
    // Done (lately) on, To do and In review off
    await pick('Done');
    await pick('To do');
    await pick('In review');
    expect([...tasks.querySelectorAll('section h3')].map((h) => h.textContent)).toEqual([
      'In progress1',
      'Blocked0',
      'Done1',
    ]);
    expect(tasks.textContent).toContain('Bake bread');
    // (done longer ago than 14 days: left out)
    expect(tasks.textContent).not.toContain('Old');
    expect(JSON.parse(localStorage.getItem('dash-overview-task-statuses')!)).toEqual([
      'in_progress',
      'blocked',
      'done',
    ]);
  });

  it('moves a task to another status when its card is dragged there', async () => {
    await open();
    const tasks = await panel('Tasks');
    const dragEvent = (kind: string) => {
      const e = new DragEvent(kind, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', {
        value: { effectAllowed: '', dropEffect: '', types: [], setData: () => {}, setDragImage: () => {} },
      });
      return e;
    };
    const review = tasks.querySelector<HTMLElement>('section[data-status="in_review"]')!;
    await act(async () => tasks.querySelector('[data-task-id="p1/bt2"]')!.dispatchEvent(dragEvent('dragstart')));
    expect(review.textContent).toContain('Drop here');
    await act(async () => review.dispatchEvent(dragEvent('dragover')));
    await act(async () => review.dispatchEvent(dragEvent('drop')));
    await settle();
    expect(requests.find((r) => r.method === 'PUT')).toMatchObject({
      url: '/api/task-board/p1/bt2',
      body: { status: 'in_review', expectedUpdatedAt: 70 },
    });
  });

  it('lets you drag the list and the panel wider or narrower, and remembers it', async () => {
    await open();
    await panel('Tasks');
    const list = el.querySelector<HTMLElement>('.overview-sidebar')!;
    const handle = el.querySelector<HTMLElement>('[role="separator"][aria-label="List width"]')!;
    expect(list.style.getPropertyValue('--side-w')).toBe('320px');
    await act(
      async () => void handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })),
    );
    expect(list.style.getPropertyValue('--side-w')).toBe('336px');
    await act(async () => {
      handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 400, bubbles: true }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 2000 }));
      document.dispatchEvent(new PointerEvent('pointerup', {}));
    });
    // (no wider than 560)
    expect(list.style.getPropertyValue('--side-w')).toBe('560px');
    expect(localStorage.getItem('dash-overview-side-width')).toBe('560');
    await act(async () => void handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(list.style.getPropertyValue('--side-w')).toBe('320px');
    // the panel's line is at its left: dragging left widens it
    const side = el.querySelector<HTMLElement>('.overview-panel')!;
    const edge = el.querySelector<HTMLElement>('[role="separator"][aria-label="Panel width"]')!;
    await act(async () => {
      edge.dispatchEvent(new PointerEvent('pointerdown', { clientX: 1000, bubbles: true }));
      document.dispatchEvent(new PointerEvent('pointermove', { clientX: 900 }));
      document.dispatchEvent(new PointerEvent('pointerup', {}));
    });
    expect(side.style.getPropertyValue('--panel-w')).toBe('484px');
  });

  it('marks where a dragged pane will go: before, after, or stacked under another', async () => {
    await open();
    for (const name of ['Writer', 'Baker']) await act(async () => row('Bakery', name).click());
    const drag = (kind: string) => {
      const e = new DragEvent(kind, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', {
        value: {
          effectAllowed: '',
          dropEffect: '',
          types: ['text/x-overview-pane'],
          setData: () => {},
          getData: () => 'p1/agent:baker',
          setDragImage: () => {},
        },
      });
      return e;
    };
    const writer = el.querySelector<HTMLElement>('[data-pane="p1/agent:writer"]')!;
    const baker = el.querySelector<HTMLElement>('[data-pane="p1/agent:baker"]')!;
    await act(async () => baker.querySelector('header')!.dispatchEvent(drag('dragstart')));
    expect(baker.className).toContain('opacity-40');
    // (no layout here: the pointer is at the pane's middle, so it stacks)
    await act(async () => writer.dispatchEvent(drag('dragover')));
    expect(writer.querySelector('.drop-mark')!.textContent).toBe('Stack under Writer');
    // the dragged pane shows no mark of its own
    await act(async () => baker.dispatchEvent(drag('dragover')));
    expect(baker.querySelector('.drop-mark')).toBeNull();
    await act(async () => writer.dispatchEvent(drag('drop')));
    await act(async () => baker.querySelector('header')!.dispatchEvent(drag('dragend')));
    expect(el.querySelectorAll('.strip-column')).toHaveLength(1);
    expect(el.querySelector('.drop-mark')).toBeNull();
  });

  it('browses a project folder in the Files panel and opens it in VS Code', async () => {
    localStorage.setItem('dash-overview-scope', 'here');
    await open();
    const files = await panel('Files');
    expect([...files.querySelectorAll('.overview-files li')].map((li) => li.textContent)).toEqual([
      'notes',
      'PROJECT.md12 B',
    ]);
    await act(async () => [...files.querySelectorAll<HTMLButtonElement>('.overview-files button')][0].click());
    await settle();
    expect(files.textContent).toContain('idea.md2 KB');
    expect(files.querySelector('nav[aria-label="Folder"]')!.textContent).toBe('Bakerynotes');
    await act(async () =>
      [...files.querySelectorAll<HTMLButtonElement>('button')]
        .find((b) => b.textContent === 'Open in VS Code')!
        .click(),
    );
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/projects/p1/open',
      body: { path: 'notes', app: 'vscode' },
    });
  });

  it('moves the Files panel to a project the scope shows when the scope changes', async () => {
    await open();
    const files = await panel('Files');
    expect(files.querySelector('nav[aria-label="Folder"]')!.textContent).toBe('Bakery');
    await act(async () => [...files.querySelectorAll<HTMLButtonElement>('.overview-files button')][0].click());
    await settle();
    // only the podcast now: its folder, from the top
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label^="Show:"]')!.click());
    await settle();
    await act(async () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
        .find((c) => c.textContent!.trim() === 'Podcast')!
        .click(),
    );
    await settle();
    const now = el.querySelector<HTMLElement>('.overview-panel[aria-label="Files"]')!;
    expect(now.querySelector('nav[aria-label="Folder"]')!.textContent).toBe('Podcast');
    expect([...now.querySelectorAll('.overview-files li')].map((li) => li.textContent)).toEqual(['episodes']);
    expect(requests.some((r) => r.url === '/api/projects/p2/folder?path=')).toBe(true);
  });

  it("opens a pane's folder in VS Code: the agent's workspace, in its own project", async () => {
    await open();
    await act(async () => row('Podcast', 'Host').click());
    await act(
      async () =>
        void document.dispatchEvent(
          new KeyboardEvent('keydown', { code: 'KeyO', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }),
        ),
    );
    await settle();
    expect(requests.at(-1)).toMatchObject({
      method: 'POST',
      url: '/api/p/p2/agents/host/open-workspace',
      body: { app: 'vscode' },
    });
  });

  it('keeps your own order of sessions when you drag them (Sort: Your order), and remembers it', async () => {
    localStorage.setItem('dash-overview-sort', 'mine');
    await open();
    const li = (name: string) => row('Bakery', name).closest('li')!;
    const before = rows('Bakery');
    // a drag carries what is dragged (happy-dom leaves dataTransfer out)
    const carried = new Map<string, string>();
    const dragEvent = (type: string) => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', {
        value: {
          effectAllowed: '',
          types: [...carried.keys()],
          setData: (k: string, v: string) => carried.set(k, v),
          getData: (k: string) => carried.get(k) || '',
        },
      });
      Object.defineProperty(e, 'clientY', { value: 0 });
      return e;
    };
    await act(async () => void li('The Brain').dispatchEvent(dragEvent('dragstart')));
    await act(async () => void li(before[0]).dispatchEvent(dragEvent('dragover')));
    await act(async () => void li(before[0]).dispatchEvent(dragEvent('drop')));
    expect(rows('Bakery')[0]).toBe('The Brain');
    act(() => overview.unmount());
    await open();
    expect(rows('Bakery')[0]).toBe('The Brain');
    // other sorts don't drag
    localStorage.setItem('dash-overview-sort', 'name');
    act(() => overview.unmount());
    await open();
    expect(li('Writer').getAttribute('draggable')).toBeNull();
  });
});
