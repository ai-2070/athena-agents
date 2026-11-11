import { act } from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mountReact } from '../../web/ui/react.tsx';
import { GatewayInboxView, gatewayMessageStatus } from '../../web/views/gateway-inbox.tsx';
import type { GatewayInboxEvent, GatewayInstance } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const instance: GatewayInstance = {
  id: 'g1',
  name: 'Work bot',
  platform: 'telegram',
  accountId: '999',
  projectId: 'p1',
  target: { kind: 'brain' },
  senderPolicy: { platform: 'telegram', allowedUserIds: ['123'] },
  scope: { directMessages: true, conversationIds: [], guildIds: [] },
  fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, dailyBytes: 4096, filesPerMessage: 2 },
  enabled: true,
  routeGeneration: 1,
  createdAt: 1,
  updatedAt: 1,
};
function event(sequence = 1): GatewayInboxEvent {
  return {
    id: `event-${sequence}`,
    bindingId: 'binding',
    sequence,
    route: { instanceId: 'g1', projectId: 'p1', target: { kind: 'brain' }, generation: 1 },
    receivedAt: 1700000000000,
    status: 'done',
    operationId: `op-${sequence}`,
    input: {
      platform: 'telegram',
      accountId: '999',
      actor: { id: '123', label: 'Alice', kind: 'user' },
      conversationId: '456',
      threadId: '7',
      sourceMessageId: String(sequence),
      sourceEventId: String(sequence),
      kind: 'message',
      directMessage: true,
      triggered: false,
      text: `Request ${sequence}`,
      media: [],
    },
    dispatch: {
      conversation: { kind: 'brain', conversationId: 'binding', projectId: 'p1', sender: 'Alice' },
      state: 'completed',
      startedAt: 1,
      answer: 'Final answer',
    },
    reply: {
      createdAt: 1,
      parts: [
        { text: 'Confirmed prefix', status: 'sent', attempts: 1, remoteId: 'remote-1' },
        { text: 'Remaining reply', status: 'uncertain', attempts: 1 },
      ],
    },
  };
}
let events: GatewayInboxEvent[];
let host: HTMLElement;
let unmount: () => void;
let writes: { url: string; body: Record<string, unknown> }[];
let refuse: boolean;
let reviews: number;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const button = (name: string, root: ParentNode = host) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === name)!;
const click = (name: string, root: ParentNode = host) => act(async () => button(name, root).click());
beforeEach(() => {
  document.body.innerHTML = '<div id="view"></div><div id="modal-root"></div><div id="toasts"></div>';
  host = document.getElementById('view')!;
  events = [event()];
  writes = [];
  refuse = false;
  reviews = 0;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if ((!init.method || init.method === 'GET') && url.endsWith('/review')) {
      reviews++;
      return new Response(
        JSON.stringify({
          revision: 'a'.repeat(64),
          canDismiss: !refuse,
          reason: refuse ? 'Wait for the relay acknowledgement.' : '',
        }),
      );
    }
    if (!init.method || init.method === 'GET') return new Response(JSON.stringify({ events }));
    writes.push({ url, body: JSON.parse(String(init.body || '{}')) as Record<string, unknown> });
    if (refuse) return new Response(JSON.stringify({ error: 'File access changed.' }), { status: 400 });
    if (url.endsWith('/retry-reply')) events[0].reply!.parts[1].status = 'pending';
    if (url.endsWith('/reconcile')) events[0].reconciliation = { at: 1700000000000, state: 'needs-review' };
    if (url.endsWith('/dismiss')) events[0].dismissed = { at: 1700000000000, revision: 'a'.repeat(64) };
    if (url.endsWith('/files/1/skip')) events[0].outgoing![1].status = 'skipped';
    if (url.endsWith('/cleanup')) {
      const ids = writes.at(-1)!.body.eventIds as string[];
      events = events.filter((item) => !ids.includes(item.id));
    }
    return new Response(JSON.stringify({ ok: true }));
  });
});
afterEach(() => {
  act(() => unmount?.());
  vi.unstubAllGlobals();
});
async function open(enabled = true) {
  await act(async () => {
    unmount = mountReact(host, <GatewayInboxView instance={{ ...instance, enabled }} close={() => {}} />).unmount;
  });
  await settle();
}
async function all() {
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Inbox filter"]')!.click());
  await settle();
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent?.includes('All messages'))!
      .click(),
  );
  await settle();
}

