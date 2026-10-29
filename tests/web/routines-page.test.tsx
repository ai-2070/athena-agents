// The routine editor (React around the plain-DOM @ menu): mentioning, saving, running, the runs list.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import * as routines from '../../web/views/routines.tsx';
import type { AppState } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = (ms = 30) => act(() => new Promise((r) => setTimeout(r, ms)));

let requests: { method: string; url: string; body: unknown }[];
let el: HTMLElement;
const routine = { id: 'r1', name: 'Morning news', description: '', text: 'Find news.', schedule: { type: 'none' }, enabled: false, mentions: [] };
const run = { id: 'run1', routineId: 'r1', status: 'done', trigger: 'manual', createdAt: Date.now(), skills: [], targets: [{ kind: 'agent', id: 'a1', name: 'Writer', status: 'done', chatId: 'c1', output: '**Three stories.**' }] };

let runsData: unknown[];
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  requests = [];
  runsData = [run];
  state.data = { agents: [{ id: 'a1', name: 'Writer', emoji: '✍️', specialty: 'Posts' }] } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, url, body });
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url === '/api/routines/r1' && method === 'GET') return json(routine);
    if (url === '/api/routines/r1' && method === 'PUT') return json({ ...routine, ...body, mentions: [] });
    if (url === '/api/routines' && method === 'GET') return json([{ ...routine, schedule: { type: 'daily', time: '09:00' }, enabled: false }, { ...routine, id: 'r3', name: 'By hand' }]);
    if (url === '/api/routines' && method === 'POST') return json({ ...routine, ...body, id: 'r2', mentions: [] });
    if (url.startsWith('/api/routine-runs')) return json(runsData);
    if (url.startsWith('/api/skills')) return json({ skills: [], claude: [] });
    return json(url.includes('/workflows') ? [] : { ok: true });
  });
});
afterEach(() => {
  act(() => routines.unmount());
  vi.unstubAllGlobals();
  document.querySelectorAll('.rt-menu').forEach((m) => m.remove());
});

