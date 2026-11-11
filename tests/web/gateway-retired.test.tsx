import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mountReact } from '../../web/ui/react.tsx';
import { GatewaysTab } from '../../web/views/gateways.tsx';
import type { GatewayInboxEvent, GatewayInstance, GatewayRetiredInstance } from '../../shared/types.ts';

let host: HTMLElement;
let unmount: () => void;
let records: GatewayRetiredInstance[];
let requests: { url: string; method: string }[];
let events: Record<string, GatewayInboxEvent[]>;
let failList: boolean;
let failHistory: boolean;
let failRemoval: boolean;
let failActive: boolean;
let delayed: ((url: string) => Promise<Response> | undefined) | undefined;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const button = (name: string, root: ParentNode = host) =>
  [...root.querySelectorAll('button')].find((item) => item.textContent === name)!;
const confirm = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const retired = (id: string, pending = false): GatewayRetiredInstance => ({
  version: 1,
  id,
  name: `Removed ${id}`,
  platform: 'telegram',
  accountId: `account-${id}`,
  projectId: 'old-project',
  target: { kind: 'agent', id: 'old-agent' },
  routeGeneration: 2,
  startedAt: 1700000000000,
  ...(pending ? {} : { completedAt: 1700000001000 }),
});
function receipt(id = 'one'): GatewayInboxEvent {
  const route = { instanceId: id, projectId: 'original-project', target: { kind: 'brain' } as const, generation: 1 };
  return {
    id: `event-${id}`,
    bindingId: `binding-${id}`,
    route,
    sequence: 1,
    receivedAt: 1700000000000,
    status: 'done',
    operationId: `operation-${id}`,
    input: {
      platform: 'telegram',
      accountId: `account-${id}`,
      conversationId: '-1001234567890',
      threadId: '7',
      sourceEventId: '42',
      sourceMessageId: '42',
      kind: 'message',
      actor: { id: '123', label: 'Morgan', kind: 'user' },
      directMessage: false,
      triggered: true,
      text: `Original message ${id}`,
      media: [],
    },
    dispatch: {
      state: 'completed',
      startedAt: 1700000000001,
      runId: `run-${id}`,
      answer: 'Saved final answer',
      conversation: { kind: 'brain', conversationId: `private-${id}`, projectId: route.projectId, sender: 'test' },
    },
    reply: {
      createdAt: 1700000000002,
      parts: [
        { text: 'Confirmed prefix', status: 'sent', attempts: 1, remoteId: `confirmed-${id}` },
        { text: 'Uncertain suffix', status: 'uncertain', attempts: 1 },
      ],
    },
    notices: { working: { text: 'Working notice text', status: 'sending', attempts: 1 } },
    outgoing: [
      {
        path: '/private/retained/file.txt',
        name: 'report.txt',
        size: 5,
        sha256: 'a'.repeat(64),
        status: 'uncertain',
        attempts: [{ day: '2026-11-04', bytes: 5 }],
        remoteId: 'file-receipt',
      },
    ],
  };
}
const live: GatewayInstance & { credentials: Record<string, boolean> } = {
  id: 'live',
  name: 'Active bot',
  platform: 'telegram',
  accountId: 'live-account',
  projectId: 'p1',
  target: { kind: 'brain' },
  enabled: false,
  senderPolicy: { platform: 'telegram', allowedUserIds: ['123'] },
  scope: { directMessages: true, conversationIds: [], guildIds: [] },
  fileLimits: { perFileBytes: 5, perMessageBytes: 10, filesPerMessage: 2, dailyBytes: 100 },
  routeGeneration: 1,
  createdAt: 1,
  updatedAt: 1,
  credentials: { botToken: true },
};
beforeEach(() => {
  document.body.innerHTML = '<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>';
  host = document.getElementById('view')!;
  requests = [];
  records = [retired('one'), retired('two', true)];
  events = { one: [receipt()], two: [] };
  failList = false;
  failHistory = false;
  failRemoval = false;
  failActive = false;
  delayed = undefined;
  location.hash = '#/settings?tab=gateways';
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    requests.push({ url, method });
    const waiting = delayed?.(url);
    if (waiting) return waiting;
    let value: unknown = {};
    if (url === '/api/projects') value = { projects: [{ id: 'p1', name: 'Open project' }] };
    else if (url === '/api/gateways' && method === 'GET') {
      if (failActive) return Response.json({ error: 'Active gateway credentials need recovery.' }, { status: 503 });
      value = { instances: [live], health: [] };
    } else if (url === '/api/gateways/retired') {
      if (failList)
        return Response.json(
          { error: 'Removal records are unreadable. Restore them before continuing.' },
          { status: 503 },
        );
      value = { instances: records };
    } else if (url.startsWith('/api/gateways/retired/') && url.endsWith('/inbox')) {
      if (failHistory) return Response.json({ error: 'This gateway inbox is unreadable.' }, { status: 503 });
      value = { events: events[decodeURIComponent(url.split('/')[4])] || [] };
    } else if (method === 'DELETE') {
      if (failRemoval)
        return Response.json({ error: 'Check storage and ownership, then retry removal.' }, { status: 503 });
      const id = decodeURIComponent(url.split('/').at(-1)!);
      records = records.map((item) => (item.id === id ? { ...item, completedAt: 1700000002000 } : item));
      value = { ok: true };
    }
    return Response.json(value);
  });
});
afterEach(() => {
  act(() => unmount?.());
  vi.unstubAllGlobals();
});
async function open(id?: string) {
  if (id !== undefined) location.hash = `#/settings?tab=gateways&retired=${id || 'all'}`;
  await act(async () => {
    unmount = mountReact(host, <GatewaysTab />).unmount;
  });
  await settle();
}
async function click(name: string, root: ParentNode = host) {
  await act(async () => button(name, root).click());
  await settle();
}