function held() {
  const item = event();
  item.status = 'needs-review';
  delete item.operationId;
  delete item.dispatch;
  delete item.reply;
  return item;
}

it('dismisses an unstarted held request only after checking its current preview and confirming while paused', async () => {
  events = [held()];
  await open(false);
  expect(button('Dismiss request').disabled).toBe(false);
  await click('Dismiss request');
  await settle();
  expect(reviews).toBe(1);
  expect(writes).toHaveLength(0);
  expect(document.querySelector('.modal')?.textContent).toContain('without starting an assignment');
  await click('Cancel', document);
  await settle();
  expect(writes).toHaveLength(0);
  await click('Dismiss request');
  await settle();
  await click('Dismiss request', document.querySelector('.modal')!);
  await settle();
  expect(writes).toEqual([
    { url: '/api/gateways/g1/inbox/event-1/dismiss', body: { revision: 'a'.repeat(64), acknowledgeDismiss: true } },
  ]);
  expect(host.textContent).toContain('Request dismissed.');
  expect(host.textContent).toContain('No messages need review');
  await all();
  expect(host.textContent).toContain('Dismissed');
  expect(host.textContent).toContain('Request 1');
  expect(button('Dismiss request')).toBeUndefined();
});

it('requires pause and hides dismissal when any native operation is reserved', async () => {
  events = [held()];
  await open();
  expect(button('Dismiss request').disabled).toBe(true);
  act(() => unmount());
  events[0].operationId = 'reserved-operation';
  await open(false);
  expect(button('Dismiss request')).toBeUndefined();
  expect(writes).toHaveLength(0);
});

it('keeps locally finished statuses as evidence and hides all retry and file selection controls', async () => {
  events = [{ ...event(), deliveryFinished: { at: 1700000000000, revision: 'a'.repeat(64) } }];
  await open(false);
  await all();
  expect(gatewayMessageStatus(events[0])).toBe('Finished locally');
  expect(host.textContent).toContain('Earlier statuses stay as evidence');
  expect(button('Review delivery')).toBeDefined();
  expect(button('Retry remaining reply')).toBeUndefined();
  expect(button('Send selected files')).toBeUndefined();
});

it('shows kept native work in history without offering tracking, selection or retry controls', async () => {
  const saved = event();
  delete saved.reply;
  saved.status = 'running';
  saved.workKept = { at: 1700000000000, revision: 'a'.repeat(64), throughSequence: 1, serial: 1 };
  events = [saved];
  await open(false);
  await all();
  expect(gatewayMessageStatus(saved)).toBe('Kept in Athena');
  expect(button('Review saved work')).toBeDefined();
  expect(host.textContent).toContain('Native work may still be running');
  expect(button('Check saved work')).toBeUndefined();
  expect(button('Send selected files')).toBeUndefined();
});

it('reports a blocked dismissal preview and never opens a confirmation or starts work', async () => {
  events = [held()];
  refuse = true;
  await open(false);
  await click('Dismiss request');
  await settle();
  expect(host.textContent).toContain('Wait for the relay acknowledgement.');
  expect(document.querySelector('.modal')).toBeNull();
  expect(writes).toHaveLength(0);
});

it('keeps a request held when its confirmation becomes stale or access changes', async () => {
  events = [held()];
  await open(false);
  await click('Dismiss request');
  await settle();
  refuse = true;
  await click('Dismiss request', document.querySelector('.modal')!);
  await settle();
  expect(host.textContent).toContain('File access changed.');
  expect(host.textContent).toContain('Needs review');
  expect(events[0].dismissed).toBeUndefined();
});

it('does not apply dismissal confirmation after the inbox closes', async () => {
  events = [held()];
  await open(false);
  await click('Dismiss request');
  await settle();
  act(() => unmount());
  await click('Dismiss request', document.querySelector('.modal')!);
  await settle();
  expect(writes).toHaveLength(0);
});

