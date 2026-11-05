import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountReact } from '../../web/ui/react.tsx';
import { GatewayOutboxDeliveryView } from '../../web/views/gateway-outbox-delivery.tsx';
import type { GatewayOutboxDeliveryReview } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement; let unmount: () => void; let preview: GatewayOutboxDeliveryReview; let failure: string; let alive: boolean;
let calls: { url: string; method: string; body: Record<string, unknown> }[];
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 35)));
const button = (label: string, root: ParentNode = host) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!;
const click = (label: string, root: ParentNode = host) => act(async () => button(label, root).click());
beforeEach(() => {
  document.body.innerHTML = '<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>'; host = document.getElementById('view')!;
  preview = { revision: 'a'.repeat(64), recipient: { platform: 'telegram', instanceName: 'Research bot', accountId: '999', conversationId: '-100', threadId: '7', sourceMessageId: '42', sender: 'Alice' },
    paused: true, reason: '', needsPrepare: false, canRetry: true, retryReason: '', nextIndex: 1, canFinish: true, reviewHeld: false,
    parts: [{ text: 'Confirmed prefix', status: 'sent', attempts: 1, remoteId: 'confirmed-prefix', canConfirm: false },
      { text: 'Exact uncertain text', status: 'uncertain', attempts: 1, canConfirm: true }, { text: 'Approved queued tail', status: 'pending', attempts: 0, canConfirm: false }] };
  calls = []; failure = ''; alive = true;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'; const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>; calls.push({ url, method, body });
    if (method === 'POST' && failure) return new Response(JSON.stringify({ error: failure }), { status: 409 });
    if (method === 'POST' && body.action === 'confirm') { preview.parts[1] = { ...preview.parts[1], status: 'sent', remoteId: String(body.remoteId), confirmedAt: 1700000000000, canConfirm: false }; preview.reviewHeld = true; preview.nextIndex = 2; preview.revision = 'b'.repeat(64); }
    if (method === 'POST' && body.action === 'retry') { preview.parts[preview.nextIndex!] = { ...preview.parts[preview.nextIndex!], status: 'pending' }; preview.reviewHeld = false; preview.canRetry = false; preview.retryReason = 'Remaining parts are queued. Enable this instance when ready.'; }
    if (url.endsWith('/prepare')) { preview.needsPrepare = false; preview.reason = ''; preview.parts[1] = { ...preview.parts[1], status: 'uncertain', canConfirm: !preview.removed }; preview.canRetry = !preview.removed; preview.canFinish = true; preview.revision = 'c'.repeat(64); }
    if (url.endsWith('/gateway-finish') && method === 'POST') { preview.canFinish = false; preview.closedAt = 1700000000000; preview.reason = 'Delivery was finished locally and cannot be reopened.'; preview.revision = 'd'.repeat(64); }
    return new Response(JSON.stringify(preview));
  });
});
afterEach(async () => { act(() => unmount?.()); await act(() => new Promise((resolve) => setTimeout(resolve, 510))); vi.unstubAllGlobals(); });
async function open() { await act(async () => { unmount = mountReact(host, <GatewayOutboxDeliveryView id="post-1" instanceId="gateway-1" close={() => {}} changed={() => {}} alive={() => alive} />).unmount; }); await settle(); }
async function choosePart() {
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Outbox part to confirm"]')!.click()); await settle();
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.trim() === 'Part 2')!.click()); await settle();
}
async function typeId(value: string) { await act(async () => { const input = host.querySelector('[aria-label="Outbox messaging-app ID"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); }); }

it('loads saved delivery metadata without preparing or changing receipts, and forces an explicit part choice', async () => {
  await open(); expect(calls.every((call) => call.method === 'GET' && call.url === '/api/outbox/post-1/gateway-delivery')).toBe(true);
  expect(host.textContent).toContain('Research bot'); expect(host.textContent).toContain('Exact uncertain text'); expect(host.textContent).toContain('confirmed-prefix'); expect(button('Record confirmed delivery').disabled).toBe(true);
  expect(host.querySelector('[aria-label="Outbox part to confirm"]')!.textContent).toContain('Choose an uncertain part'); await typeId('checked-id'); expect(button('Record confirmed delivery').disabled).toBe(true);
});

it('records only the selected uncertain part and keeps the remaining tail waiting for explicit continuation', async () => {
  await open(); await choosePart(); await typeId(' checked-id '); await click('Record confirmed delivery'); await settle();
  expect(document.querySelector('.modal')!.textContent).toContain('only records your confirmation'); expect(calls.some((call) => call.method === 'POST')).toBe(false);
  await click('Record confirmed delivery', document.querySelector('.modal')!); await settle();
  expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ action: 'confirm', revision: 'a'.repeat(64), index: 1, remoteId: 'checked-id', acknowledgeChecked: true });
  expect(host.textContent).toContain('Confirmation recorded locally'); expect(host.textContent).toContain('Confirmed locally'); expect(host.textContent).toContain('did not release'); expect(button('Continue remaining delivery').disabled).toBe(false);
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
});

it('requires a duplicate warning for retry and queues the current suffix without enabling the instance', async () => {
  await open(); await click('Retry remaining delivery'); await settle(); const modal = document.querySelector('.modal')!;
  expect(modal.textContent).toContain('Retrying can send a duplicate'); expect(modal.textContent).toContain('Confirmed parts will not be resent'); expect(modal.textContent).toContain('instance stays paused');
  await click('Queue retry', modal); await settle();
  expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ action: 'retry', revision: 'a'.repeat(64), index: 1, acknowledgeRemaining: true, acknowledgePossibleDuplicate: true });
  expect(host.textContent).toContain('Remaining parts queued'); expect(calls.some((call) => call.url.includes('/gateways/'))).toBe(false);
});

