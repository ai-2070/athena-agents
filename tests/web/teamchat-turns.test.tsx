// A team chat with the Vercel AI SDK: a working agent's turn streams in (its text and tool calls), and
// "Show the work" opens the steps and tool calls behind a finished reply.
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { connectEvents, state } from '../../web/core.ts';
import { forgetFiles } from '../../web/filepreview.tsx';
import { clock, renderTeamChat } from '../../web/teamchat.tsx';
import type { TeamChatApi } from '../../web/teamchat.tsx';
import type { AppState, Chat, ChatItem } from '../../shared/types.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket {
  static last: FakeSocket | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor() {
    FakeSocket.last = this;
  }
}
function uiStream() {
  const enc = new TextEncoder();
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  return {
    response: () =>
      new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } }),
    push: (c: UIMessageChunk) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`)),
    end: () => (ctl.enqueue(enc.encode('event: done\n\n')), ctl.close()),
  };
}

const SESSION: ChatItem[] = [
  { type: 'user', text: 'team brief…' },
  { type: 'tool', id: 'r1', name: 'read_file', args: { path: 'brief.md' }, result: 'the brief', status: 'done' },
  { type: 'assistant', text: 'Plan: @Maker make the thumbnail.' },
];
let live: ReturnType<typeof uiStream>;
let requests: string[];
// messages the chat got while the event socket was down
let missed: object[] = [];
let bodies: Record<string, unknown>;
// the snapshot's sessions, and a load the test answers only when it lets it go
let snapshotSessions: Record<string, string>;
let holdLoad: Promise<void> | null = null;
const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));

beforeAll(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  connectEvents();
});
beforeEach(() => {
  forgetFiles();
  requests = [];
  bodies = {};
  missed = [];
  snapshotSessions = { lead: 'lead-chat', maker: 'maker-chat' };
  holdLoad = null;
  live = uiStream();
  state.data = {
    engines: { 'claude-code': { installed: true, loggedIn: true } },
    runs: [],
    approvals: [],
    agents: [
      { id: 'lead', name: 'Lead', emoji: '🧭', color: '#fff' },
      { id: 'maker', name: 'Maker', emoji: '🎨', color: '#fff' },
    ],
  } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    requests.push(`${init.method || 'GET'} ${url}`);
    if (init.body) bodies[url] = JSON.parse(String(init.body));
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    // (the page's state, loaded again when the event socket comes back)
    if (url === '/api/state') return json(state.data);
    if (url === '/api/teams/t1/chat' && holdLoad) await holdLoad;
    if (url === '/api/teams/t1/chat')
      return json({
        team: { id: 't1', name: 'Thumbs', members: ['lead', 'maker'], lead: 'lead', steps: [] },
        messages: [
          { id: 'u1', ts: 0, from: 'user', text: 'Make a thumbnail', mentions: [] },
          {
            id: 'm1',
            ts: 1,
            from: 'lead',
            text: 'Plan: @Maker make the thumbnail.',
            mentions: ['maker'],
            turn: { chatId: 'lead-chat', from: 0, to: 3 },
          },
          ...missed,
        ],
        working: ['maker'],
        queued: [],
        sessions: snapshotSessions,
      });
    // (a fresh stream for each ask, as the server does: React's dev mode mounts twice and asks again)
    if (url === '/api/agents/maker/chats/maker-chat/stream') return (live = uiStream()).response();
    // (the team as edited: Maker leads now)
    if (url === '/api/workflows/t1')
      return json({ id: 't1', name: 'Thumbs', members: ['lead', 'maker'], lead: 'maker', steps: [] });
    if (url === '/api/teams/t1/queue') return json({ queued: { id: 'q1', text: 'then the banner', ts: 5 } });
    // a queued message changed: "gone" was posted meanwhile, "boom" can't be saved
    if (init.method === 'PUT' && url.startsWith('/api/teams/t1/queue/')) {
      const text = String((bodies[url] as { text?: unknown } | undefined)?.text);
      if (text === 'boom') return new Response(JSON.stringify({ error: 'Could not save it.' }), { status: 500 });
      return json({ queued: text === 'gone' ? null : { id: url.split('/').pop(), text, ts: 1 } });
    }
    if (url === '/api/teams/t1/stop') return json({ ok: true, unqueued: [{ id: 'q2', text: 'and a logo', ts: 6 }] });
    if (url === '/api/agents/lead/chats/lead-chat')
      return json({ id: 'lead-chat', agentId: 'lead', items: SESSION } as Partial<Chat>);
    return json({});
  });
});
let open: TeamChatApi | null = null;
afterEach(() => {
  // (a failed assertion must not leave a chat listening for the next test)
  open?.destroy();
  open = null;
  document.body.innerHTML = '';
});
const teamEvent = (event: object) =>
  act(async () => FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: 'team', teamId: 't1', ts: 0, event }) }));

describe('team chat box', () => {
  it('a mention asked for as the chat opens lands in the box once it is drawn', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    // (what the Station does: open the chat, then mention the member straight away)
    open = renderTeamChat(el, 't1');
    open.mention('Maker');
    await settle();
    const box = el.querySelector('textarea')!;
    expect(box.value).toBe('@Maker ');
    expect(document.activeElement).toBe(el.querySelector('[contenteditable="true"]'));
  });

  it('changes the team lead model from the composer', async () => {
    const lead = state.data!.agents[0];
    lead.engine = 'claude-code';
    lead.model = 'sonnet';
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    await act(async () => el.querySelector<HTMLButtonElement>('.model-chip')!.click());
    const haiku = [...document.querySelectorAll<HTMLButtonElement>('.model-menu .st-menu-item')].find((button) =>
      button.textContent?.includes('Haiku (latest)'),
    );
    expect(haiku).toBeDefined();
    await act(async () => haiku!.click());
    await settle();
    expect(requests).toContain('PUT /api/agents/lead');
    expect(bodies['/api/agents/lead']).toMatchObject({ engine: 'claude-code', model: 'haiku' });
  });

  it('a team edited while its chat is open: the lead model control follows the new lead (BH-133)', async () => {
    for (const a of state.data!.agents) Object.assign(a, { engine: 'claude-code', model: 'sonnet' });
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    await act(async () =>
      FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: 'workflows', id: 't1', ts: 0 }) }),
    );
    await settle();
    await act(async () => el.querySelector<HTMLButtonElement>('.model-chip')!.click());
    const haiku = [...document.querySelectorAll<HTMLButtonElement>('.model-menu .st-menu-item')].find((button) =>
      button.textContent?.includes('Haiku (latest)'),
    );
    await act(async () => haiku!.click());
    await settle();
    expect(requests).toContain('PUT /api/agents/maker');
    expect(requests).not.toContain('PUT /api/agents/lead');
  });

  it('every "5m ago" shares one timer', () => {
    const spy = vi.spyOn(globalThis, 'setInterval');
    const offs = [clock(() => {}), clock(() => {}), clock(() => {})];
    expect(spy).toHaveBeenCalledTimes(1);
    offs.forEach((off) => off());
    // (all gone: the timer stops, and starts again for the next one)
    clock(() => {})();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('team chat search', () => {
  it('Ctrl+F (⌘F) searches the thread, and counts a message that arrives meanwhile', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    const bar = () => el.querySelector<HTMLElement>('[role="search"]');
    el.querySelector('textarea')!.focus();
    await act(
      async () =>
        void document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true, cancelable: true }),
        ),
    );
    expect(bar()).not.toBeNull();
    const box = bar()!.querySelector('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(box, 'thumbnail');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(bar()!.querySelector('[aria-live]')!.textContent).toBe('1 / 2');
    // a new message with the word: the count follows
    await teamEvent({
      kind: 'message',
      message: { id: 'm2', ts: 9, from: 'maker', text: 'The thumbnail is ready', mentions: [] },
    });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(bar()!.querySelector('[aria-live]')!.textContent).toBe('1 / 3');
    await act(
      async () =>
        void box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
    );
    expect(bar()).toBeNull();
  });
});

describe('team chat turns', () => {
  it("a working agent's turn streams in: its tool calls and text as they come", async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    // (the chat views load on demand: wait for the stream to be asked for)
    for (let i = 0; i < 100 && !requests.includes('GET /api/agents/maker/chats/maker-chat/stream'); i++) await settle();
    expect(requests).toContain('GET /api/agents/maker/chats/maker-chat/stream');
    const block = el.querySelector('.tc-live')!;
    expect(block.textContent).toContain('Maker');
    await act(async () => {
      live.push({ type: 'start', messageId: 'run-x' });
      live.push({
        type: 'tool-input-available',
        toolCallId: 'g1',
        toolName: 'comfyui_run',
        input: { workflow: 'thumb' },
        dynamic: true,
      });
      live.push({ type: 'text-start', id: 'a' });
      live.push({ type: 'text-delta', id: 'a', delta: 'Rendering the thumbnail' });
    });
    await settle();
    expect(block.querySelector('details.tool .tname')!.textContent).toBe('comfyui_run');
    expect(block.textContent).toContain('Rendering the thumbnail');
    // its turn ends: the live block goes (the reply comes as a message)
    await act(async () =>
      FakeSocket.last!.onmessage!({
        data: JSON.stringify({
          type: 'team',
          teamId: 't1',
          ts: 0,
          event: { kind: 'turn', agentId: 'maker', state: 'end' },
        }),
      }),
    );
    await settle();
    expect(el.querySelector('.tc-live')).toBeNull();
  });

  it("a message of yours the agent took into its turn isn't shown in it again: the thread shows it", async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    for (let i = 0; i < 100 && !requests.includes('GET /api/agents/maker/chats/maker-chat/stream'); i++) await settle();
    const block = el.querySelector('.tc-live')!;
    await act(async () => {
      live.push({ type: 'start', messageId: 'run-x' });
      live.push({ type: 'text-start', id: 'a' });
      live.push({ type: 'text-delta', id: 'a', delta: 'Rendering' });
      live.push({ type: 'text-end', id: 'a' });
      live.push({
        type: 'data-steer',
        data: {
          steerId: 's1',
          text: '[team message u2]\nYou (the user): use blue',
          from: 'You (the user)',
          teamMessageId: 'u2',
        },
      });
      // (one typed in the agent's own chat isn't in the thread: it stays)
      live.push({ type: 'data-steer', data: { steerId: 's2', text: 'and bigger' } });
    });
    await settle();
    expect(block.textContent).toContain('Rendering');
    expect(block.textContent).not.toContain('[team message');
    expect(block.textContent).not.toContain('use blue');
    expect(block.textContent).toContain('and bigger');
  });

  it('"Show the work" opens the steps and tool calls behind a reply', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    const work = el.querySelector('.tc-work')!;
    expect(work).not.toBeNull();
    expect(requests).not.toContain('GET /api/agents/lead/chats/lead-chat');
    const trigger = work.querySelector<HTMLButtonElement>('button')!;
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    for (let i = 0; i < 100 && !work.querySelector('details.tool'); i++) await settle();
    expect(requests).toContain('GET /api/agents/lead/chats/lead-chat');
    expect(work.querySelector('details.tool .tname')!.textContent).toBe('read_file');
    // (the message to the agent and its reply aren't repeated: the thread shows them)
    expect(work.textContent).not.toContain('team brief');
    expect(work.textContent).not.toContain('make the thumbnail');
    const loaded = requests.filter((request) => request === 'GET /api/agents/lead/chats/lead-chat').length;
    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await act(async () => trigger.click());
    await settle();
    expect(requests.filter((request) => request === 'GET /api/agents/lead/chats/lead-chat')).toHaveLength(loaded);
  });

  it('a turn stopped for your new message keeps its work on show, with a quiet line instead of a reply', async () => {
    missed = [
      {
        id: 'm2',
        ts: 2,
        from: 'lead',
        text: '(stopped to take your new message)',
        stopped: 'steer',
        mentions: [],
        turn: { chatId: 'lead-chat', from: 0, to: 3 },
      },
      // (saved before stops were marked: read from its text)
      { id: 'm3', ts: 3, from: 'lead', text: '(stopped)', mentions: [] },
    ];
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    const lines = [...el.querySelectorAll('.tc-stopped')].map((n) => n.textContent);
    expect(lines).toEqual([
      'Stopped to take your new message. Its work so far is kept.',
      'Stopped. Its work so far is kept.',
    ]);
    expect(el.textContent).not.toContain('(stopped');
    // its work is open from the start (no click), the steps it got done
    const work = el.querySelectorAll('.tc-work')[1]!;
    const trigger = work.querySelector<HTMLButtonElement>('button')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.textContent).toBe('Hide the work');
    for (let i = 0; i < 100 && !work.querySelector('details.tool'); i++) await settle();
    expect(work.querySelector('details.tool .tname')!.textContent).toBe('read_file');
    await act(async () => trigger.click());
    expect(trigger.textContent).toBe('Show the work');
  });

  it('a message of yours an agent took into its turn says so under it', async () => {
    missed = [
      { id: 'u2', ts: 2, from: 'user', text: 'use blue', mentions: [], joined: ['maker'] },
      { id: 'u3', ts: 3, from: 'user', text: 'thanks', mentions: [] },
    ];
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    expect([...el.querySelectorAll('.tc-joined')].map((n) => n.textContent)).toEqual(['Sent while Maker worked']);
  });

  it("a delegated member's report shows as one line, with the report behind Show the report", async () => {
    missed = [
      {
        id: 's1',
        ts: 2,
        from: 'system',
        text: 'Delegated work for @Maker finished:\n**1. Honeycomb** fits: a new Marketing Ops role.',
        mentions: [],
      },
      { id: 's2', ts: 3, from: 'system', text: 'Stopped. Nothing new will start until you write again.', mentions: [] },
    ];
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    const report = el.querySelector('.report-line')!;
    expect(report.firstElementChild!.textContent).toBe('Delegated work for @Maker finished.');
    expect(el.textContent).not.toContain('Honeycomb');
    // a plain line has nothing to open
    expect(el.querySelectorAll('.report-line')).toHaveLength(1);
    expect(el.textContent).toContain('Stopped. Nothing new will start until you write again.');
    const trigger = report.querySelector<HTMLButtonElement>('button')!;
    expect(trigger.textContent).toBe('Show the report');
    await act(async () => trigger.click());
    await settle();
    expect(trigger.textContent).toBe('Hide the report');
    expect(report.querySelector('strong')!.textContent).toBe('1. Honeycomb');
  });

  it('a long message folds with Show more; a short one does not', async () => {
    // (happy-dom has no layout: the lead's reply is made to measure tall)
    const tall = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.textContent?.includes('Plan:') ? 900 : 40;
    });
    try {
      const el = document.createElement('div');
      document.body.append(el);
      open = renderTeamChat(el, 't1');
      await settle();
      const more = [...el.querySelectorAll<HTMLButtonElement>('.tc-more')];
      expect(more).toHaveLength(1);
      expect(more[0].closest('.tc-msg')!.textContent).toContain('Plan:');
      expect(el.querySelectorAll('.tc-folded')).toHaveLength(1);
      expect(more[0].textContent).toBe('Show more');
      await act(async () => more[0].click());
      expect(el.querySelector('.tc-folded')).toBeNull();
      expect(more[0].textContent).toBe('Show less');
      expect(more[0].getAttribute('aria-expanded')).toBe('true');
      await act(async () => more[0].click());
      expect(more[0].getAttribute('aria-expanded')).toBe('false');
      expect(el.querySelector('.tc-folded')).not.toBeNull();
    } finally {
      tall.mockRestore();
    }
  });

  it('a state update that still lists a finished agent as working does not bring its turn back', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    for (let i = 0; i < 100 && !el.querySelector('.tc-live'); i++) await settle();
    await teamEvent({ kind: 'turn', agentId: 'maker', state: 'end' });
    // (the server's state can lag: it still says Maker is working)
    await teamEvent({ kind: 'state', working: ['maker'], queued: [] });
    await settle();
    expect(el.querySelector('.tc-live')).toBeNull();
    // a new turn does show
    await teamEvent({ kind: 'turn', agentId: 'maker', state: 'start', chatId: 'maker-chat' });
    await settle();
    expect(el.querySelector('.tc-live')).not.toBeNull();
  });

  it('a turn that ends while the chat loads stays ended when the load comes back (BH-132)', async () => {
    let letLoad = () => {};
    holdLoad = new Promise<void>((r) => (letLoad = r));
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    // the server's snapshot (Maker working) was taken, and then Maker's turn ended, before it arrives
    await teamEvent({ kind: 'turn', agentId: 'maker', state: 'end' });
    letLoad();
    for (let i = 0; i < 20 && !el.textContent?.includes('Make a thumbnail'); i++) await settle();
    expect(el.textContent).toContain('Make a thumbnail');
    expect(el.querySelector('.tc-live')).toBeNull();
  });

  it('coming back after events dropped follows the session the server has now, not the one from before (BH-131)', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    for (let i = 0; i < 100 && !el.querySelector('.tc-live'); i++) await settle();
    // (the first connection: after it, an open is a reconnect)
    await act(async () => FakeSocket.last!.onopen!());
    // while events were down, the team moved to another conversation: Maker works in a new session
    snapshotSessions = { lead: 'lead-chat', maker: 'maker-chat-2' };
    requests = [];
    await act(async () => FakeSocket.last!.onopen!());
    for (let i = 0; i < 20 && !requests.some((r) => r.includes('maker-chat-2')); i++) await settle();
    expect(requests).toContain('GET /api/agents/maker/chats/maker-chat-2/stream');
  });

  it('clearing the chat takes the live turns away with the sessions', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    for (let i = 0; i < 100 && !el.querySelector('.tc-live'); i++) await settle();
    await teamEvent({ kind: 'cleared' });
    await settle();
    expect(el.querySelector('.tc-live')).toBeNull();
    expect(el.querySelector('.tc-work')).toBeNull();
  });

  it('no flicker: messages are kept, never rebuilt or taken out, as events and streamed words come', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    for (let i = 0; i < 100 && el.querySelectorAll('.tc-msg:not(.tc-live)').length < 2; i++) await settle();
    const list = el.querySelector('.tc-list')!;
    const before = [...list.querySelectorAll(':scope > .tc-msg:not(.tc-live)')];
    expect(before).toHaveLength(2);
    // watch for any message leaving the list (that is what replays its entrance)
    const removed: Node[] = [];
    const watch = new MutationObserver((rs) => rs.forEach((r) => removed.push(...r.removedNodes)));
    watch.observe(list, { childList: true });
    // a working agent's words (each one used to redraw the whole thread), then a new message
    for (const w of ['Rendering', ' the', ' thumbnail'])
      await act(async () =>
        FakeSocket.last!.onmessage!({
          data: JSON.stringify({
            type: 'run',
            ts: 0,
            runId: 'r',
            agentId: 'maker',
            chatId: 'maker-chat',
            event: { kind: 'text', text: w },
          }),
        }),
      );
    await teamEvent({
      kind: 'message',
      message: { id: 'm2', ts: 2, from: 'maker', text: 'Done, saved as thumb.png.', mentions: [] },
    });
    await settle();
    watch.disconnect();
    const after = [...list.querySelectorAll(':scope > .tc-msg:not(.tc-live)')];
    expect(after).toHaveLength(3);
    // the same nodes, in place, and none taken out
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[0]).toBe(before[0]);
    expect(removed.filter((n) => before.includes(n as Element))).toEqual([]);
    // the status line still says what the working agent does
    expect(el.querySelector('.tc-status')!.textContent).toContain('Maker is working · writing');
  });

  it('/queue while the team works: held until it is done, shown, × takes it back, Stop gives it back', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    const box = el.querySelector('textarea')!;
    expect(box.placeholder).toContain('/queue');
    box.value = '/queue then the banner';
    await act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
    expect(bodies['/api/teams/t1/queue']).toEqual({ text: 'then the banner', replyTo: null, attachments: [] });
    expect(requests).not.toContain('POST /api/teams/t1/messages');
    expect(el.querySelector('.queued-msg')!.textContent).toContain('then the banner');
    expect(el.querySelector('.queued-head')!.textContent).toBe('Sends when the team is done');
    // the server's state says it was posted: it leaves the list
    await teamEvent({ kind: 'state', working: ['lead'], queued: [], held: [] });
    await settle();
    expect(el.querySelector('.queued-list')).toBeNull();
    await teamEvent({ kind: 'state', working: ['lead'], queued: [], held: [{ id: 'q2', text: 'and a logo', ts: 6 }] });
    await settle();
    (el.querySelector(`.queued-msg button[aria-label="Don't send this"]`) as HTMLButtonElement).click();
    await settle();
    expect(requests).toContain('DELETE /api/teams/t1/queue/q2');
    expect(el.querySelector('.queued-msg')).toBeNull();
    // Stop: the held ones come back to the box
    (el.querySelector('button[aria-label="Stop"]') as HTMLButtonElement).click();
    await settle();
    expect(box.value).toBe('and a logo');
  });

  it('while the team works, an empty box shows Stop; something typed shows Send, and it goes as a steer', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    const box = el.querySelector('textarea')!;
    const stopBtn = () => el.querySelector('button[aria-label="Stop"]');
    const sendBtn = () => el.querySelector('button[aria-label="Send"]');
    // (Maker is working)
    expect(stopBtn()).not.toBeNull();
    expect(sendBtn()).toBeNull();
    box.value = 'use blue instead';
    await act(async () => box.dispatchEvent(new Event('input')));
    expect(stopBtn()).toBeNull();
    expect(sendBtn()).not.toBeNull();
    await act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
    expect(bodies['/api/teams/t1/steer']).toEqual({ text: 'use blue instead', replyTo: null, attachments: [] });
    expect(requests).not.toContain('POST /api/teams/t1/messages');
    // sent: the box is empty again, so Stop is back
    expect(stopBtn()).not.toBeNull();
    // nobody working: Send even with an empty box, and a plain message
    await teamEvent({ kind: 'state', working: [], queued: [], held: [] });
    await settle();
    expect(stopBtn()).toBeNull();
    expect(sendBtn()).not.toBeNull();
    box.value = 'thanks';
    await act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
    expect(requests).toContain('POST /api/teams/t1/messages');
  });

  it('queued messages: Up in an empty box changes the last one, Enter keeps it, Esc drops the change', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    await teamEvent({
      kind: 'state',
      working: ['maker'],
      queued: [],
      held: [
        { id: 'q1', text: 'first', ts: 1 },
        { id: 'q2', text: 'second', ts: 2 },
      ],
    });
    await settle();
    const box = el.querySelector('textarea')!;
    const key = (t: Element, k: string, more: KeyboardEventInit = {}) =>
      act(async () => t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...more })));
    // (not with words in the box: Up moves in them)
    box.value = 'draft';
    await key(box, 'ArrowUp');
    expect(el.querySelector('.queued-edit')).toBeNull();
    box.value = '';
    await key(box, 'ArrowUp');
    const edit = el.querySelector<HTMLTextAreaElement>('.queued-edit')!;
    expect(edit.value).toBe('second');
    expect(document.activeElement).toBe(edit);
    edit.value = 'second, in blue';
    await key(edit, 'Enter');
    await settle();
    expect(requests).toContain('PUT /api/teams/t1/queue/q2');
    expect(bodies['/api/teams/t1/queue/q2']).toEqual({ text: 'second, in blue' });
    expect(el.querySelector('.queued-edit')).toBeNull();
    expect([...el.querySelectorAll('.queued-text')].map((n) => n.textContent)).toEqual(['first', 'second, in blue']);
    expect(document.activeElement).toBe(el.querySelector('[contenteditable="true"]'));
    // Up again, then Up at the start goes on to the one above; Esc keeps it as it was
    await key(box, 'ArrowUp');
    const again = el.querySelector<HTMLTextAreaElement>('.queued-edit')!;
    again.setSelectionRange(0, 0);
    await key(again, 'ArrowUp');
    const above = el.querySelector<HTMLTextAreaElement>('.queued-edit')!;
    expect(above.value).toBe('first');
    above.value = 'never mind';
    await key(above, 'Escape');
    await settle();
    expect(requests.filter((r) => r.startsWith('PUT'))).toEqual(['PUT /api/teams/t1/queue/q2']);
    expect(el.querySelector('.queued-text')!.textContent).toBe('first');
  });

  it('a change to a queued message that fails goes back; one already posted comes to the box', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    await teamEvent({
      kind: 'state',
      working: ['maker'],
      queued: [],
      held: [
        { id: 'q1', text: 'first', ts: 1 },
        { id: 'q2', text: 'second', ts: 2 },
      ],
    });
    await settle();
    const box = el.querySelector('textarea')!;
    const key = (t: Element, k: string) =>
      act(async () => t.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })));
    const texts = () => [...el.querySelectorAll('.queued-text')].map((n) => n.textContent);
    // not saved: it shows what will go after all
    await key(box, 'ArrowUp');
    el.querySelector<HTMLTextAreaElement>('.queued-edit')!.value = 'boom';
    await key(el.querySelector('.queued-edit')!, 'Enter');
    await settle();
    expect(texts()).toEqual(['first', 'second']);
    expect(box.value).toBe('');
    // posted before the change got there: the new words come to the box
    await key(box, 'ArrowUp');
    el.querySelector<HTMLTextAreaElement>('.queued-edit')!.value = 'gone';
    await key(el.querySelector('.queued-edit')!, 'Enter');
    await settle();
    expect(box.value).toBe('gone');
  });

  it('queued messages change order by dragging one, or with Alt+Up / Alt+Down', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    await teamEvent({
      kind: 'state',
      working: ['maker'],
      queued: [],
      held: [
        { id: 'q1', text: 'first', ts: 1 },
        { id: 'q2', text: 'second', ts: 2 },
        { id: 'q3', text: 'third', ts: 3 },
      ],
    });
    await settle();
    const order = () => [...el.querySelectorAll('.queued-text')].map((n) => n.textContent);
    const row = (id: string) => el.querySelector(`[data-qid="${id}"]`)!;
    const drag = (type: string, target: Element, dataTransfer: DataTransfer) =>
      act(
        async () => void target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer })),
      );
    // third dragged onto the top half of first: it goes above it
    const dt = new DataTransfer();
    await drag('dragstart', row('q3'), dt);
    await drag('dragover', row('q1'), dt);
    await drag('drop', row('q1'), dt);
    await drag('dragend', row('q3'), dt);
    await settle();
    expect(order()).toEqual(['third', 'first', 'second']);
    expect(bodies['/api/teams/t1/queue/order']).toEqual({ ids: ['q3', 'q1', 'q2'] });
    // the keyboard: Alt+Down moves it one down
    await act(
      async () =>
        void row('q3')
          .querySelector('.queued-text')!
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })),
    );
    await settle();
    expect(order()).toEqual(['first', 'third', 'second']);
    expect(bodies['/api/teams/t1/queue/order']).toEqual({ ids: ['q1', 'q3', 'q2'] });
  });

  it('/loop off ends the loop and leaves the files staged for the next message', async () => {
    // (an upload that is still going: before, /loop off waited for it and then took the files)
    class SlowXHR {
      upload = { onprogress: null };
      open() {}
      setRequestHeader() {}
      send() {}
      abort() {}
    }
    vi.stubGlobal('XMLHttpRequest', SlowXHR);
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    const fileIn = el.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(fileIn, 'files', { value: [new File(['x'], 'notes.txt')], configurable: true });
    await act(async () => void fileIn.dispatchEvent(new Event('change')));
    await settle();
    expect(el.querySelectorAll('.att-chip').length).toBe(1);
    const box = el.querySelector('textarea')!;
    box.value = '/loop off';
    await act(async () => void box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await settle();
    expect(bodies['/api/teams/t1/loop']).toEqual({ text: 'off', attachments: [] });
    expect(el.querySelectorAll('.att-chip').length).toBe(1);
    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  it('after the event socket comes back, the chat loads again (what was missed shows)', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    // (the first connection, opened)
    await act(async () => FakeSocket.last!.onopen!());
    await settle();
    const before = requests.filter((r) => r === 'GET /api/teams/t1/chat').length;
    // the socket drops and comes back (a new one opens)
    await act(async () => {
      FakeSocket.last!.onclose!();
      await new Promise((r) => setTimeout(r, 1600));
    });
    missed = [{ id: 'm2', ts: 2, from: 'maker', text: 'Thumbnail is ready.', mentions: [] }];
    await act(async () => FakeSocket.last!.onopen!());
    await settle();
    expect(requests.filter((r) => r === 'GET /api/teams/t1/chat').length).toBe(before + 1);
    expect(el.textContent).toContain('Thumbnail is ready.');
  });

  it('/ commands: the menu, /goal and /loop go to the server, the loop and goal show as chips', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    open = renderTeamChat(el, 't1');
    await settle();
    const box = el.querySelector('textarea')!;
    const enter = () =>
      act(async () => box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    box.value = '/go';
    box.dispatchEvent(new Event('input'));
    expect([...el.querySelectorAll('.slash-menu .slash-name')].map((n) => n.textContent)).toEqual(['/goal']);
    box.value = '/goal a launch plan everyone signed off';
    box.dispatchEvent(new Event('input'));
    await enter();
    await settle();
    expect(bodies['/api/teams/t1/goal']).toEqual({ text: 'a launch plan everyone signed off' });
    box.value = '/loop 2x status please';
    await enter();
    await settle();
    expect(bodies['/api/teams/t1/loop']).toEqual({ text: '2x status please', attachments: [] });
    expect(requests).not.toContain('POST /api/teams/t1/messages');
    await teamEvent({
      kind: 'state',
      working: ['lead'],
      queued: [],
      held: [],
      loop: { text: 'status please', every: null, times: 2, done: 1, next: null },
    });
    await act(async () =>
      FakeSocket.last!.onmessage!({
        data: JSON.stringify({
          type: 'brief',
          ts: 0,
          brief: {
            id: 'b1',
            kind: 'team',
            targetId: 't1',
            name: 'Thumbs',
            text: 'x',
            goal: 'a launch plan everyone signed off',
            ts: 0,
            followUps: 0,
            status: 'open',
          },
        }),
      }),
    );
    await settle();
    expect(el.querySelector('.cmd-chip.loop')!.textContent).toContain('after each answer · 1 of 2 sent');
    expect(el.querySelector('.cmd-chip.goal')!.textContent).toContain('Goal: a launch plan everyone signed off');
    (el.querySelector('.cmd-chip.loop button') as HTMLButtonElement).click();
    await settle();
    expect(requests).toContain('DELETE /api/teams/t1/loop');
    box.value = '/resume';
    await enter();
    await settle();
    expect(requests).toContain('POST /api/teams/t1/resume');
  });
});