it('requests one preview for rapid repeated dismiss clicks', async () => {
  events = [held()];
  await open(false);
  await act(async () => {
    button('Dismiss request').click();
    button('Dismiss request').click();
  });
  await settle();
  expect(reviews).toBe(1);
  expect(writes).toHaveLength(0);
  await click('Cancel', document);
  await settle();
});

it('allows dismissed receipts to be cleaned while keeping their saved message visible until confirmation', async () => {
  events = [held()];
  events[0].dismissed = { at: 1700000000000, revision: 'a'.repeat(64) };
  await open(false);
  await all();
  expect(gatewayMessageStatus(events[0])).toBe('Dismissed');
  expect(host.textContent).toContain('Saved text and files stay');
  expect(button('Remove resolved receipts').disabled).toBe(false);
  await click('Remove resolved receipts');
  await settle();
  expect(writes).toHaveLength(0);
  expect(document.querySelector('.modal')?.textContent).toContain('completed or dismissed');
  await click('Cancel', document);
  await settle();
  expect(events).toHaveLength(1);
});

it('shows saved context and selected final text as text, without automatically retrying anything', async () => {
  events[0].input.text = '<script>untrusted()</script>';
  await open();
  expect(host.textContent).toContain('Delivery uncertain');
  expect(host.textContent).toContain('Final answer');
  expect(host.textContent).toContain('<script>untrusted()</script>');
  expect(host.querySelector('script')).toBeNull();
  expect(host.textContent).toContain('Saved project');
  expect(host.textContent).toContain('456');
  expect(writes).toHaveLength(0);
});

it('requires confirmation for uncertain reply retry and never requests a replay or resends the confirmed prefix', async () => {
  await open();
  await click('Retry remaining reply');
  await settle();
  expect(document.querySelector('.modal')?.textContent).toContain('chat 456');
  expect(writes).toHaveLength(0);
  await click('Cancel', document);
  await settle();
  expect(writes).toHaveLength(0);
  await click('Retry remaining reply');
  await settle();
  await click('Retry delivery', document);
  await settle();
  expect(writes.map((item) => item.url)).toEqual(['/api/gateways/g1/inbox/event-1/retry-reply']);
  expect(events[0].reply!.parts[0].remoteId).toBe('remote-1');
});

it('disables retry and selection while paused but keeps receipts visible', async () => {
  await open(false);
  expect(button('Retry remaining reply').disabled).toBe(true);
  expect(button('Send selected files').disabled).toBe(true);
  expect(host.textContent).toContain('paused or unavailable');
  expect(writes).toHaveLength(0);
});

it('offers actions only for unconfirmed files and confirms skipping an uncertain file', async () => {
  events[0].outgoing = [
    {
      path: '/report-1',
      name: 'one.txt',
      size: 5,
      sha256: 'a'.repeat(64),
      status: 'sent',
      attempts: [],
      remoteId: 'file-1',
    },
    { path: '/report-2', name: 'two.txt', size: 5, sha256: 'b'.repeat(64), status: 'uncertain', attempts: [] },
  ];
  await open();
  expect([...host.querySelectorAll('button')].filter((item) => item.textContent === 'Retry file')).toHaveLength(1);
  await click('Skip file');
  await settle();
  expect(writes).toHaveLength(0);
  expect(document.querySelector('.modal')?.textContent).toContain('cannot undo');
  await click('Skip file', document.querySelector('.modal-foot')!);
  await settle();
  expect(writes.map((item) => item.url)).toEqual(['/api/gateways/g1/inbox/event-1/files/1/skip']);
  expect(events[0].outgoing[0].remoteId).toBe('file-1');
});

it('retains selected paths on a failed request and submits only paths to the existing selection API', async () => {
  await open();
  const field = host.querySelector<HTMLTextAreaElement>('[aria-label="Files to send"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      field,
      '/project/report.txt\n/project/image.png',
    );
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  refuse = true;
  await click('Send selected files');
  await settle();
  expect(field.value).toContain('/project/report.txt');
  expect(host.textContent).toContain('File access changed.');
  expect(writes[0]).toEqual({
    url: '/api/gateways/g1/inbox/event-1/files',
    body: { paths: ['/project/report.txt', '/project/image.png'] },
  });
});

