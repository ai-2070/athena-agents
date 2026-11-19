// Settings › Gateways (React): the list with each bot's state, letting in someone it ignored, adding a bot (its
// token sent on its own, then turned on), and a failed message's Retry. Plus the sidebar's lines.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import * as settings from '../../web/views/setup.tsx';
import { gatewayStatusLinks } from '../../web/gateway-status.ts';
import type { AppState, GatewayListing, GatewayMessage } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

const gateway = (over: Partial<GatewayListing> = {}): GatewayListing => ({
  id: 'g1',
  platform: 'telegram',
  name: 'Phone',
  projectId: 'p1',
  target: { kind: 'brain' },
  users: ['42'],
  channels: [],
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  projectName: 'Home',
  targetName: 'Brain',
  credentials: { botToken: true, appToken: false },
  health: { status: 'connected', bot: '@athena_bot' },
  refused: [{ kind: 'user', id: '7', name: 'Bob', at: Date.now() }],
  ...over,
});
const failed: GatewayMessage = {
  id: 'm1',
  instanceId: 'g1',
  chatKey: '42',
  chatTitle: 'Ann',
  sourceId: '10',
  sender: { id: '42', name: 'Ann' },
  text: 'Summarize my notes',
  files: [{ name: 'notes.txt', path: 'C:\\up\\notes.txt', size: 9 }],
  status: 'failed',
  error: 'Telegram: Too Many Requests',
  answer: 'Here is the summary',
  sentParts: 0,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

let requests: { method: string; url: string; body: unknown }[];
let list: GatewayListing[];
let el: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  state.data = {
    settings: { look: {} },
    project: { id: 'p1', name: 'Home' },
    projects: [{ id: 'p1', name: 'Home' }],
  } as unknown as AppState;
  requests = [];
  list = [gateway()];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    requests.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : null });
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url === '/api/gateways' && method === 'GET') return json(list);
    if (url.startsWith('/api/gateways/targets'))
      return json({ agents: [{ id: 'a1', name: 'Writer' }], teams: [{ id: 't1', name: 'Crew' }] });
    if (url === '/api/gateways' && method === 'POST')
      return json({ ...gateway({ id: 'g2', enabled: false }), ...(JSON.parse(String(init.body)) as object) });
    if (url.endsWith('/enabled')) return json(gateway({ id: 'g2' }));
    if (url === '/api/gateways/g1/messages') return json([failed]);
    return json({ ok: true });
  });
});
afterEach(() => {
  act(() => settings.unmount());
  vi.unstubAllGlobals();
});
const open = async (hash = '#/settings?tab=gateways') => {
  location.hash = hash;
  await act(async () => settings.render(el));
  await settle();
};
const button = (text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;
const type = (input: HTMLInputElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('Settings › Gateways', () => {
  it('lists each bot with how it is doing, and lets in someone it ignored', async () => {
    await open();
    const row = el.querySelector('[data-gateway="g1"]')!;
    expect(row.textContent).toContain('Telegram · Home · answered by Brain');
    expect(row.textContent).toContain('Connected as @athena_bot');
    expect(row.textContent).toContain('Ignored Bob (user 7)');
    expect(row.querySelector('.gateway-logo svg')?.getAttribute('aria-label')).toBe('Telegram');
    expect(button('Slack').querySelector('.gateway-logo svg')?.getAttribute('aria-label')).toBe('Slack');
    await act(async () => button('Let them in').click());
    expect(requests.find((r) => r.url === '/api/gateways/g1/allow')?.body).toEqual({ kind: 'user', value: '7' });
  });

  it('adds a bot: saves it, sends the token on its own, and turns it on', async () => {
    list = [];
    await open();
    await act(async () => button('Telegram').click());
    await settle();
    expect(el.textContent).toContain('New Telegram gateway');
    expect(el.textContent).toContain('@BotFather');
    await type(el.querySelector<HTMLInputElement>('input[type="password"]')!, 'SECRET-TOKEN');
    await act(async () => button('Add and turn on').click());
    await settle();
    const save = requests.find((r) => r.url === '/api/gateways' && r.method === 'POST')!;
    expect(save.body).toMatchObject({ platform: 'telegram', projectId: 'p1', target: { kind: 'brain' }, users: [] });
    expect(JSON.stringify(save.body)).not.toContain('SECRET-TOKEN');
    expect(requests.find((r) => r.url === '/api/gateways/g2/tokens')?.body).toEqual({ botToken: 'SECRET-TOKEN' });
    expect(requests.find((r) => r.url === '/api/gateways/g2/enabled')?.body).toEqual({ enabled: true });
  });

  it("shows a bot's messages from its link, and retries a failed one", async () => {
    await open('#/settings?tab=gateways&messages=g1');
    expect(el.textContent).toContain('Messages · Phone');
    expect(el.textContent).toContain('Summarize my notes');
    expect(el.textContent).toContain('Telegram: Too Many Requests');
    expect(el.textContent).toContain('notes.txt');
    await act(async () => button('Retry').click());
    expect(requests.some((r) => r.url === '/api/gateways/g1/messages/m1/retry' && r.method === 'POST')).toBe(true);
  });
});

describe('the sidebar lines', () => {
  it('puts the ones needing you first and links to what to look at', () => {
    const lines = gatewayStatusLinks([
      { id: 'a', name: 'Alpha', platform: 'slack', projectName: 'P', status: 'connected', failed: 0 },
      { id: 'b', name: 'Beta', platform: 'telegram', projectName: 'P', status: 'connected', failed: 2 },
      { id: 'c', name: 'Gamma', platform: 'discord', projectName: 'P', status: 'error', failed: 0 },
    ]);
    expect(lines.map((l) => [l.label, l.value, l.dot])).toEqual([
      ['Beta', '2 failed', 'warn'],
      ['Gamma', 'not connected', 'warn'],
      ['Alpha', 'connected', 'on'],
    ]);
    expect(lines[0].href).toBe('#/settings?tab=gateways&messages=b');
    expect(lines[2].href).toBe('#/settings?tab=gateways&instance=a');
  });
});