it('prepares interrupted receipts explicitly and uses the fresh revision for review', async () => {
  preview.needsPrepare = true; preview.canRetry = false; preview.reason = 'Recover interrupted receipts.'; preview.parts[1].status = 'sending'; preview.parts[1].canConfirm = false;
  await open(); expect(calls.some((call) => call.method === 'POST')).toBe(false); await click('Recover interrupted receipts'); await settle();
  expect(calls.find((call) => call.method === 'POST')!.url).toBe('/api/outbox/post-1/gateway-delivery/prepare'); expect(host.textContent).toContain('Interrupted sends are now uncertain');
  await click('Retry remaining delivery'); await settle(); await click('Queue retry', document.querySelector('.modal')!); await settle();
  expect(calls.filter((call) => call.method === 'POST')[1].body.revision).toBe('c'.repeat(64));
});

it('keeps cancellation, stale errors, double clicks and late unmounted confirmations from silently retrying', async () => {
  await open(); await act(async () => { button('Retry remaining delivery').click(); button('Retry remaining delivery').click(); }); await settle();
  expect(document.querySelectorAll('.modal')).toHaveLength(1); await click('Cancel', document.querySelector('.modal')!); await settle(); expect(calls.some((call) => call.method === 'POST')).toBe(false);
  await act(() => new Promise((resolve) => setTimeout(resolve, 510))); failure = 'The original gateway setup changed.';
  await click('Retry remaining delivery'); await settle(); await click('Queue retry', document.querySelector('.modal')!); await settle(); expect(host.querySelector('[role="alert"]')!.textContent).toContain('setup changed');
  await act(() => new Promise((resolve) => setTimeout(resolve, 510))); failure = ''; const before = calls.filter((call) => call.method === 'POST').length;
  await click('Retry remaining delivery'); await settle(); alive = false; await click('Queue retry', document.querySelector('.modal')!); await settle(); expect(calls.filter((call) => call.method === 'POST')).toHaveLength(before);
});