it('preserves an open message and its unsent file selection when receipts refresh', async () => {
  await open();
  const details = host.querySelector('details')!;
  details.open = true;
  const field = host.querySelector<HTMLTextAreaElement>('[aria-label="Files to send"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '/project/draft.txt');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('Reload inbox');
  await settle();
  expect(host.querySelector('details')!.open).toBe(true);
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Files to send"]')!.value).toBe('/project/draft.txt');
  expect(writes).toHaveLength(0);
});

it('limits rendered history, lists newest first, and hides selection on superseded assignments', async () => {
  events = Array.from({ length: 30 }, (_, index) => event(index + 1));
  for (const item of events) item.reply!.parts[1].status = 'sent';
  await open();
  expect(host.textContent).toContain('No messages need review');
  await all();
  expect(host.querySelectorAll('details')).toHaveLength(25);
  expect(host.querySelector('summary')?.textContent).toContain('Request 30');
  expect(host.querySelectorAll('[aria-label="Files to send"]')).toHaveLength(1);
  await click('Show 25 more');
  expect(host.querySelectorAll('details')).toHaveLength(30);
});

it('does not apply a pending confirmation after the inbox has been closed', async () => {
  await open();
  await click('Retry remaining reply');
  await settle();
  act(() => unmount());
  await click('Retry delivery', document);
  await settle();
  expect(writes).toHaveLength(0);
});

it('retries failed incoming downloads without starting or replaying model work', async () => {
  const item = event();
  item.status = 'waiting-files';
  item.reply = undefined;
  item.input.media = [{ kind: 'file', fileId: 'provider-file', name: 'report.txt' }];
  item.files = [{ index: 0, status: 'failed', attempts: [], reason: 'Download interrupted.' }];
  events = [item];
  await open();
  expect(host.textContent).toContain('report.txt');
  await click('Retry failed downloads');
  await settle();
  expect(writes.map((request) => request.url)).toEqual(['/api/gateways/g1/inbox/event-1/retry-files']);
});

it('distinguishes skipped files from fully confirmed delivery', () => {
  const item = event();
  item.reply!.parts[1].status = 'sent';
  expect(gatewayMessageStatus(item)).toBe('Delivered');
  item.outgoing = [
    { path: '/report', name: 'report.txt', size: 5, sha256: 'a'.repeat(64), status: 'skipped', attempts: [] },
  ];
  expect(gatewayMessageStatus(item)).toContain('skipped');
});

it('checks only the saved held operation and reports when completion is still unproven', async () => {
  events[0].status = 'needs-review';
  events[0].reply = undefined;
  events[0].dispatch!.state = 'needs-review';
  await open();
  expect(host.textContent).toContain('does not start another run');
  await click('Check saved work');
  await settle();
  expect(writes.map((request) => request.url)).toEqual(['/api/gateways/g1/inbox/event-1/reconcile']);
  expect(host.textContent).toContain('Still held: no completed operation was verified.');
  expect(gatewayMessageStatus(events[0])).toBe('Needs review');
});

it('does not offer recovery for input without a dispatch receipt and disables it while paused', async () => {
  events[0].status = 'needs-review';
  events[0].reply = undefined;
  await open(false);
  expect(button('Check saved work').disabled).toBe(true);
  act(() => unmount());
  events[0].dispatch = undefined;
  await open();
  expect(button('Check saved work')).toBeUndefined();
  expect(writes).toHaveLength(0);
});

it('cleans completed receipts while paused only after confirming the exact selection', async () => {
  events[0].reply!.parts[1].status = 'sent';
  await open(false);
  expect(button('Remove resolved receipts').disabled).toBe(false);
  await click('Remove resolved receipts');
  await settle();
  expect(writes).toHaveLength(0);
  expect(document.querySelector('.modal')?.textContent).toContain('Native chats and project files stay');
  await click('Cancel', document);
  await settle();
  expect(writes).toHaveLength(0);
  await click('Remove resolved receipts');
  await settle();
  await click('Remove receipts', document);
  await settle();
  expect(writes).toHaveLength(1);
  expect(writes[0].url).toBe('/api/gateways/g1/inbox/cleanup');
  expect(writes[0].body).toEqual({ before: expect.any(Number), eventIds: ['event-1'] });
  expect(host.textContent).toContain('Removed 1 resolved receipt.');
  expect(host.textContent).toContain('No saved messages');
});

it('keeps completed context when another message in its conversation is unresolved', async () => {
  events[0].reply!.parts[1].status = 'sent';
  const queued = event(2);
  queued.status = 'queued';
  queued.reply = undefined;
  queued.dispatch = undefined;
  events.push(queued);
  await open();
  expect(button('Remove resolved receipts').disabled).toBe(true);
  expect(writes).toHaveLength(0);
});

it('applies the chosen receipt age without sending a cleanup request automatically', async () => {
  events[0].reply!.parts[1].status = 'sent';
  events[0].receivedAt = Date.now() - 10 * 86400000;
  await open();
  expect(button('Remove resolved receipts').disabled).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Receipt cleanup age"]')!.click());
  await settle();
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((item) => item.textContent?.includes('over 7 days'))!
      .click(),
  );
  await settle();
  expect(button('Remove resolved receipts').disabled).toBe(false);
  expect(writes).toHaveLength(0);
});