const open = async () => {
  await act(async () => routines.render(el, ['r1']));
  await settle(200);
};
const btn = (text: string) => [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const typeInto = (ta: HTMLTextAreaElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, text);
    ta.setSelectionRange(text.length, text.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('the routine editor', () => {
  it('@ offers agents to mention; picking one puts it in the text and under "Who does it"', async () => {
    await open();
    const ta = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="What to do"]')!;
    ta.focus();
    await typeInto(ta, 'Ask @Wr');
    const menu = document.querySelector('.rt-menu')!;
    expect([...menu.querySelectorAll('.rt-menu-item')].map((b) => b.textContent)).toEqual(['✍️WriterPosts']);
    await act(async () => ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    expect(ta.value).toBe('Ask @Writer ');
    expect(el.querySelector('.rt-who')!.textContent).toContain('Writer');
    expect(btn('Save').disabled).toBe(false);
  });

  it('saves what you changed, and Run now saves first', async () => {
    await open();
    const name = [...el.querySelectorAll('label.field')].find((f) => f.textContent?.startsWith('Name'))!.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Evening news');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => btn('Run now').click());
    await settle();
    const calls = requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url}`);
    expect(calls).toEqual(['PUT /api/routines/r1', 'POST /api/routines/r1/run']);
    expect(requests.find((r) => r.method === 'PUT')!.body).toMatchObject({ name: 'Evening news', text: 'Find news.', schedule: { type: 'none' } });
    expect(requests.find((r) => r.url === '/api/routines/r1/run')!.body).toEqual({ input: '' });
  });

  it('a new routine is a draft: nothing is saved until it has something to do, and Run now waits', async () => {
    await act(async () => routines.render(el, ['new']));
    await settle(100);
    expect(btn('Save').disabled).toBe(true);
    expect(btn('Run now').disabled).toBe(true);
    expect(el.textContent).not.toContain('Delete routine');
    const ta = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="What to do"]')!;
    await typeInto(ta, '   ');
    expect(btn('Save').disabled).toBe(true);
    await typeInto(ta, 'Find news.');
    expect(btn('Save').disabled).toBe(false);
    await act(async () => btn('Save').click());
    await settle();
    expect(requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.url}`)).toEqual(['POST /api/routines']);
    expect(requests.find((r) => r.method === 'POST')!.body).toMatchObject({ name: 'New routine', text: 'Find news.' });
    expect(location.hash).toBe('#/routines/r2');
  });

  it('a sliding switch turns the schedule on and off, and saves just that', async () => {
    await open();
    const sw = () => el.querySelector<HTMLElement>('.panel-head [role="switch"]')!;
    // Manual: nothing to switch
    expect(sw().hasAttribute('data-disabled')).toBe(true);
    const daily = [...el.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent === 'Daily')!;
    daily.focus();
    await act(async () => daily.click());
    expect(document.activeElement).toBe(daily);
    expect(el.querySelector('input[type="time"]')).not.toBeNull();
    expect(sw().hasAttribute('data-disabled')).toBe(false);
    expect(sw().getAttribute('aria-checked')).toBe('false');
    await act(async () => el.querySelector<HTMLElement>('.panel .toggle-text')!.click());
    await settle();
    expect(sw().getAttribute('aria-checked')).toBe('true');
    const put = requests.filter((r) => r.method === 'PUT');
    expect(put.at(-1)!.body).toEqual({ enabled: true });
  });

  it('on the list, every routine has an on/off switch that saves just that, and off blocks Run', async () => {
    await act(async () => routines.render(el, []));
    await settle(100);
    const cards = [...el.querySelectorAll<HTMLElement>('.skill-name')].map((a) => a.parentElement!.parentElement!.parentElement!);
    expect(cards.map((c) => c.querySelectorAll('[role="switch"]').length)).toEqual([1, 1]);
    const runBtn = (c: HTMLElement) => [...c.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Run')!;
    expect(runBtn(cards[0]).disabled).toBe(false);
    await act(async () => cards[0].querySelector<HTMLElement>('.toggle-text')!.click());
    await settle();
    expect(requests.filter((r) => r.method === 'PUT').map((r) => [r.url, r.body])).toEqual([['/api/routines/r1', { paused: true }]]);
    expect(runBtn(cards[0]).disabled).toBe(true);
    expect(cards[0].textContent).toContain('switched off');
  });

  it('the editor has a Routine on/off switch beside Save; off saves at once and blocks Run now', async () => {
    await open();
    const sw = el.querySelector<HTMLElement>('[role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await act(async () => [...el.querySelectorAll<HTMLElement>('.toggle-text')].find((t) => t.textContent === 'Routine on')!.click());
    await settle();
    expect(requests.filter((r) => r.method === 'PUT').at(-1)!.body).toEqual({ paused: true });
    expect(btn('Run now').disabled).toBe(true);
  });

  it('lists its runs, the newest open, with what each agent did', async () => {
    await open();
    const details = el.querySelector<HTMLDetailsElement>('details')!;
    expect(details.open).toBe(true);
    expect(details.textContent).toContain('Three stories.');
    expect(details.querySelector('strong')?.textContent).toBe('Three stories.');
    expect(details.querySelector('a[href="#/agents/a1/c1"]')).not.toBeNull();
  });

  it('keeps run details usable while stopping a running entry', async () => {
    runsData = [
      { ...run, id: 'running1', status: 'running', targets: [{ ...run.targets[0], status: 'running' }] },
      { ...run, id: 'running2', status: 'running' },
    ];
    await open();
    const details = [...el.querySelectorAll<HTMLDetailsElement>('details')];
    expect(details.map((item) => item.open)).toEqual([true, false]);
    await act(async () => details[0].parentElement!.querySelector<HTMLButtonElement>('button')!.click());
    expect(requests.some((r) => r.method === 'POST' && r.url === '/api/routine-runs/running1/stop')).toBe(true);
    expect(details[0].open).toBe(true);
    await act(async () => details[1].querySelector('summary')!.click());
    expect(details[1].open).toBe(true);
  });
});
