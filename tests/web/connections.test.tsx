// Settings > Connections and the Outbox (React): approving edited drafts, discussing, auto-post, the app setup forms.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectEvents, state } from '../../web/core.ts';
import * as connections from '../../web/views/connections.tsx';
import * as outbox from '../../web/views/outbox.tsx';
import { chars } from '../../web/views/outbox.tsx';
import type { AppState, OutboxPost } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const settle = () => act(() => new Promise((r) => setTimeout(r, 30)));

const post = (over: Partial<OutboxPost> = {}): OutboxPost =>
  ({ id: 'p1', platform: 'x', status: 'pending', accountLabel: '@ada', agentName: 'Writer', teamName: 'Social', parts: ['Hello world'], images: ['C:\\out\\a.png', 'C:\\out\\b.png'], createdAt: Date.now(), ...over }) as OutboxPost;
let posts: OutboxPost[];
let requests: { method: string; url: string; body: unknown }[];
let el: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<div id="modal-root"></div><div id="toasts"></div><section id="view"></section>';
  el = document.getElementById('view')!;
  posts = [post(), post({ id: 'p2', status: 'posted', parts: ['Old one'], images: undefined, url: 'https://x.com/1' })];
  requests = [];
  state.data = { outboxPending: 1, accounts: { x: [{ id: 'x1', username: 'ada', name: 'Ada', autopost: false, connectedAt: Date.now() }], reddit: [] } } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, url, body });
    const json = (v: unknown) => new Response(JSON.stringify(v));
    if (url === '/api/outbox' && method === 'GET') return json(posts);
    if (url.endsWith('/approve')) {
      posts = posts.map((p, i) => (i === 0 ? { ...p, status: 'posted' } : p));
      return json(posts[0]);
    }
    if (url === '/api/settings' && method === 'GET') return json({ settings: { x: { clientId: 'cid' }, reddit: {}, telegram: { chatId: '' } }, secrets: { xClientSecret: { set: false }, redditClientSecret: { set: false }, telegramBotToken: { set: false }, discordWebhook: { set: true, hint: '…abc' } } });
    if (url === '/api/accounts') return json(state.data!.accounts && { ...state.data!.accounts, xAppConfigured: true, redditAppConfigured: false });
    if (url === '/api/state') return json(state.data);
    return json({ ok: true });
  });
});
afterEach(() => {
  act(() => outbox.unmount());
  act(() => connections.unmount());
  vi.unstubAllGlobals();
});

const btn = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === text)!;
const type = (input: HTMLInputElement | HTMLTextAreaElement, text: string) =>
  act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
const openOutbox = async () => {
  await act(async () => outbox.render(el));
  await settle();
};

describe('chars()', () => {
  it('counts as X does: an emoji is two, a link 23', () => {
    expect(chars('hi 👋')).toBe(5);
    expect(chars('see https://example.com/a/long/path')).toBe(27);
  });
});

