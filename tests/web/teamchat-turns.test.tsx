// A team chat with the Vercel AI SDK: a working agent's turn streams in (its text and tool calls), and
// "Show the work" opens the steps and tool calls behind a finished reply.
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { connectEvents, state } from '../../web/core.ts';
import { forgetFiles } from '../../web/filepreview.ts';
import { renderTeamChat } from '../../web/teamchat.ts';
import type { TeamChatApi } from '../../web/teamchat.ts';
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
    response: () => new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } }),
    push: (c: UIMessageChunk) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`)),
    end: () => (ctl.enqueue(enc.encode('data: [DONE]\n\n')), ctl.close()),
  };
}

const SESSION: ChatItem[] = [
  { type: 'user', text: 'team brief…' },
  { type: 'tool', id: 'r1', name: 'read_file', args: { path: 'brief.md' }, result: 'the brief', status: 'done' },
  { type: 'assistant', text: 'Plan: @Maker make the thumbnail.' },
];
let live: ReturnType<typeof uiStream>;
let requests: string[];
let bodies: Record<string, unknown>;
const settle = () => act(() => new Promise((r) => setTimeout(r, 40)));

beforeAll(() => {
  vi.stubGlobal('WebSocket', FakeSocket);
  connectEvents();
});
beforeEach(() => {
  forgetFiles();
  requests = [];
  bodies = {};
  live = uiStream();
  state.data = { runs: [], approvals: [], agents: [{ id: 'lead', name: 'Lead', emoji: '🧭', color: '#fff' }, { id: 'maker', name: 'Maker', emoji: '🎨', color: '#fff' }] } as unknown as AppState;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    requests.push(`${init.method || 'GET'} ${url}`);
    if (init.body) bodies[url] = JSON.parse(String(init.body));
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    if (url === '/api/teams/t1/chat')
      return json({
        team: { id: 't1', name: 'Thumbs', members: ['lead', 'maker'], lead: 'lead', steps: [] },
        messages: [
          { id: 'u1', ts: 0, from: 'user', text: 'Make a thumbnail', mentions: [] },
          { id: 'm1', ts: 1, from: 'lead', text: 'Plan: @Maker make the thumbnail.', mentions: ['maker'], turn: { chatId: 'lead-chat', from: 0, to: 3 } },
        ],
        working: ['maker'],
        queued: [],
        sessions: { lead: 'lead-chat', maker: 'maker-chat' },
      });
    if (url === '/api/agents/maker/chats/maker-chat/stream') return live.response();
    if (url === '/api/teams/t1/queue') return json({ queued: { id: 'q1', text: 'then the banner', ts: 5 } });
    if (url === '/api/teams/t1/stop') return json({ ok: true, unqueued: [{ id: 'q2', text: 'and a logo', ts: 6 }] });
    if (url === '/api/agents/lead/chats/lead-chat') return json({ id: 'lead-chat', agentId: 'lead', items: SESSION } as Partial<Chat>);
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
const teamEvent = (event: object) => act(async () => FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: 'team', teamId: 't1', ts: 0, event }) }));

describe('team chat turns', () => {
  it("a working agent's turn streams in: its tool calls and text as they come", async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const chat = (open = renderTeamChat(el, 't1'));
    // (the chat views load on demand: wait for the stream to be asked for)
    for (let i = 0; i < 100 && !requests.includes('GET /api/agents/maker/chats/maker-chat/stream'); i++) await settle();
    expect(requests).toContain('GET /api/agents/maker/chats/maker-chat/stream');
    const block = el.querySelector('.tc-live')!;
    expect(block.textContent).toContain('Maker');
    await act(async () => {
      live.push({ type: 'start', messageId: 'run-x' });
      live.push({ type: 'tool-input-available', toolCallId: 'g1', toolName: 'comfyui_run', input: { workflow: 'thumb' }, dynamic: true });
      live.push({ type: 'text-start', id: 'a' });
      live.push({ type: 'text-delta', id: 'a', delta: 'Rendering the thumbnail' });
    });
    await settle();
    expect(block.querySelector('details.tool .tname')!.textContent).toBe('comfyui_run');
    expect(block.textContent).toContain('Rendering the thumbnail');
    // its turn ends: the live block goes (the reply comes as a message)
    await act(async () => FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: 'team', teamId: 't1', ts: 0, event: { kind: 'turn', agentId: 'maker', state: 'end' } }) }));
    await settle();
    expect(el.querySelector('.tc-live')).toBeNull();
  });

  it('"Show the work" opens the steps and tool calls behind a reply', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const chat = (open = renderTeamChat(el, 't1'));
    await settle();
    const work = el.querySelector('details.tc-work') as HTMLDetailsElement;
    expect(work).not.toBeNull();
    expect(requests).not.toContain('GET /api/agents/lead/chats/lead-chat');
    await act(async () => {
      work.open = true;
      work.dispatchEvent(new Event('toggle'));
    });
    for (let i = 0; i < 100 && !work.querySelector('details.tool'); i++) await settle();
    expect(requests).toContain('GET /api/agents/lead/chats/lead-chat');
    expect(work.querySelector('details.tool .tname')!.textContent).toBe('read_file');
    // (the message to the agent isn't repeated: the thread shows it)
    expect(work.textContent).not.toContain('team brief');
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
    for (const w of ['Rendering', ' the', ' thumbnail']) await act(async () => FakeSocket.last!.onmessage!({ data: JSON.stringify({ type: 'run', ts: 0, runId: 'r', agentId: 'maker', chatId: 'maker-chat', event: { kind: 'text', text: w } }) }));
    await teamEvent({ kind: 'message', message: { id: 'm2', ts: 2, from: 'maker', text: 'Done, saved as thumb.png.', mentions: [] } });
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
    expect(el.querySelector('.queued-list')!.classList.contains('hidden')).toBe(true);
    await teamEvent({ kind: 'state', working: ['lead'], queued: [], held: [{ id: 'q2', text: 'and a logo', ts: 6 }] });
    await settle();
    (el.querySelector('.queued-msg button') as HTMLButtonElement).click();
    await settle();
    expect(requests).toContain('DELETE /api/teams/t1/queue/q2');
    expect(el.querySelector('.queued-msg')).toBeNull();
    // Stop: the held ones come back to the box
    [...el.querySelectorAll('button')].find((b) => b.textContent === 'Stop')!.click();
    await settle();
    expect(box.value).toBe('and a logo');
  });
});