it('does not apply cleanup confirmation after the inbox has closed', async () => {
  events[0].reply!.parts[1].status = 'sent';
  await open();
  await click('Remove resolved receipts');
  await settle();
  act(() => unmount());
  await click('Remove receipts', document);
  await settle();
  expect(writes).toHaveLength(0);
});

function albumEvents() {
  return [1, 2].map((index) => {
    const item = event(index);
    item.status = 'needs-review';
    delete item.dispatch;
    delete item.operationId;
    delete item.reply;
    item.input.mediaGroupId = 'album';
    item.input.media = [{ kind: 'file', fileId: `file-${index}` }];
    item.files = [
      {
        index: 0,
        status: 'saved',
        attempts: [],
        file: { path: `/project/${index}.txt`, name: `${index}.txt`, top: 'batch', kind: 'file', size: 5 },
      },
    ];
    return item;
  });
}

it('confirms the complete visible album selection once before starting an assignment', async () => {
  events = albumEvents();
  await open();
  expect(
    [...host.querySelectorAll('button')].filter((item) => item.textContent === 'Group album and start'),
  ).toHaveLength(1);
  await click('Group album and start');
  await settle();
  expect(document.querySelector('.modal')?.textContent).toContain('no album completion marker');
  expect(document.querySelector('.modal')?.textContent).toContain('messages: 1, 2');
  expect(writes).toHaveLength(0);
  await click('Cancel', document);
  await settle();
  expect(writes).toHaveLength(0);
  await click('Group album and start');
  await settle();
  await click('Group album and start', document.querySelector('.modal')!);
  await settle();
  expect(writes).toEqual([
    { url: '/api/gateways/g1/inbox/event-1/group-album', body: { eventIds: ['event-1', 'event-2'] } },
  ]);
});

it('disables grouping while paused and does not apply a stale confirmation after closing', async () => {
  events = albumEvents();
  await open(false);
  expect(button('Group album and start').disabled).toBe(true);
  act(() => unmount());
  await open();
  await click('Group album and start');
  await settle();
  act(() => unmount());
  await click('Group album and start', document.querySelector('.modal')!);
  await settle();
  expect(writes).toHaveLength(0);
});

it('shows grouped source IDs and directs followers to the single assignment', async () => {
  events = albumEvents();
  events[0].album = { leaderId: 'event-1', memberIds: ['event-1', 'event-2'] };
  events[0].status = 'running';
  events[1].album = { leaderId: 'event-1' };
  events[1].status = 'done';
  await open();
  await all();
  expect(host.textContent).toContain('Album source messages: 1, 2');
  expect(host.textContent).toContain('Grouped with message 1');
  expect(gatewayMessageStatus(events[1])).toBe('Grouped in album');
  expect(button('Group album and start')).toBeUndefined();
  expect(button('Send selected files')).toBeUndefined();
});