describe('the Outbox', () => {
  it('capitalizes status labels and gives draft actions icons', async () => {
    const statuses: OutboxPost['status'][] = ['pending', 'failed', 'posting', 'posted', 'rejected', 'returned'];
    posts = statuses.map((status, i) => post({ id: `p${i}`, status }));
    await openOutbox();
    const labels = [...el.querySelectorAll('.pill')].map((pill) => pill.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Waiting', 'Failed', 'Posting…', 'Posted', 'Rejected', 'Sent back']));
    for (const label of ['Approve & post', 'Save edits', 'Discuss with team', 'Reject', 'Copy', 'Save']) {
      const action = [...el.querySelectorAll('button, a')].find((element) => element.textContent === label)!;
      expect(action.querySelector('svg')).not.toBeNull();
    }
    expect(requests.some((request) => request.url.includes('/approve'))).toBe(false);
  });

  it('lists what waits and the history, with a live character count', async () => {
    await openOutbox();
    expect([...el.querySelectorAll('h2.section')].map((h) => h.textContent)).toEqual(['Waiting for you (1)', 'History']);
    const text = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text"]')!;
    await type(text, 'x'.repeat(281));
    const count = text.parentElement!.querySelector('.tabular-nums')!;
    expect(count.textContent).toBe('281/280');
    expect(count.classList.contains('text-red')).toBe(true);
    await type(text, '日本'.repeat(70) + '!');
    expect(count.textContent).toBe('281/280');
  });

  it("shows X's character count only on X posts", async () => {
    posts = [post({ platform: 'reddit', images: undefined, reddit: { kind: 'post', subreddit: 'test', title: 'Hi' } })];
    await openOutbox();
    const text = el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text"]')!;
    expect(text.parentElement!.querySelector('.tabular-nums')).toBeNull();
  });

  it('approves with your edits and without the image you took off', async () => {
    await openOutbox();
    await type(el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text"]')!, 'Hello there');
    await act(async () => el.querySelector<HTMLButtonElement>('[aria-label="Take a.png off the post"]')!.click());
    await act(async () => btn(el, 'Approve & post').click());
    await settle();
    expect(requests.find((r) => r.url === '/api/outbox/p1/approve')!.body).toEqual({ parts: ['Hello there'], images: ['C:\\out\\b.png'] });
    expect(document.getElementById('toasts')!.textContent).toContain('Posted ✓');
    expect(el.textContent).toContain('Waiting for you (0)');
  });

  it("shows each image's alt text, and the file name when there is none", async () => {
    posts = [post({ imageAlt: { 'C:\\out\\a.png': 'A red bike against a wall' } })];
    await openOutbox();
    expect([...el.querySelectorAll('img')].map((i) => i.getAttribute('alt'))).toEqual(['A red bike against a wall', 'b.png']);
  });

  it('sends a draft back to its team with your note', async () => {
    await openOutbox();
    const discuss = btn(el, 'Discuss with team');
    await act(async () => discuss.click());
    expect(discuss.getAttribute('aria-expanded')).toBe('true');
    await type(el.querySelector<HTMLTextAreaElement>('textarea[aria-label="What should change"]')!, 'Shorter please');
    await act(async () => btn(el, 'Send to team').click());
    await settle();
    expect(requests.find((r) => r.url === '/api/outbox/p1/discuss')!.body).toEqual({ text: 'Shorter please' });
  });

  it('shows a newer version of a draft from the server, unless you are changing it', async () => {
    class FakeSocket {
      static last: FakeSocket | null = null;
      onmessage: ((m: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onopen: (() => void) | null = null;
      constructor() {
        FakeSocket.last = this;
      }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    connectEvents();
    const outboxEvent = () => act(async () => FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: 'outbox', ts: 0 }) }));
    await openOutbox();
    const text = () => el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Text"]')!;
    // (saved in another tab)
    posts = [{ ...posts[0], parts: ['Newer text'] }, posts[1]];
    await outboxEvent();
    await settle();
    expect(text().value).toBe('Newer text');
    // your own changes are kept while you make them
    await type(text(), 'Mine');
    posts = [{ ...posts[0], parts: ['Even newer'] }, posts[1]];
    await outboxEvent();
    await settle();
    expect(text().value).toBe('Mine');
  });

  it('a thread the server cut shorter after a failed send still shows your edited parts', async () => {
    posts = [post({ parts: ['One', 'Two', 'Three'], images: undefined })];
    const ok = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/approve')) {
        // (the first part went out; what is left waits)
        posts = [{ ...posts[0], status: 'failed', parts: ['Three'], error: 'X said no' } as OutboxPost];
        return new Response(JSON.stringify(posts[0]));
      }
      return ok(url, init);
    });
    await openOutbox();
    await type(el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Part 3"]')!, 'Three, changed');
    await act(async () => btn(el, 'Approve & post').click());
    await settle();
    expect(el.querySelectorAll('textarea[aria-label^="Part"]').length).toBe(3);
    expect(el.querySelector<HTMLTextAreaElement>('textarea[aria-label="Part 3"]')!.value).toBe('Three, changed');
  });

  it('lets you change a Reddit post title before approving', async () => {
    posts = [post({ platform: 'reddit', images: undefined, reddit: { kind: 'post', subreddit: 'rust', title: 'Old title' } } as Partial<OutboxPost>)];
    await openOutbox();
    expect(el.textContent).toContain('Post in r/rust');
    await type(el.querySelector<HTMLInputElement>('input[aria-label="Title"]')!, 'New title');
    await act(async () => btn(el, 'Approve & send').click());
    await settle();
    expect(requests.find((r) => r.url.endsWith('/approve'))!.body).toEqual({ parts: ['Hello world'], title: 'New title' });
  });
});

