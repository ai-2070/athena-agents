// The Overview page: every project's sessions in one sidebar, sorted Needs you first, with pins, a scope and search;
// what needs you and what works; and a session of another project opened after asking.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, state } from '../../web/core.ts';
import * as overview from '../../web/views/overview.tsx';
import type { AppState, OverviewData, OverviewSession } from '../../shared/types.ts';

const opened = vi.hoisted(() => ({ chats: [] as string[], dock: 0 }));
vi.mock('../../web/chatwin.tsx', () => ({ openChat: (kind: string, id: string) => { opened.chats.push(`${kind}:${id}`); } }));
vi.mock('../../web/dock.tsx', () => ({ openDock: () => { opened.dock++; } }));

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
const row = (project: string, name: string) => [...group(project).querySelectorAll<HTMLButtonElement>('.session-open')].find((b) => b.querySelector('.session-name')!.textContent === name)!;

describe('the Overview', () => {
  it('lists every project\'s sessions, Needs you first, with what needs you and what works', async () => {
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

  it('opens a session of the open project in its chat window, and the Brain in its chat', async () => {
    await open();
    await act(async () => row('Bakery', 'Shop team').click());
    await act(async () => row('Bakery', 'The Brain').click());
    expect(opened.chats).toEqual(['team:t1']);
    expect(opened.dock).toBe(1);
    expect(requests.some((r) => r.url.includes('/activate'))).toBe(false);
  });

  it('asks before opening another project, then opens it and the session', async () => {
    await open();
    await act(async () => row('Podcast', 'Host').click());
    expect(document.querySelector('.modal')!.textContent).toContain('Open the project Podcast?');
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('.modal button')].find((b) => b.textContent === 'Open Podcast')!.click());
    await settle(80);
    expect(requests.find((r) => r.url === '/api/projects/p2/activate')).toMatchObject({ method: 'POST' });
    expect(opened.chats).toEqual(['agent:host']);
  });
});
