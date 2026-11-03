import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountReact } from '../../web/ui/react.tsx';
import { GatewayDeliveryReviewView } from '../../web/views/gateway-delivery-review.tsx';
import type { GatewayDeliveryReview, GatewayInstance } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const instance: GatewayInstance = { id: 'g1', name: 'Customer support', platform: 'telegram', accountId: '999', projectId: 'p1', target: { kind: 'brain' }, senderPolicy: { platform: 'telegram', allowedUserIds: ['123'] }, scope: { directMessages: true, conversationIds: [], guildIds: [] }, fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 }, enabled: false, routeGeneration: 1, createdAt: 1, updatedAt: 1 };
let host: HTMLElement; let unmount: () => void; let preview: GatewayDeliveryReview; let failure: string;
let calls: { url: string; method: string; body: Record<string, unknown> }[]; let close: () => void;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const button = (label: string, root: ParentNode = host) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!;
const click = (label: string, root: ParentNode = host) => act(async () => button(label, root).click());
beforeEach(() => {
  document.body.innerHTML = '<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>'; host = document.getElementById('view')!;
  preview = { revision: 'a'.repeat(64), reason: '', canFinish: true, needsPrepare: false, source: { platform: 'telegram', actor: 'Alice', conversationId: '456', threadId: '7', messageId: '1', projectId: 'pinned-project', target: { kind: 'agent', id: 'pinned-agent' } }, items: [
    { target: { kind: 'text', index: 0 }, label: 'Text part 1', text: 'Already delivered', status: 'sent', remoteId: 'confirmed-prefix', canConfirm: false },
    { target: { kind: 'text', index: 1 }, label: 'Text part 2', text: 'Uncertain answer', status: 'uncertain', canConfirm: true },
    { target: { kind: 'file', index: 0 }, label: 'report.txt', status: 'pending', canConfirm: false },
  ] };
  calls = []; failure = ''; close = vi.fn();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'; const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>; calls.push({ url, method, body });
    if (failure) return new Response(JSON.stringify({ error: failure }), { status: 409 });
    if (method === 'POST' && body.action === 'confirm') preview.items[1] = { ...preview.items[1], status: 'sent', remoteId: String(body.remoteId), confirmedAt: 1700000000000, canConfirm: false };
    if (method === 'POST' && body.action === 'finish-local') preview = { ...preview, canFinish: false, closedAt: 1700000000000, reason: 'Delivery was finished locally.', items: preview.items.map((item) => ({ ...item, canConfirm: false })) };
    if (url.endsWith('/prepare')) { preview.needsPrepare = false; preview.reason = ''; preview.items[1].canConfirm = true; }
    return new Response(JSON.stringify(preview));
  });
});
afterEach(() => { act(() => unmount?.()); vi.unstubAllGlobals(); });
async function open(enabled = false) { await act(async () => { unmount = mountReact(host, <GatewayDeliveryReviewView instance={{ ...instance, enabled }} eventId="event-1" close={close} changed={async () => {}} />).unmount; }); await settle(); }
async function type(value: string) { await act(async () => { const input = host.querySelector('[aria-label="Messaging app ID"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }

it('loads the original source and destination without automatically preparing or changing receipts', async () => {
  await open(); expect(calls.every((item) => item.method === 'GET' && item.url === '/api/gateways/g1/inbox/event-1/delivery-review')).toBe(true);
  expect(host.textContent).toContain('pinned-project'); expect(host.textContent).toContain('pinned-agent'); expect(host.textContent).toContain('confirmed-prefix');
  expect(host.querySelectorAll('details')).toHaveLength(2); expect(button('Record confirmed delivery').disabled).toBe(true); expect(button('Recover interrupted receipts')).toBeUndefined();
  await click('Back to inbox'); expect(close).toHaveBeenCalledOnce();
});
it('confirms the exact uncertain part after checking the app, with a revision and explicit acknowledgement', async () => {
  await open(); await type('external-456'); await click('Record confirmed delivery'); await settle(); expect(calls.filter((item) => item.method === 'POST')).toEqual([]);
  expect(document.querySelector('.modal')?.textContent).toContain('chat 456, message 1'); expect(document.querySelector('.modal')?.textContent).toContain('Text part 2');
  await click('Record confirmed delivery', document.querySelector('.modal')!); await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([{ url: '/api/gateways/g1/inbox/event-1/delivery-review', method: 'POST', body: { action: 'confirm', revision: 'a'.repeat(64), target: { kind: 'text', index: 1 }, remoteId: 'external-456', acknowledgeChecked: true } }]);
  expect(host.textContent).toContain('Confirmed locally'); expect(host.textContent).toContain('external-456'); expect(host.querySelector('input')).toBeNull();
});
it('explains irreversible local finish and keeps earlier statuses visible after saving', async () => {
  await open(); await click('Finish delivery locally'); await settle(); const modal = document.querySelector('.modal')!;
  expect(modal.textContent).toContain('cannot be reopened'); expect(modal.textContent).toContain('does not recall messages');
  await click('Finish delivery locally', modal); await settle(); expect(calls.filter((item) => item.method === 'POST')[0].body).toEqual({ action: 'finish-local', revision: 'a'.repeat(64), acknowledgeNoSend: true });
  expect(host.textContent).toContain('Delivery uncertain'); expect(host.textContent).toContain('Waiting'); expect(host.textContent).toContain('Delivery finished locally'); expect(button('Finish delivery locally')).toBeUndefined();
});
it('requires an explicit preparation action for interrupted receipts and disables actions while enabled', async () => {
  preview.needsPrepare = true; preview.reason = 'Recover interrupted receipts before reviewing their outcome.'; preview.items[1].canConfirm = false; preview.canFinish = false;
  await open(); expect(calls.every((item) => item.method === 'GET')).toBe(true); await click('Recover interrupted receipts'); await settle();
  expect(calls.filter((item) => item.method === 'POST')[0].url).toBe('/api/gateways/g1/inbox/event-1/delivery-review/prepare');
  act(() => unmount()); await open(true); await type('message-id'); expect(button('Record confirmed delivery').disabled).toBe(true);
});
it('cancels, prevents double clicks and refuses to submit after unmount during confirmation', async () => {
  await open(); await click('Finish delivery locally'); await settle(); await click('Cancel', document.querySelector('.modal')!); await settle(); expect(calls.every((item) => item.method === 'GET')).toBe(true);
  const finish = button('Finish delivery locally'); await act(async () => { finish.click(); finish.click(); }); await settle(); act(() => unmount());
  await click('Finish delivery locally', document.querySelector('.modal')!); await settle(); expect(calls.every((item) => item.method === 'GET')).toBe(true);
});
it('reports stale or load failures and offers reload without claiming success', async () => {
  await open(); failure = 'Saved work changed. Reload receipts.'; await click('Finish delivery locally'); await settle(); await click('Finish delivery locally', document.querySelector('.modal')!); await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Saved work changed'); expect(host.querySelector('[role="status"]')).toBeNull(); failure = ''; await click('Reload receipts'); await settle(); expect(button('Finish delivery locally')).toBeDefined();
});