it('discovers removed instances without fetching them until requested and keeps active setup separate', async () => {
  await open();
  expect(requests.some((item) => item.url === '/api/gateways/retired')).toBe(false);
  await click('View removed instances');
  expect(location.hash).toContain('retired=all');
  expect(host.textContent).toContain('Removal unfinished');
  expect(button('Enable').disabled).toBe(true);
  expect(requests.every((item) => item.method === 'GET')).toBe(true);
  await click('Close removed instances');
  expect(button('Enable').disabled).toBe(false);
  expect(location.hash).toBe('#/settings?tab=gateways');
});

it('reads original source, destination and per-part evidence without delivery or native controls', async () => {
  await open('one');
  expect(host.textContent).toContain('Removed one');
  await act(async () => (host.querySelector('details')!.open = true));
  expect(host.textContent).toContain('original-project');
  expect(host.textContent).toContain('old-agent');
  expect(host.textContent).toContain('operation-one');
  expect(host.textContent).toContain('private-one');
  expect(host.textContent).toContain('Confirmed prefix');
  expect(host.textContent).toContain('confirmed-one');
  expect(host.textContent).toContain('Delivery uncertain');
  expect(host.textContent).toContain('Saved in-flight receipt');
  expect(host.textContent).toContain('file-receipt');
  expect(host.textContent).not.toContain('/private/retained');
  for (const label of [
    'Retry removal',
    'Retry file',
    'Retry remaining delivery',
    'Check saved work',
    'Send selected files',
    'Record confirmed delivery',
  ])
    expect(button(label)).toBeUndefined();
  expect(requests.filter((item) => item.method !== 'GET')).toEqual([]);
});

it('opens local-finish review for the selected saved receipt without mutating history', async () => {
  const original = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/local-finish')) {
      requests.push({ url, method: init.method || 'GET' });
      return Response.json({
        revision: 'a'.repeat(64),
        kind: 'delivery',
        reason: '',
        canFinish: true,
        needsPrepare: false,
        heldRequests: 0,
        source: {
          platform: 'telegram',
          actor: 'Morgan',
          conversationId: '123',
          threadId: '',
          messageId: '42',
          projectId: 'original-project',
          target: { kind: 'brain' },
        },
        items: [],
      });
    }
    return original(url, init);
  });
  await open('one');
  await click('Review local finish');
  expect(requests).toContainEqual({ url: '/api/gateways/retired/one/inbox/event-one/local-finish', method: 'GET' });
  expect(button('Finish locally')).toBeDefined();
  expect(requests.every((item) => item.method === 'GET')).toBe(true);
  await click('Back to saved history');
  expect(host.textContent).toContain('Original message one');
});

it('opens a removed deep link even if active credentials prevent the active listing from loading', async () => {
  failActive = true;
  await open('one');
  expect(host.textContent).toContain('Active gateway credentials need recovery');
  expect(host.textContent).toContain('Saved inbox receipts');
  expect(host.textContent).toContain('Removed one');
  expect(requests.some((item) => item.url === '/api/gateways/retired/one/inbox')).toBe(true);
});

