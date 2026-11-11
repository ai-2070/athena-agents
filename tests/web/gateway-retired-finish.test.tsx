import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountReact } from '../../web/ui/react.tsx';
import { GatewayRetiredFinishView } from '../../web/views/gateway-retired-finish.tsx';
import type { GatewayRetiredFinishReview } from '../../shared/types.ts';

let host: HTMLElement;
let unmount: () => void;
let preview: GatewayRetiredFinishReview;
let requests: { url: string; method: string; body: Record<string, unknown> }[];
let changed: () => Promise<void>;
let failRead: boolean;
let failSave: boolean;
let delayed: Promise<Response> | undefined;
const base = '/api/gateways/retired/removed-one/inbox/saved-one/local-finish';
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 25)));
const button = (name: string, root: ParentNode = host) =>
  [...root.querySelectorAll('button')].find((item) => item.textContent === name)!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
beforeEach(() => {
  document.body.innerHTML = '<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>';
  host = document.getElementById('view')!;
  requests = [];
  changed = vi.fn(async () => {});
  failRead = false;
  failSave = false;
  delayed = undefined;
  preview = {
    revision: 'a'.repeat(64),
    kind: 'delivery',
    canFinish: true,
    needsPrepare: false,
    reason: '',
    heldRequests: 0,
    source: {
      platform: 'telegram',
      actor: 'Morgan',
      conversationId: '-1001234567890',
      threadId: '7',
      messageId: '42',
      projectId: 'original-project',
      target: { kind: 'agent', id: 'original-agent' },
    },
    operationId: 'saved-operation',
    native: {
      state: 'completed',
      runId: 'saved-run',
      conversation: {
        kind: 'agent',
        agentId: 'original-agent',
        chatId: 'native-chat',
        conversationId: 'private-conversation',
        projectId: 'original-project',
        sender: 'gateway',
      },
    },
    items: [
      { label: 'Text part 1', status: 'sent', text: 'Confirmed prefix', remoteId: 'confirmed-app-id' },
      { label: 'Text part 2', status: 'uncertain', text: 'Uncertain suffix' },
    ],
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>;
    requests.push({ url, method, body });
    if (delayed && method === 'GET') return delayed;
    if ((method === 'GET' && failRead) || (method === 'POST' && failSave))
      return Response.json(
        {
          error:
            method === 'GET'
              ? 'Saved receipts could not load.'
              : 'The saved receipts changed. Reload the local-finish review.',
        },
        { status: 409 },
      );
    if (method === 'POST' && url.endsWith('/prepare'))
      preview = {
        ...preview,
        revision: 'b'.repeat(64),
        needsPrepare: false,
        canFinish: true,
        reason: '',
        items: preview.items.map((item) => (item.status === 'sending' ? { ...item, status: 'uncertain' } : item)),
      };
    else if (method === 'POST')
      preview = {
        ...preview,
        revision: 'c'.repeat(64),
        closedAt: 1700000000000,
        canFinish: false,
        reason: 'This receipt was finished locally and cannot be reopened.',
      };
    return Response.json(preview);
  });
});
afterEach(() => {
  act(() => unmount?.());
  vi.unstubAllGlobals();
});
async function open() {
  await act(async () => {
    unmount = mountReact(
      host,
      <GatewayRetiredFinishView instanceId="removed-one" eventId="saved-one" close={vi.fn()} changed={changed} />,
    ).unmount;
  });
  await settle();
}
async function click(label: string, root: ParentNode = host) {
  await act(async () => button(label, root).click());
  await settle();
}

it('loads original source and saved receipts through a GET without mutating or offering sends', async () => {
  await open();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((item) => item.url === base && item.method === 'GET')).toBe(true);
  expect(host.textContent).toContain('original-project');
  expect(host.textContent).toContain('original-agent');
  expect(host.textContent).toContain('saved-operation');
  expect(host.textContent).toContain('confirmed-app-id');
  expect(host.textContent).toContain('Delivery uncertain');
  expect(button('Retry delivery')).toBeUndefined();
  expect(button('Record confirmed delivery')).toBeUndefined();
  expect(button('Reconnect')).toBeUndefined();
});

