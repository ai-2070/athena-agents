import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountReact } from '../../web/ui/react.tsx';
import { TelegramSetupView } from '../../web/views/gateway-telegram-setup.tsx';
import type { GatewayInstance, GatewayTelegramSetup } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const instance: GatewayInstance = { id: 'g1', name: 'Customer support', platform: 'telegram', accountId: '999', projectId: 'p1', target: { kind: 'brain' }, senderPolicy: { platform: 'telegram', allowedUserIds: ['123'] }, scope: { directMessages: true, conversationIds: [], guildIds: [] }, fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 }, enabled: false, routeGeneration: 1, createdAt: 1, updatedAt: 1 };
let host: HTMLElement; let unmount: () => void; let preview: GatewayTelegramSetup; let failure: string;
let calls: { url: string; method: string; body: Record<string, unknown> }[]; let close: () => void; let edit: () => void; let pause: () => Promise<void>;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const button = (label: string, root: ParentNode = host) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!;
const click = (label: string, root: ParentNode = host) => act(async () => button(label, root).click());
beforeEach(() => {
  document.body.innerHTML = '<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>'; host = document.getElementById('view')!;
  preview = { reason: 'Check setup to verify this bot and its current webhook.', revision: null, check: null, attempt: null, switches: 0 };
  calls = []; failure = ''; close = vi.fn(); edit = vi.fn(); pause = vi.fn(async () => {});
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'; const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>; calls.push({ url, method, body });
    if (failure) return new Response(JSON.stringify({ error: failure }), { status: 409 });
    if (method === 'POST' && url.endsWith('/check')) preview = { ...preview, reason: '', revision: 'a'.repeat(64), check: { at: 1700000000000, webhook: true, host: 'receiver.example', pendingUpdates: 7 } };
    if (method === 'POST' && url.endsWith('/switch')) preview = { ...preview, revision: null, check: { at: 1700000000001, webhook: false, pendingUpdates: 7 }, attempt: { at: 1700000000001, state: 'confirmed', checkedAt: 1700000000001 }, switches: 1 };
    return new Response(JSON.stringify(preview));
  });
});
afterEach(() => { act(() => unmount?.()); vi.unstubAllGlobals(); });
async function open(enabled = false) { await act(async () => { unmount = mountReact(host, <TelegramSetupView instance={{ ...instance, enabled }} close={close} edit={edit} pause={pause} changed={async () => {}} />).unmount; }); await settle(); }

it('loads only local status, checks only when asked, and exposes the host without a full webhook URL', async () => {
  await open(); expect(calls.every((item) => item.method === 'GET' && item.url === '/api/gateways/g1/telegram-setup')).toBe(true); expect(host.textContent).toContain('No saved check'); expect(button('Switch to polling')).toBeUndefined();
  await click('Check setup'); await settle(); expect(calls.filter((item) => item.method === 'POST')).toEqual([{ url: '/api/gateways/g1/telegram-setup/check', method: 'POST', body: {} }]);
  expect(host.textContent).toContain('receiver.example'); expect(host.textContent).toContain('7 updates were waiting'); expect(host.textContent).not.toContain('https://'); expect(host.querySelector('input')).toBeNull();
});
it('confirms the checked bot and host, preservation of updates and previous service shutdown before switching', async () => {
  await open(); await click('Check setup'); await settle(); await click('Switch to polling'); await settle(); const modal = document.querySelector('.modal')!;
  expect(modal.textContent).toContain('bot 999'); expect(modal.textContent).toContain('receiver.example'); expect(modal.textContent).toContain('Stop the other bot integration first'); expect(modal.textContent).toContain('pending updates will be kept');
  expect(calls.filter((item) => item.url.endsWith('/switch'))).toHaveLength(0); await click('Switch to polling', modal); await settle();
  expect(calls.filter((item) => item.url.endsWith('/switch'))).toEqual([{ url: '/api/gateways/g1/telegram-setup/switch', method: 'POST', body: { revision: 'a'.repeat(64), acknowledgeStopped: true, acknowledgeKeepUpdates: true } }]);
  expect(host.textContent).toContain('Polling verified'); expect(host.textContent).toContain('still paused'); expect(button('Switch to polling')).toBeUndefined(); expect(button('Enable')).toBeUndefined();
});
it('offers a pause instead of checking while enabled and keeps edit/back navigation local', async () => {
  await open(true); expect(button('Check setup')).toBeUndefined(); await click('Pause instance'); expect(pause).toHaveBeenCalledOnce(); expect(calls.every((item) => item.method === 'GET')).toBe(true);
  await click('Edit instance'); expect(edit).toHaveBeenCalledOnce(); await click('Back to gateways'); expect(close).toHaveBeenCalledOnce();
});
it('keeps an unconfirmed attempt held, showing explicit check without automatically retrying the switch', async () => {
  preview.attempt = { at: 1700000000000, state: 'started' }; preview.switches = 1; await open();
  expect(host.textContent).toContain('Needs check'); expect(host.textContent).toContain('will not retry it automatically'); expect(button('Switch to polling')).toBeUndefined(); expect(calls.every((item) => item.method === 'GET')).toBe(true);
});
it('cancels, ignores duplicate clicks, and never submits a confirmation after the panel closes', async () => {
  await open(); await click('Check setup'); await settle(); await click('Switch to polling'); await settle(); await click('Cancel', document.querySelector('.modal')!); await settle();
  expect(calls.filter((item) => item.url.endsWith('/switch'))).toHaveLength(0); const switchButton = button('Switch to polling'); await act(async () => { switchButton.click(); switchButton.click(); }); await settle();
  act(() => unmount()); await click('Switch to polling', document.querySelector('.modal')!); await settle(); expect(calls.filter((item) => item.url.endsWith('/switch'))).toHaveLength(0);
});
it('reports stale or failed requests, reloads local status and never claims an unsuccessful switch succeeded', async () => {
  await open(); await click('Check setup'); await settle(); failure = 'This webhook changed. Check setup again.'; await click('Switch to polling'); await settle(); await click('Switch to polling', document.querySelector('.modal')!); await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('webhook changed'); expect(host.querySelector('[role="status"]')).toBeNull(); failure = ''; await click('Reload status'); await settle(); expect(button('Switch to polling')).toBeDefined();
});
