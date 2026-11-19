// The routine's Webhooks section, its dialogs, and Settings › Webhooks.
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountReact } from '../../web/ui/react.tsx';
import { pasteNote, RoutineWebhooks } from '../../web/views/routine-webhooks.tsx';
import { statusLine, WebhooksTab } from '../../web/views/webhooks.tsx';
import type { WebhookCreated, WebhookDelivery, WebhookListing, WebhookStatus } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hook: WebhookListing = {
  id: 'w1',
  name: 'Pushes',
  routineId: 'r1',
  enabled: true,
  verify: { preset: 'github' },
  events: ['push'],
  askFirst: true,
  perMinute: 20,
  atOnce: 3,
  keepBodies: true,
  addressHint: 'k3Fq',
  needsAddress: false,
  hasSecret: true,
  lastDelivery: null,
};
const delivery: WebhookDelivery = {
  id: 'd1',
  webhookId: 'w1',
  receivedAt: Date.now() - 60_000,
  status: 'refused',
  reason: 'The GitHub signature is wrong.',
  event: 'push',
  senderId: null,
  bytes: 2,
  headers: {},
  routineRunId: null,
};
let status: WebhookStatus;
let list: WebhookListing[];
let calls: { url: string; method: string; body: Record<string, unknown> }[];
let host: HTMLElement;
let unmount: () => void;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const buttons = (root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>('button')];
const button = (label: string, root: ParentNode = document) => buttons(root).find((b) => b.textContent === label);
const click = async (label: string, root: ParentNode = document) => {
  await act(async () => button(label, root)!.click());
  await settle();
};

beforeEach(() => {
  document.body.innerHTML = '<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>';
  host = document.getElementById('view')!;
  status = { on: true, listening: true, port: 4801, publicUrl: '', error: null };
  list = [hook];
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, method, body });
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    let out: unknown = { ok: true };
    if (path === '/api/webhooks' && method === 'GET') out = list;
    else if (path === '/api/webhooks' && method === 'POST') {
      const made: WebhookCreated = {
        webhook: { ...hook, id: 'w2', name: String(body.name), verify: body.verify as WebhookListing['verify'] },
        address: 'http://127.0.0.1:4801/h/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
        secret: 'f'.repeat(64),
      };
      out = made;
    } else if (path === '/api/webhooks-setup') out = method === 'PUT' ? (status = { ...status, ...body }) : status;
    else if (path === '/api/webhooks/w1/deliveries') out = [delivery];
    else if (path === '/api/webhooks/w1/test')
      out = { ...delivery, id: 'd2', status: 'skipped', reason: 'A test from Athena: every check passed.' };
    return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  act(() => unmount?.());
  vi.unstubAllGlobals();
});

async function openRoutine() {
  await act(async () => {
    unmount = mountReact(host, <RoutineWebhooks routineId="r1" routineName="On push" />).unmount;
  });
  await settle();
}

it("lists a routine's webhooks with what they check, and their deliveries", async () => {
  await openRoutine();
  expect(host.querySelector('.webhook-row')?.textContent).toContain('GitHub · address …k3Fq · push · asks first');
  await click('Deliveries');
  expect(host.querySelector('.webhook-delivery')?.textContent).toContain('Refused');
  expect(host.querySelector('.webhook-delivery')?.textContent).toContain('The GitHub signature is wrong.');
});

it('adds a webhook and shows its address and secret once, with where to paste them', async () => {
  list = [];
  await openRoutine();
  expect(host.textContent).toContain('No webhooks yet.');
  await click('Add webhook');
  const form = document.querySelector('.webhook-form')!;
  expect(form).toBeTruthy();
  expect((form.querySelector('input') as HTMLInputElement).value).toBe('On push webhook');
  await click('Add webhook', document.querySelector('.modal-foot')!);
  const sent = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/webhooks'))!;
  expect(sent.body).toMatchObject({ routineId: 'r1', verify: { preset: 'github' }, askFirst: true, keepBodies: true });
  expect(sent.body.secret).toBeUndefined();
  const made = document.querySelector('.webhook-made')!;
  expect(made.textContent).toContain('/h/abcdefghij');
  expect(made.textContent).toContain('f'.repeat(64));
  expect(made.textContent).toContain('Payload URL: the address');
  expect(made.textContent).toContain("This is this computer's address");
  expect(made.textContent).toContain('Shown only now');
});

it('says where each sender takes the address', () => {
  expect(pasteNote({ preset: 'stripe' })).toContain('Developers › Webhooks');
  expect(pasteNote({ preset: 'token', header: 'x-token' })).toContain('x-token header');
  expect(pasteNote({ preset: 'none' })).toContain('keep it private');
});

it('runs a test through every check and says it passed', async () => {
  await openRoutine();
  await click('Send a test');
  expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/webhooks/w1/test'))).toBe(true);
  expect(document.getElementById('toasts')?.textContent || document.body.textContent).toContain('The test passed');
});

it('warns when a webhook is on but nothing listens', async () => {
  status = { ...status, listening: false, error: 'Port 4801 is in use. Pick another port for webhooks.' };
  await openRoutine();
  expect(host.textContent).toContain('Port 4801 is in use');
});

it('Settings › Webhooks turns receiving on and off and saves the public address', async () => {
  await act(async () => {
    unmount = mountReact(host, <WebhooksTab />).unmount;
  });
  await settle();
  expect(host.textContent).toContain('Listening on 127.0.0.1:4801, for webhooks only.');
  const input = [...host.querySelectorAll<HTMLInputElement>('input')].find((i) => i.placeholder === 'https://…')!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, 'https://pc.tail1234.ts.net');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Save address');
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ publicUrl: 'https://pc.tail1234.ts.net' });
});

it('describes the listener in plain words', () => {
  expect(statusLine({ on: false, listening: false, port: 4801, publicUrl: '', error: null })).toMatch(/^Off/);
  expect(statusLine({ on: true, listening: false, port: 4801, publicUrl: '', error: null })).toMatch(/Starts when/);
});