it('recovers only the displayed revision and confirms local finish with fresh acknowledgements', async () => {
  preview = {
    ...preview,
    needsPrepare: true,
    canFinish: false,
    reason: 'Recover interrupted receipts before finishing locally.',
    items: [preview.items[0], { ...preview.items[1], status: 'sending' }],
  };
  await open();
  expect(button('Finish locally')).toBeUndefined();
  await click('Recover interrupted receipts');
  expect(requests.find((item) => item.method === 'POST')).toEqual({
    url: `${base}/prepare`,
    method: 'POST',
    body: { revision: 'a'.repeat(64) },
  });
  await click('Finish locally');
  expect(dialog().textContent).toContain('-1001234567890');
  expect(dialog().textContent).toContain('message 42');
  expect(dialog().textContent).toContain('original-project');
  expect(dialog().textContent).toContain('may already have arrived');
  await click('Finish locally', dialog());
  expect(requests.filter((item) => item.method === 'POST').at(-1)).toEqual({
    url: base,
    method: 'POST',
    body: { revision: 'b'.repeat(64), acknowledgeNoSend: true, acknowledgeMayStillRun: true },
  });
  expect(host.textContent).toContain('Finished locally');
  expect(host.textContent).toContain('confirmed-app-id');
  expect(host.textContent).toContain('Delivery uncertain');
  expect(button('Finish locally')).toBeUndefined();
  expect(changed).toHaveBeenCalledTimes(2);
});

it('explains that native work may still run and keeps the original tracking IDs visible', async () => {
  preview = { ...preview, kind: 'work', native: { ...preview.native!, state: 'running' }, items: [], heldRequests: 2 };
  await open();
  expect(host.textContent).toContain('2 other saved requests');
  expect(host.textContent).toContain('saved-run');
  expect(host.textContent).toContain('native-chat');
  await click('Finish locally');
  expect(dialog().textContent).toContain('Native work may still be running');
  expect(dialog().textContent).toContain('never track it again');
  await click('Finish locally', dialog());
  expect(host.textContent).toContain('Finished locally');
  expect(changed).toHaveBeenCalledTimes(1);
});

it('cancels without writing and guards simultaneous confirmation requests', async () => {
  await open();
  await act(async () => {
    button('Finish locally').click();
    button('Finish locally').click();
  });
  await settle();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  await click('Cancel', dialog());
  expect(requests.filter((item) => item.method === 'POST')).toHaveLength(0);
  expect(button('Finish locally').disabled).toBe(false);
});

it('ignores a confirmation after the review has unmounted', async () => {
  await open();
  await click('Finish locally');
  act(() => unmount());
  await click('Finish locally', dialog());
  expect(requests.filter((item) => item.method === 'POST')).toHaveLength(0);
  expect(changed).not.toHaveBeenCalled();
});

it('clears stale actions after read/save failure and requires a reload before continuing', async () => {
  failRead = true;
  await open();
  expect(host.textContent).toContain('Saved receipts could not load');
  expect(button('Finish locally')).toBeUndefined();
  failRead = false;
  await click('Reload local-finish review');
  failSave = true;
  await click('Finish locally');
  await click('Finish locally', dialog());
  expect(host.textContent).toContain('saved receipts changed');
  expect(button('Finish locally')).toBeUndefined();
  failSave = false;
  preview = { ...preview, revision: 'd'.repeat(64) };
  await click('Reload local-finish review');
  await click('Finish locally');
  await click('Finish locally', dialog());
  expect(requests.filter((item) => item.method === 'POST').at(-1)?.body.revision).toBe('d'.repeat(64));
});

it.each(['closed', 'unfinished removal', 'unavailable'] as const)('keeps a %s review read-only', async (kind) => {
  preview = {
    ...preview,
    canFinish: false,
    needsPrepare: false,
    reason: kind,
    ...(kind === 'closed' ? { closedAt: 1700000000000 } : kind === 'unavailable' ? { kind: 'unavailable' } : {}),
  };
  await open();
  expect(button('Finish locally')).toBeUndefined();
  expect(button('Recover interrupted receipts')).toBeUndefined();
  expect(requests.every((item) => item.method === 'GET')).toBe(true);
});

it('ignores a late GET after leaving the review', async () => {
  let resolve: (value: Response) => void = () => {};
  delayed = new Promise<Response>((ready) => {
    resolve = ready;
  });
  await open();
  act(() => unmount());
  await act(async () => resolve(Response.json(preview)));
  await settle();
  expect(host.textContent).toBe('');
  expect(changed).not.toHaveBeenCalled();
});
