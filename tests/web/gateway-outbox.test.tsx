import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayOutboxDestination, GatewayOutboxPostPreview, OutboxPost } from '../../shared/types.ts';
import { GatewayOutboxCard } from '../../web/views/gateway-outbox.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const recipient = {
  platform: 'telegram' as const,
  instanceName: 'Research bot',
  accountId: '999',
  conversationId: '-100',
  threadId: '7',
  sourceMessageId: '42',
  sender: 'Alice',
};
const gateway = { instanceId: 'gateway-research', eventId: 'a'.repeat(64) };
const destination: GatewayOutboxDestination = { ...gateway, recipient };
const base: OutboxPost = {
  id: 'post-1',
  platform: 'telegram',
  parts: ['Exact reviewed message 😀'],
  status: 'pending',
  accountLabel: 'Research bot',
  gateway,
  gatewayDraftRevision: 'draft-revision',
};
let root: Root;
let el: HTMLElement;
let post: OutboxPost;
let calls: { url: string; body: unknown }[];
let choices: GatewayOutboxDestination[];
let preview: GatewayOutboxPostPreview;
let failure = '';
let changed: () => void;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 35)));
const button = (parent: ParentNode, text: string) =>
  [...parent.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === text)!;
const type = (input: HTMLTextAreaElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
async function render() {
  await act(async () => root.render(<GatewayOutboxCard p={post} changed={changed} />));
  await settle();
}
beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><div id="view"></div>';
  el = document.getElementById('view')!;
  root = createRoot(el);
  post = structuredClone(base);
  choices = [destination];
  calls = [];
  failure = '';
  changed = vi.fn();
  preview = {
    recipient,
    draftRevision: 'saved-review-revision',
    approval: {
      ...gateway,
      projectId: 'project-1',
      postId: post.id,
      parts: ['Exact reviewed message 😀'],
      revision: 'b'.repeat(64),
    },
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const body = init.body ? (JSON.parse(String(init.body)) as unknown) : null;
    calls.push({ url, body });
    if (url.endsWith('/gateway-destinations')) return new Response(JSON.stringify(choices));
    if (url.endsWith('/gateway-review'))
      return new Response(JSON.stringify(failure ? { error: failure } : preview), { status: failure ? 409 : 200 });
    return new Response(JSON.stringify({ ...post, status: 'posting' }));
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  await act(() => new Promise((resolve) => setTimeout(resolve, 510)));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gateway Outbox review and delivery UI', () => {
  it('reviews and saves the chosen recipient and edited text, then sends only the confirmed snapshot', async () => {
    await render();
    await type(el.querySelector<HTMLTextAreaElement>('[aria-label="Gateway message"]')!, 'My edited message');
    preview.approval.parts = ['My edited message'];
    await act(async () => button(el, 'Review & send').click());
    await settle();
    expect(calls.find((call) => call.url.endsWith('/gateway-review'))!.body).toEqual({
      gateway,
      parts: ['My edited message'],
      draftRevision: 'draft-revision',
    });
    const modal = document.querySelector('.modal')!;
    expect(modal.textContent).toContain('Research bot · Telegram');
    expect(modal.textContent).toContain('-100');
    expect(modal.textContent).toContain('thread 7');
    expect(modal.textContent).toContain('Alice · message 42');
    expect(modal.textContent).toContain('My edited message');
    expect(button(modal, 'Approve & send').disabled).toBe(true);
    expect(calls.some((call) => call.url.endsWith('/approve'))).toBe(false);
    await act(async () => modal.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => button(modal, 'Approve & send').click());
    await settle();
    expect(calls.find((call) => call.url.endsWith('/approve'))!.body).toEqual({
      gatewayApproval: preview.approval,
      draftRevision: preview.draftRevision,
    });
    expect(document.getElementById('toasts')!.textContent).toContain('Follow delivery progress');
  });

  it('cancels a review without approving, and does not expose an implicit default recipient', async () => {
    post = { ...base, gateway: undefined, accountLabel: undefined };
    await render();
    expect(el.textContent).toContain('Choose an instance');
    expect(el.textContent).toContain('Choose a conversation');
    expect(button(el, 'Review & send').disabled).toBe(true);
    post = structuredClone(base);
    await render();
    await act(async () => button(el, 'Review & send').click());
    await settle();
    await act(async () => button(document.querySelector('.modal')!, 'Cancel').click());
    expect(calls.filter((call) => call.url.endsWith('/approve'))).toHaveLength(0);
  });

  it('shows a stale review error and keeps sending unavailable until a fresh review succeeds', async () => {
    failure = 'The draft changed. Reload it before reviewing.';
    await render();
    await act(async () => button(el, 'Review & send').click());
    await settle();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('draft changed');
    expect(document.querySelector('.modal')).toBeNull();
    expect(calls.some((call) => call.url.endsWith('/approve'))).toBe(false);
  });

  it('keeps the original baseline while the user edits and rejects late activation after unmount', async () => {
    await render();
    await type(el.querySelector<HTMLTextAreaElement>('[aria-label="Gateway message"]')!, 'Mine');
    post = { ...post, parts: ['New server text'], gatewayDraftRevision: 'new-server-revision' };
    await render();
    await act(async () => button(el, 'Review & send').click());
    await settle();
    expect(calls.find((call) => call.url.endsWith('/gateway-review'))!.body).toMatchObject({
      draftRevision: 'draft-revision',
      parts: ['Mine'],
    });
    const modal = document.querySelector('.modal')!;
    await act(async () => modal.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    const approve = button(modal, 'Approve & send');
    await act(async () => root.render(null));
    await act(async () => approve.click());
    expect(calls.some((call) => call.url.endsWith('/approve'))).toBe(false);
  });

  it('explains an empty recipient list and preserves a saved unavailable destination without selecting another', async () => {
    choices = [];
    await render();
    expect(el.textContent).toContain('No completed conversations');
    expect(el.textContent).toContain('saved recipient is no longer available');
    expect(button(el, 'Review & send').disabled).toBe(true);
    expect(el.querySelector<HTMLAnchorElement>('a[href="#/settings?tab=gateways"]')).not.toBeNull();
    expect(calls.some((call) => call.url.endsWith('/approve'))).toBe(false);
  });

  it('shows each confirmed and uncertain part as read-only and requires pause before finishing locally', async () => {
    post = {
      ...base,
      status: 'failed',
      parts: ['Confirmed prefix', 'Uncertain tail'],
      gatewayProgress: {
        state: 'uncertain',
        recipient,
        paused: false,
        reviewRevision: 'review',
        parts: [
          { status: 'sent', attempts: 1, remoteId: 'remote-first' },
          { status: 'uncertain', attempts: 1 },
        ],
      },
    };
    await render();
    expect(el.textContent).toContain('Delivery uncertain');
    expect(el.textContent).toContain('Confirmed');
    expect(el.textContent).toContain('remote-first');
    expect(el.querySelector('textarea')).toBeNull();
    expect(button(el, 'Finish locally').disabled).toBe(true);
    expect(button(el, 'Approve & send')).toBeUndefined();
    post = { ...post, gatewayProgress: { ...post.gatewayProgress!, paused: true } };
    await render();
    await act(async () => button(el, 'Finish locally').click());
    await settle();
    const modal = document.querySelector('.modal')!;
    expect(modal.textContent).toContain('Uncertain parts may already have arrived');
    await act(async () => button(modal, 'Finish locally').click());
    await settle();
    expect(calls.find((call) => call.url.endsWith('/gateway-finish'))!.body).toEqual({
      revision: 'review',
      acknowledgeNoSend: true,
    });
  });

  it('retains delivery uncertainty in locally finished history and offers no retry or edit', async () => {
    post = {
      ...base,
      status: 'rejected',
      gatewayProgress: {
        state: 'closed',
        recipient,
        paused: true,
        closedAt: 1,
        parts: [{ status: 'uncertain', attempts: 1 }],
      },
    };
    await render();
    expect(el.textContent).toContain('Finished locally');
    expect(el.textContent).toContain('may already have arrived');
    expect(el.querySelector('textarea')).toBeNull();
    expect(button(el, 'Finish locally')).toBeUndefined();
    expect(calls.filter((call) => call.body)).toEqual([]);
  });
});
