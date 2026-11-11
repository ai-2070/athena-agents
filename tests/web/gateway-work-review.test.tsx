import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountReact } from '../../web/ui/react.tsx';
import { GatewayWorkReviewView } from '../../web/views/gateway-work-review.tsx';
import type { GatewayInstance, GatewayWorkReview } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const instance: GatewayInstance = {
  id: 'g1',
  name: 'Customer support',
  platform: 'telegram',
  accountId: '999',
  projectId: 'p1',
  target: { kind: 'brain' },
  senderPolicy: { platform: 'telegram', allowedUserIds: ['123'] },
  scope: { directMessages: true, conversationIds: [], guildIds: [] },
  fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 },
  enabled: false,
  routeGeneration: 1,
  createdAt: 1,
  updatedAt: 1,
};
let host: HTMLElement;
let unmount: () => void;
let preview: GatewayWorkReview;
let failure: string;
let close: () => void;
let calls: { url: string; method: string; body: Record<string, unknown> }[];
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const button = (label: string, root: ParentNode = host) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label)!;
const click = (label: string, root: ParentNode = host) => act(async () => button(label, root).click());
beforeEach(() => {
  document.body.innerHTML = '<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>';
  host = document.getElementById('view')!;
  preview = {
    revision: 'a'.repeat(64),
    reason: '',
    canKeep: true,
    needsPrepare: false,
    heldRequests: 2,
    operationId: 'original-operation',
    source: {
      platform: 'telegram',
      actor: 'Alice',
      conversationId: '456',
      threadId: '7',
      messageId: '1',
      projectId: 'pinned-project',
      target: { kind: 'agent', id: 'pinned-agent' },
    },
    native: {
      state: 'needs-review',
      runId: 'original-run',
      briefId: 'original-brief',
      conversation: {
        kind: 'agent',
        agentId: 'pinned-agent',
        chatId: 'private-chat',
        conversationId: 'private-binding',
        projectId: 'pinned-project',
        sender: 'Alice',
      },
    },
  };
  calls = [];
  failure = '';
  close = vi.fn();
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url, method, body });
    if (failure) return new Response(JSON.stringify({ error: failure }), { status: 409 });
    if (url.endsWith('/keep'))
      preview = {
        ...preview,
        canKeep: false,
        keptAt: 1700000000000,
        reason: 'This request is kept in Athena. It cannot be tracked, replied to or restarted by this gateway.',
      };
    if (url.endsWith('/prepare')) preview = { ...preview, needsPrepare: false, canKeep: true, reason: '' };
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
      <GatewayWorkReviewView
        instance={{ ...instance, enabled }}
        eventId="event-1"
        close={close}
        changed={async () => {}}
      />,
    ).unmount;
  });
  await settle();
}

it('loads saved source and native identifiers without checking or changing the native run', async () => {
  await open();
  expect(
    calls.every((item) => item.method === 'GET' && item.url === '/api/gateways/g1/inbox/event-1/work-review'),
  ).toBe(true);
  expect(host.textContent).toContain('pinned-project');
  expect(host.textContent).toContain('pinned-agent');
  expect(host.textContent).toContain('original-operation');
  expect(host.textContent).toContain('original-run');
  expect(host.textContent).toContain('not a live native status check');
  expect(host.textContent).toContain('2 other saved requests');
  expect(host.querySelector('input')).toBeNull();
  await click('Back to inbox');
  expect(close).toHaveBeenCalledOnce();
});
it('requires confirmation of still-running native work, no gateway reply and a separate conversation before keeping', async () => {
  await open();
  await click('Keep work in Athena');
  await settle();
  const modal = document.querySelector('.modal')!;
  expect(modal.textContent).toContain('chat 456, message 1');
  expect(modal.textContent).toContain('Native work may still be running');
  expect(modal.textContent).toContain('does not stop it');
  expect(modal.textContent).toContain('separate private conversation');
  expect(modal.textContent).toContain('cannot be undone');
  expect(calls.filter((item) => item.method === 'POST')).toHaveLength(0);
  await click('Keep work in Athena', modal);
  await settle();
  expect(calls.filter((item) => item.method === 'POST')).toEqual([
    {
      url: '/api/gateways/g1/inbox/event-1/work-review/keep',
      method: 'POST',
      body: {
        revision: 'a'.repeat(64),
        acknowledgeMayStillRun: true,
        acknowledgeFreshConversation: true,
        acknowledgeNoReply: true,
      },
    },
  ]);
  expect(host.textContent).toContain('Work kept in Athena');
  expect(host.textContent).toContain('original-run');
  expect(host.textContent).toContain('still paused');
  expect(button('Keep work in Athena')).toBeUndefined();
});
it('classifies interrupted receipts only after an explicit action and disables keeping while enabled', async () => {
  preview = {
    ...preview,
    canKeep: false,
    needsPrepare: true,
    reason: 'Recover interrupted receipts before keeping this work in Athena.',
  };
  await open();
  expect(calls.every((item) => item.method === 'GET')).toBe(true);
  await click('Recover interrupted receipts');
  await settle();
  expect(calls.filter((item) => item.method === 'POST')[0]).toMatchObject({
    url: '/api/gateways/g1/inbox/event-1/work-review/prepare',
  });
  act(() => unmount());
  await open(true);
  expect(button('Keep work in Athena').disabled).toBe(true);
});
it('shows ambiguous reservations without inventing native admission or completion', async () => {
  delete preview.native;
  await open();
  expect(host.textContent).toContain('Reservation only');
  expect(host.textContent).toContain('original-operation');
  expect(host.textContent).not.toContain('original-run');
});
it('cancels, prevents duplicate clicks and cannot confirm after the panel unmounts', async () => {
  await open();
  await click('Keep work in Athena');
  await settle();
  await click('Cancel', document.querySelector('.modal')!);
  await settle();
  expect(calls.every((item) => item.method === 'GET')).toBe(true);
  const keep = button('Keep work in Athena');
  await act(async () => {
    keep.click();
    keep.click();
  });
  await settle();
  act(() => unmount());
  await click('Keep work in Athena', document.querySelector('.modal')!);
  await settle();
  expect(calls.every((item) => item.method === 'GET')).toBe(true);
});
it('reports stale and load failures without claiming success, and can reload', async () => {
  await open();
  failure = 'Saved work changed. Reload receipts.';
  await click('Keep work in Athena');
  await settle();
  await click('Keep work in Athena', document.querySelector('.modal')!);
  await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Saved work changed');
  expect(host.querySelector('[role="status"]')).toBeNull();
  failure = '';
  await click('Reload receipts');
  await settle();
  expect(button('Keep work in Athena')).toBeDefined();
});