describe('Connections', () => {
  const openConnections = async (hash = '#/settings?tab=connections') => {
    location.hash = hash;
    await act(async () => connections.render(el));
    await settle();
  };

  it('opens on Outbox from a link, with the waiting count on its tab', async () => {
    await openConnections('#/settings?tab=connections&sub=outbox');
    const on = el.querySelector('[role="tab"].on')!;
    expect(on.textContent).toBe('Outbox 1');
    expect(el.textContent).toContain('Waiting for you (1)');
  });

  it('keeps Reddit accounts and setup at the end of account settings', async () => {
    await openConnections('#/settings?tab=connections&sub=accounts');
    const sections = [...el.querySelectorAll('.settings-section h2')].map((heading) => heading.textContent);
    expect(sections.slice(-2)).toEqual(['Reddit accounts', 'Your Reddit app (one-time setup)']);
    expect(sections.indexOf('Discord')).toBeLessThan(sections.indexOf('Reddit accounts'));
    // Reddit has reviewed new apps since November 2025, so setting one up may take a wait
    expect(el.textContent).toContain("may need Reddit's approval first");
    for (const name of ['X accounts', 'Telegram', 'Discord']) {
      const heading = [...el.querySelectorAll('.settings-section h2')].find((h) => h.textContent === name)!;
      expect(heading.querySelector('svg')?.getAttribute('width')).toBe('17');
    }
  });

  it('turns auto-post on only after you confirm', async () => {
    await openConnections('#/settings?tab=connections&sub=accounts');
    const sw = el.querySelector<HTMLElement>('.conn-account [role="switch"]')!;
    await act(async () => sw.click());
    await act(async () => btn(document.querySelector('.modal-foot')!, 'Cancel').click());
    await settle();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(requests.some((r) => r.url === '/api/accounts/x/x1')).toBe(false);
    await act(async () => sw.click());
    await act(async () => btn(document.querySelector('.modal-foot')!, 'Turn on').click());
    await settle();
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(requests.find((r) => r.url === '/api/accounts/x/x1')!.body).toEqual({ autopost: true });
  });

  it('turning auto-post off that can not be saved puts the switch back on', async () => {
    state.data = { ...state.data!, accounts: { x: [{ id: 'x1', username: 'ada', name: 'Ada', autopost: true, connectedAt: Date.now() }], reddit: [] } } as unknown as AppState;
    const ok = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (url === '/api/accounts/x/x1') return new Response(JSON.stringify({ error: 'Could not save it.' }), { status: 500 });
      return ok(url, init);
    });
    await openConnections('#/settings?tab=connections&sub=accounts');
    const sw = el.querySelector<HTMLElement>('.conn-account [role="switch"]')!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    await act(async () => sw.click());
    await settle();
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(document.getElementById('toasts')!.textContent).toContain('Could not save it.');
  });

  it('saves the X app, and shows the callback address to register', async () => {
    await openConnections('#/settings?tab=connections&sub=accounts');
    expect(el.querySelector('.conn-steps code')!.textContent).toBe(`${location.origin}/oauth/x/callback`);
    const id = [...el.querySelectorAll('label.field')].find((f) => f.textContent?.startsWith('Client ID') && f.querySelector('input')?.placeholder === 'Client ID from your X app')!.querySelector('input')!;
    await type(id, ' new-id ');
    await act(async () => btn(el.querySelectorAll('.col.gap-lg')[1] as HTMLElement, 'Save').click());
    await settle();
    expect(requests.find((r) => r.method === 'PUT' && r.url === '/api/settings')!.body).toEqual({ x: { clientId: 'new-id' } });
  });
});
