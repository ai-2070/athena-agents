import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountReact } from '../../web/ui/react.tsx';
import { WhatsAppSendersView } from '../../web/views/gateway-whatsapp-senders.tsx';
import type { GatewayInstance, GatewayWhatsAppSenders } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const PHONE = '+436641234567';
const instance: GatewayInstance = {
  id: 'g1',
  name: 'Customer support',
  platform: 'whatsapp',
  accountId: '9900000001',
  projectId: 'p1',
  target: { kind: 'brain' },
  senderPolicy: { platform: 'whatsapp', allowedPhones: [PHONE] },
  scope: { directMessages: true, conversationIds: [], guildIds: [] },
  fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 },
  enabled: false,
  routeGeneration: 1,
  createdAt: 1,
  updatedAt: 1,
};
let host: HTMLElement;
let unmount: () => void;
let preview: GatewayWhatsAppSenders;
let failure: string;
let calls: { url: string; method: string; body: Record<string, unknown> }[];
let edit: () => void;
let close: () => void;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const button = (label: string, root: ParentNode = host) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!;
const click = (label: string, root: ParentNode = host) => act(async () => button(label, root).click());
beforeEach(() => {
  document.body.innerHTML = '<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>';
  host = document.getElementById('view')!;
  preview = {
    reason: '',
    retired: 1,
    waiting: 0,
    unallowed: 1,
    senders: [
      {
        phone: PHONE,
        status: 'needs-review',
        changedAt: 1700000000000,
        revision: 'a'.repeat(64),
        requests: 2,
        reason: 'Review this verified change.',
      },
    ],
  };
  calls = [];
  failure = '';
  edit = vi.fn();
  close = vi.fn();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> });
    if (failure) return new Response(JSON.stringify({ error: failure }), { status: 409 });
    if (method === 'POST')
      preview.senders[0] = {
        ...preview.senders[0],
        status: 'reviewed',
        revision: null,
        reason: 'Ask this person to message again.',
      };
    return new Response(JSON.stringify(preview));
  });
});
afterEach(() => {
  act(() => unmount?.());
  vi.unstubAllGlobals();
});
async function open(enabled = false) {
  await act(async () => {
    unmount = mountReact(
      host,
      <WhatsAppSendersView instance={{ ...instance, enabled }} close={close} edit={edit} changed={async () => {}} />,
    ).unmount;
  });
  await settle();
}

it('loads local signed status, links the inbox and makes no review request automatically', async () => {
  await open();
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((item) => item.url === '/api/gateways/g1/whatsapp-senders' && item.method === 'GET')).toBe(true);
  expect(host.textContent).toContain('1 retired sender ID stays blocked');
  expect(host.textContent).toContain(PHONE);
  expect(host.textContent).toContain('Needs review');
  expect(host.querySelector('a')!.getAttribute('href')).toBe('#/settings?tab=gateways&inbox=g1');
  expect(host.querySelector('input')).toBeNull();
});
it('confirms a fresh conversation using only the phone and current opaque revision, without enabling', async () => {
  await open();
  await click('Review sender');
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([]);
  expect(document.querySelector('.modal')?.textContent).toContain(
    'Earlier requests, files and delivery receipts stay held',
  );
  await click('Review sender', document.querySelector('.modal')!);
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([
    {
      url: '/api/gateways/g1/whatsapp-senders/review',
      method: 'POST',
      body: { phone: PHONE, revision: 'a'.repeat(64), acknowledgeNewConversation: true },
    },
  ]);
  expect(host.querySelector('[role="status"]')?.textContent).toContain('message again');
  expect(host.textContent).toContain('Reviewed');
  expect(button('Enable')).toBeUndefined();
});
it('keeps missing proof and existing verified associations read-only, and requires pausing', async () => {
  preview.senders[0] = {
    ...preview.senders[0],
    status: 'needs-proof',
    revision: null,
    reason: 'Ask for signed phone proof.',
  };
  await open();
  expect(button('Review sender')).toBeUndefined();
  expect(host.textContent).toContain('Needs phone proof');
  act(() => unmount());
  preview.senders[0] = { ...preview.senders[0], status: 'verified', reason: 'No changed identity needs review.' };
  await open();
  expect(button('Review sender')).toBeUndefined();
  act(() => unmount());
  preview.senders[0].revision = 'b'.repeat(64);
  await open(true);
  expect(button('Review sender').disabled).toBe(true);
});
it('supports empty guards, editing allowed phones and returning to setup', async () => {
  preview.senders = [];
  await open();
  expect(host.textContent).toContain('No allowed phone numbers');
  await click('Edit allowed phones');
  expect(edit).toHaveBeenCalledOnce();
  await click('Back to relay setup');
  expect(close).toHaveBeenCalledOnce();
});
it('preserves the current row after stale failures and offers reload without claiming success', async () => {
  await open();
  failure = 'This sender changed';
  await click('Review sender');
  await settle();
  await click('Review sender', document.querySelector('.modal')!);
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('This sender changed');
  expect(host.textContent).not.toContain('Sender review saved');
  failure = '';
  await click('Reload senders');
  await settle();
  expect(button('Review sender')).toBeDefined();
});
it('cancels or closes during confirmation without posting and prevents duplicate submissions', async () => {
  await open();
  await click('Review sender');
  await settle();
  await click('Cancel', document.querySelector('.modal')!);
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([]);
  const review = button('Review sender');
  await act(async () => {
    review.click();
    review.click();
  });
  await settle();
  act(() => unmount());
  await click('Review sender', document.querySelector('.modal')!);
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([]);
});
