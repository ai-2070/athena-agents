// The Overview page: every project's sessions in one sidebar, sorted Needs you first, with pins, a scope and search;
// what needs you and what works; and a session of another project opened after asking.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, state } from '../../web/core.ts';
import { scopedPath } from '../../web/client/connection.ts';
import * as overview from '../../web/views/overview.tsx';
import type { AppState, OverviewData, OverviewSession } from '../../shared/types.ts';

const opened = vi.hoisted(() => ({ chats: [] as string[], dock: 0 }));
vi.mock('../../web/chatwin.tsx', () => ({ openChat: (kind: string, id: string) => { opened.chats.push(`${kind}:${id}`); } }));
vi.mock('../../web/dock.tsx', () => ({ openDock: () => { opened.dock++; } }));
// (stand-ins for the chats and terminals a pane shows: what matters here is the strip)
const drawn = vi.hoisted(() => ({ live: new Set<string>(), projects: [] as (string | undefined)[] }));
vi.mock('../../web/agentchat.tsx', () => ({ renderAgentChat: (el: HTMLElement, id: string, o: { projectId?: string } = {}) => ((el.textContent = `agent chat ${id}`), drawn.live.add(`agent:${id}`), drawn.projects.push(o.projectId), { focus() {}, destroy: () => drawn.live.delete(`agent:${id}`) }) }));
vi.mock('../../web/teamchat.tsx', () => ({ renderTeamChat: (el: HTMLElement, id: string) => ((el.textContent = `team chat ${id}`), drawn.live.add(`team:${id}`), { focus() {}, mention() {}, destroy: () => drawn.live.delete(`team:${id}`) }) }));
vi.mock('../../web/terminalview.tsx', async () => {
  const { createElement } = await import('react');
  return { XTerm: ({ id }: { id: string }) => createElement('div', { className: 'xterm-stand-in' }, `terminal ${id}`) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = (ms = 40) => act(() => new Promise((r) => setTimeout(r, ms)));
class FakeSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((m: MessageEvent<string>) => void) | null = null;
}

const now = Date.now();
const session = (over: Partial<OverviewSession>): OverviewSession => ({ kind: 'agent', id: 'x', name: 'X', status: 'idle', updatedAt: now - 60_000, ...over });
let data: OverviewData;
let requests: { method: string; url: string }[];
let activated = false;
let el: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  opened.chats = [];
  opened.dock = 0;
  drawn.projects = [];
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  requests = [];
  activated = false;
  data = {
    active: 'p1',
    projects: [
      { id: 'p1', name: 'Bakery', working: 1, needsYou: 1, boardOpen: 3, sessions: [
        session({ kind: 'brain', id: 'brain', name: 'The Brain', updatedAt: now - 10_000 }),
        session({ id: 'writer', name: 'Writer', emoji: '✍️', status: 'working', updatedAt: now - 5_000 }),
        session({ id: 'baker', name: 'Baker', status: 'needs-you', why: 'Approval: Run a command' }),
        session({ kind: 'team', id: 't1', name: 'Shop team', updatedAt: now - 1_000 }),
        session({ kind: 'terminal', id: 'term1', name: 'PowerShell', updatedAt: now - 2_000 }),
      ] },
      { id: 'p2', name: 'Podcast', working: 0, needsYou: 1, boardOpen: 0, sessions: [
        session({ id: 'host', name: 'Host' }),
        session({ kind: 'task', id: 'bt1', number: 4, name: 'Edit the intro', status: 'needs-you', why: 'Its work needs a look' }),
      ] },
    ],
  };
  state.data = { project: { id: 'p1', name: 'Bakery' }, agents: [], runs: [], approvals: [] } as unknown as AppState;
  vi.stubGlobal('WebSocket', FakeSocket);
  connectEvents();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    requests.push({ method: init.method || 'GET', url });
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url === '/api/overview') return json(data);
    if (url === '/api/projects/p2/activate') return (activated = true), json({ id: 'p2' });
    if (url === '/api/terminals' && init.method === 'POST') {
      data.projects[0].sessions.push(session({ kind: 'terminal', id: 'term2', name: 'PowerShell 2' }));
      return json({ id: 'term2', title: 'PowerShell 2' });
    }
    // (once opened, the page's state shows the podcast)
    if (url === '/api/state') return json({ ...state.data, project: activated ? { id: 'p2', name: 'Podcast' } : { id: 'p1', name: 'Bakery' } });
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
const row = (project: string, name: string) => [...group(project).querySelectorAll<HTMLButtonElement>('.session-open')].find((b) => b.querySelector('.session-name')!.textContent === name)!;

describe('the Overview', () => {
  it('lists every project\'s sessions, Needs you first, with what needs you and what works', async () => {
    await open();
    expect(rows('Bakery')).toEqual(['Baker', 'Writer', 'Shop team', 'PowerShell', 'The Brain']);
    expect(rows('Podcast')).toEqual(['#4 Edit the intro', 'Host']);
    expect(group('Bakery').querySelector('.session-status[aria-label="Working"]')).not.toBeNull();
    const needs = el.querySelector<HTMLElement>('section[aria-label="Needs you"]')!;
    expect(needs.textContent).toContain('Baker · Bakery');
    expect(needs.textContent).toContain('Approval: Run a command');
    expect(needs.textContent).toContain('#4 Edit the intro · Podcast');
    expect(el.querySelector('section[aria-label="Working now"]')!.textContent).toContain('Writer');
    expect(el.querySelector('.overview-status')!.textContent).toContain('2 need you');
    expect(el.querySelector('.overview-status')!.textContent).toContain('1 of 5 working');
    expect(el.textContent).toContain('Click an agent, a team or a terminal, of any project, to open it here.');
    expect(el.querySelector('.overview-status')!.textContent).toContain('2 projects');
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

  it('opens the open project\'s chats and terminals as panes side by side, the Brain in its chat', async () => {
    await open();
    await act(async () => row('Bakery', 'Writer').click());
    await act(async () => row('Bakery', 'Shop team').click());
    await act(async () => row('Bakery', 'PowerShell').click());
    await settle();
    expect(panes()).toEqual(['Writer', 'Shop team', 'PowerShell']);
    expect(el.querySelector('[data-pane="p1/agent:writer"]')!.textContent).toContain('agent chat writer');
    expect(el.querySelector('[data-pane="p1/team:t1"]')!.textContent).toContain('team chat t1');
    expect(el.querySelector('[data-pane="p1/terminal:term1"]')!.textContent).toContain('terminal term1');
    expect(el.querySelector('[data-pane="p1/agent:writer"]')!.textContent).toContain('Working');
    // the sidebar marks what is open, and opening one again only focuses it
    expect(row('Bakery', 'Writer').getAttribute('aria-current')).toBe('true');
    await act(async () => row('Bakery', 'Writer').click());
    expect(panes()).toEqual(['Writer', 'Shop team', 'PowerShell']);
    await act(async () => row('Bakery', 'The Brain').click());
    expect(opened.dock).toBe(1);
    expect(opened.chats).toEqual([]);
    expect(requests.some((r) => r.url.includes('/activate'))).toBe(false);
    // and it is all there again next time
    act(() => overview.unmount());
    await open();
    expect(panes()).toEqual(['Writer', 'Shop team', 'PowerShell']);
  });

  it('moves, stacks, pins and closes panes with Ctrl+Alt keys, and changes the columns per view', async () => {
    await open();
    for (const name of ['Writer', 'Shop team', 'Baker']) await act(async () => row('Bakery', name).click());
    expect(panes()).toEqual(['Writer', 'Shop team', 'Baker']);
    const key = (code: string, shiftKey = false) => act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { code, ctrlKey: true, altKey: true, shiftKey, bubbles: true, cancelable: true })));
    // Baker is in use: move it left, then stack it under the Writer
    await key('BracketLeft', true);
    expect(panes()).toEqual(['Writer', 'Baker', 'Shop team']);
    await key('KeyS');
    expect(el.querySelectorAll('.strip-column')).toHaveLength(2);
    expect([...el.querySelectorAll('.strip-column')[0].querySelectorAll('.strip-pane')].map((p) => p.getAttribute('aria-label'))).toEqual(['Writer', 'Baker']);
    // pane 3 (the team), pinned at the left
    await key('Digit3');
    await key('KeyP');
    expect(el.querySelector('.strip-column')!.getAttribute('data-pinned')).toBe('true');
    expect(panes()[0]).toBe('Shop team');
    await key('KeyW');
    expect(panes()).toEqual(['Writer', 'Baker']);
    expect(drawn.live.has('team:t1')).toBe(false);
    await key('Minus');
    expect(el.querySelector('.strip-per-view')!.textContent).toBe('1');
    await key('Equal');
    await key('Equal');
    expect(el.querySelector('.strip-per-view')!.textContent).toBe('3');
  });

  it('opens a new terminal in the project as a pane, and leaves out panes that are gone', async () => {
    await open();
    await act(async () => el.querySelector<HTMLButtonElement>('button[aria-label="New terminal in Bakery"]')!.click());
    await settle(400);
    expect(requests.find((r) => r.url === '/api/terminals')).toMatchObject({ method: 'POST' });
    expect(panes()).toEqual(['PowerShell 2']);
    // the terminal ended and was closed elsewhere: the pane goes once the overview says so
    data.projects[0].sessions = data.projects[0].sessions.filter((x) => x.id !== 'term2');
    await act(async () => row('Bakery', 'Writer').click());
    act(() => overview.unmount());
    await open();
    expect(panes()).toEqual(['Writer']);
  });

  it('opens another project\'s agent as a pane that talks to that project, and asks before opening its Brain', async () => {
    await open();
    await act(async () => row('Podcast', 'Host').click());
    await settle();
    expect(panes()).toEqual(['Host']);
    const pane = el.querySelector<HTMLElement>('[data-pane="p2/agent:host"]')!;
    expect(pane.textContent).toContain('Host · Podcast');
    expect(drawn.projects.at(-1)).toBe('p2');
    // while it shows, the Host's requests go to the podcast
    expect(scopedPath('/agents/host/chats')).toBe('/p/p2/agents/host/chats');
    expect(scopedPath('/agents/writer/chats')).toBe('/agents/writer/chats');
    expect(requests.some((r) => r.url.includes('/activate'))).toBe(false);
    await act(async () => [...pane.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === 'Actions for Host')!.click());
    await settle();
    // (no chat window for another project's agent)
    expect(document.body.textContent).not.toContain('Open in a chat window');
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })));
    await settle();
    expect(scopedPath('/agents/host/chats')).toBe('/agents/host/chats');

    // its Brain is the open project's thing: it asks first
    data.projects[1].sessions.push(session({ kind: 'brain', id: 'brain', name: 'The Brain' }));
    await act(async () => void (await import('../../web/core.ts')).refreshSoon(0));
    act(() => overview.unmount());
    await open();
    await act(async () => row('Podcast', 'The Brain').click());
    expect(document.querySelector('.modal')!.textContent).toContain('Open the project Podcast?');
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) => b.textContent === 'Open Podcast')!.click());
    await settle(80);
    expect(requests.find((r) => r.url === '/api/projects/p2/activate')).toMatchObject({ method: 'POST' });
    expect(opened.dock).toBe(1);
  });

  it('won\'t mix up an agent with its twin in the open project (a copied project has the same ids)', async () => {
    data.projects[1].sessions.push(session({ id: 'writer', name: 'Writer' }));
    await open();
    await act(async () => row('Podcast', 'Writer').click());
    expect(document.getElementById('toasts')!.textContent).toContain('Writer has a twin in the open project');
    expect(panes()).toEqual([]);
  });
});