it('makes enabled and closed history read-only while retaining confirmed and uncertain evidence', async () => {
  preview.paused = false; preview.canRetry = false; preview.canFinish = false; preview.reason = 'Pause this gateway before reviewing delivery.'; preview.parts[1].canConfirm = false; await open();
  expect(button('Retry remaining delivery').disabled).toBe(true); expect(button('Record confirmed delivery')).toBeUndefined(); expect(button('Finish locally')).toBeUndefined();
  act(() => unmount()); preview.paused = true; preview.closedAt = 1700000000000; preview.reason = 'Delivery was finished locally and cannot be reopened.'; await open();
  expect(host.textContent).toContain('cannot be reopened'); expect(host.textContent).toContain('confirmed-prefix'); expect(host.textContent).toContain('Delivery uncertain'); expect(button('Retry remaining delivery')).toBeUndefined();
});

it('reads removed delivery metadata and links its saved history without offering retry or manual confirmation', async () => {
  preview.removed = true; preview.paused = false; preview.canRetry = false; preview.parts[1].canConfirm = false; await open();
  expect(host.textContent).toContain('belongs to a removed instance'); expect(host.textContent).toContain('confirmed-prefix'); expect(button('Retry remaining delivery')).toBeUndefined(); expect(button('Record confirmed delivery')).toBeUndefined(); expect(button('Open this gateway')).toBeUndefined();
  expect(host.querySelector('a')?.getAttribute('href')).toBe('#/settings?tab=gateways&retired=gateway-1'); expect(calls.every((call) => call.method === 'GET')).toBe(true);
});

it('recovers removed in-flight receipts with the displayed revision and finishes using the fresh revision', async () => {
  preview.removed = true; preview.paused = false; preview.canRetry = false; preview.needsPrepare = true; preview.canFinish = false; preview.parts[1] = { ...preview.parts[1], status: 'sending', canConfirm: false };
  await open(); await click('Recover interrupted receipts'); await settle(); expect(calls.find((call) => call.method === 'POST')).toMatchObject({ url: '/api/outbox/post-1/gateway-delivery/prepare', body: { revision: 'a'.repeat(64) } });
  await click('Finish locally'); await settle(); expect(document.querySelector('.modal')!.textContent).toContain('removed connection stays blocked'); expect(document.querySelector('.modal')!.textContent).toContain('Research bot');
  await click('Finish locally', document.querySelector('.modal')!); await settle();
  expect(calls.filter((call) => call.method === 'POST').at(-1)).toEqual({ url: '/api/outbox/post-1/gateway-finish', method: 'POST', body: { revision: 'c'.repeat(64), acknowledgeNoSend: true } });
  expect(host.textContent).toContain('Finished locally'); expect(host.textContent).toContain('confirmed-prefix'); expect(host.textContent).toContain('Delivery uncertain'); expect(button('Finish locally')).toBeUndefined(); expect(button('Retry remaining delivery')).toBeUndefined();
});

it.each(['unfinished removal', 'missing removal record'] as const)('keeps %s read-only without losing saved evidence', async (reason) => {
  preview.removed = true; preview.paused = false; preview.canFinish = false; preview.canRetry = false; preview.parts[1].canConfirm = false; preview.reason = reason;
  await open(); expect(host.textContent).toContain(reason); expect(host.textContent).toContain('Exact uncertain text'); expect(button('Finish locally')).toBeUndefined(); expect(button('Recover interrupted receipts')).toBeUndefined(); expect(calls.every((call) => call.method === 'GET')).toBe(true);
});

it('guards removed-delivery cancellation, duplicate confirmations and an unmounted parent', async () => {
  preview.removed = true; preview.canRetry = false; preview.parts[1].canConfirm = false; await open();
  await act(async () => { button('Finish locally').click(); button('Finish locally').click(); }); await settle(); expect(document.querySelectorAll('.modal')).toHaveLength(1); await click('Cancel', document.querySelector('.modal')!); await settle(); expect(calls.some((call) => call.method === 'POST')).toBe(false);
  await act(() => new Promise((resolve) => setTimeout(resolve, 510))); await click('Finish locally'); await settle(); alive = false; await click('Finish locally', document.querySelector('.modal')!); await settle(); expect(calls.some((call) => call.method === 'POST')).toBe(false);
});