it('requires confirmation, guards double clicks, and retries only the selected unfinished removal', async () => {
  await open('two');
  await act(async () => {
    button('Retry removal').click();
    button('Retry removal').click();
  });
  await settle();
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(confirm().textContent).toContain('Removed two');
  expect(confirm().textContent).toContain('account-two');
  await click('Cancel', confirm());
  expect(requests.filter((item) => item.method === 'DELETE')).toHaveLength(0);
  await click('Retry removal');
  await click('Retry removal', confirm());
  expect(requests.filter((item) => item.method === 'DELETE')).toEqual([{ url: '/api/gateways/two', method: 'DELETE' }]);
  expect(host.textContent).toContain('Removal finished');
  expect(button('Retry removal')).toBeUndefined();
  expect(records[0].completedAt).toBe(1700000001000);
  expect(requests.some((item) => item.method === 'PUT' || item.method === 'POST')).toBe(false);
});

it('keeps an unsuccessful removal blocked and shows a retryable storage/ownership error', async () => {
  failRemoval = true;
  await open('two');
  await click('Retry removal');
  await click('Retry removal', confirm());
  expect(host.textContent).toContain('Check storage and ownership');
  expect(records[1].completedAt).toBeUndefined();
  expect(button('Retry removal').disabled).toBe(false);
  failRemoval = false;
  await click('Retry removal');
  await click('Retry removal', confirm());
  expect(host.textContent).toContain('Removal finished');
});

it('does not submit a confirmation after its history view has closed', async () => {
  await open('two');
  await click('Retry removal');
  await click('Close removed instances');
  await click('Retry removal', confirm());
  expect(requests.some((item) => item.method === 'DELETE')).toBe(false);
  expect(button('Enable').disabled).toBe(false);
});

it('offers independent list and history reloads and never treats a failed read as an empty history', async () => {
  failList = true;
  await open('one');
  expect(host.textContent).toContain('Removal records are unreadable');
  expect(host.textContent).not.toContain('No removed instances');
  failList = false;
  failHistory = true;
  await click('Reload removed instances');
  expect(host.textContent).toContain('inbox is unreadable');
  expect(host.textContent).not.toContain('No saved inbox messages');
  failHistory = false;
  await click('Reload saved history');
  expect(host.textContent).toContain('Original message one');
});

it('handles missing and empty records without guessing a folder or offering writes', async () => {
  await open('missing');
  expect(host.textContent).toContain('could not be found');
  expect(requests.some((item) => item.url.endsWith('/missing/inbox'))).toBe(false);
  await click('Back to removed instances');
  records = [];
  await click('Reload removed instances');
  expect(host.textContent).toContain('No removed instances');
  expect(requests.every((item) => item.method === 'GET')).toBe(true);
});

it('bounds list/message rendering, searches literal metadata and retains long escaped content', async () => {
  records = Array.from({ length: 26 }, (_, index) => retired(`long-${index}`));
  records[25].name = '<script>' + 'long'.repeat(20);
  await open('');
  expect(host.querySelectorAll('button[aria-label^="View saved history for"]')).toHaveLength(25);
  await click('Show 25 more instances');
  expect(host.querySelectorAll('button[aria-label^="View saved history for"]')).toHaveLength(26);
  await act(async () => {
    const field = host.querySelector<HTMLInputElement>('[aria-label="Find a removed instance"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '<script>');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  expect(host.querySelectorAll('button[aria-label^="View saved history for"]')).toHaveLength(1);
  expect(host.querySelector('script')).toBeNull();
  events['long-25'] = Array.from({ length: 26 }, (_, index) => ({
    ...receipt('long-25'),
    id: `event-${index}`,
    sequence: index + 1,
  }));
  await click('View saved history');
  expect(host.querySelectorAll('details')).toHaveLength(25);
  await click('Show 25 more messages');
  expect(host.querySelectorAll('details')).toHaveLength(26);
});

it('ignores a late history response after selecting a different removed instance', async () => {
  let resolve: (value: Response) => void = () => {};
  const waiting = new Promise<Response>((ready) => {
    resolve = ready;
  });
  delayed = (url) => (url === '/api/gateways/retired/one/inbox' ? waiting : undefined);
  await open('one');
  await click('Back to removed instances');
  const selected = host.querySelector<HTMLButtonElement>('[aria-label="View saved history for Removed two"]')!;
  await act(async () => selected.click());
  await settle();
  expect(host.textContent).toContain('No saved inbox messages');
  await act(async () => resolve(Response.json({ events: [receipt('one')] })));
  await settle();
  expect(host.textContent).not.toContain('Original message one');
  expect(host.textContent).toContain('Removed two');
  expect(location.hash).toContain('retired=two');
});
