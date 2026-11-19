// The Slack and Discord connections against fake sockets (ws mocked) and fake APIs (fetch stubbed): what they make of
// events, what they acknowledge, how Discord identifies, resumes and gives up on a setting you must change.
import type { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackTransport } from '../../server/gateways/slack.ts';
import { DiscordTransport } from '../../server/gateways/discord.ts';
import { GatewaySetupError } from '../../server/gateways/transport.ts';
import type { Incoming } from '../../server/gateways/transport.ts';

const sockets = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('ws', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeSocket extends Emitter {
    url: string;
    sent: unknown[] = [];
    closed: number | null = null;
    constructor(url: string) {
      super();
      this.url = url;
      sockets.list.push(this);
    }
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    close(code = 1000) {
      if (this.closed !== null) return;
      this.closed = code;
      queueMicrotask(() => this.emit('close', code));
    }
  }
  return { default: FakeSocket };
});
type Socket = EventEmitter & { url: string; sent: Record<string, unknown>[]; close(code?: number): void };
const socket = (i = -1) => sockets.list.at(i) as Socket;
const say = (s: Socket, data: unknown) => s.emit('message', Buffer.from(JSON.stringify(data)));
const tick = () => new Promise((r) => setTimeout(r, 10));

let api: { url: string; body: string; headers: Record<string, string> }[] = [];
function stubFetch(answer: (url: string, body: string) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? '');
      api.push({ url, body, headers: (init?.headers || {}) as Record<string, string> });
      const value = answer(url, body);
      return value instanceof Response ? value : Response.json(value);
    }),
  );
}
beforeEach(() => {
  sockets.list = [];
  api = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('Slack (Socket Mode)', () => {
  beforeEach(() =>
    stubFetch((url, body) => {
      if (url.endsWith('auth.test')) return { ok: true, user_id: 'UBOT', user: 'athena', team: 'Acme' };
      if (url.endsWith('apps.connections.open')) return { ok: true, url: 'wss://slack.test/socket' };
      if (url.endsWith('users.info')) return { ok: true, user: { profile: { display_name: 'Ann' } } };
      if (url.endsWith('conversations.info')) return { ok: true, channel: { name: 'general' } };
      if (url.endsWith('chat.postMessage')) return { ok: true, sent: body };
      return { ok: false, error: 'unknown_method' };
    }),
  );

  it('acknowledges every event and takes direct messages and mentions, answering mentions in their thread', async () => {
    const slack = new SlackTransport('xoxb-1', 'xapp-1');
    const got: Incoming[] = [];
    let ready = '';
    const stop = new AbortController();
    const running = slack.run({ onMessage: (m) => got.push(m), onReady: (b) => (ready = b) }, stop.signal);
    await tick();
    const s = socket();
    expect(s.url).toBe('wss://slack.test/socket');
    // (the app-level token opens the socket; the bot token does the rest)
    expect(api.find((c) => c.url.endsWith('apps.connections.open'))?.headers.authorization).toBe('Bearer xapp-1');
    say(s, { type: 'hello' });
    expect(ready).toBe('@athena in Acme');
    const event = (id: string, e: Record<string, unknown>) =>
      say(s, { envelope_id: id, type: 'events_api', payload: { event: e } });
    event('e1', { type: 'app_mention', user: 'U1', channel: 'C1', ts: '100.1', text: '<@UBOT> hello' });
    event('e2', { type: 'message', channel_type: 'im', user: 'U1', channel: 'D1', ts: '200.1', text: 'hi' });
    // (channel messages come as mentions; its own messages and edits are not new messages)
    event('e3', { type: 'message', channel_type: 'channel', user: 'U1', channel: 'C1', ts: '300.1', text: 'x' });
    event('e4', { type: 'message', channel_type: 'im', user: 'UBOT', channel: 'D1', ts: '400.1', text: 'me' });
    event('e5', { type: 'message', subtype: 'message_changed', channel_type: 'im', channel: 'D1', ts: '500.1' });
    await tick();
    expect(s.sent).toEqual(['e1', 'e2', 'e3', 'e4', 'e5'].map((envelope_id) => ({ envelope_id })));
    expect(got).toEqual([
      expect.objectContaining({
        sourceId: '100.1',
        chat: { chatId: 'C1', threadId: '100.1', title: '#general', direct: false },
        sender: { id: 'U1', name: 'Ann', bot: false },
        text: 'hello',
        addressed: true,
      }),
      expect.objectContaining({ chat: { chatId: 'D1', title: 'Ann', direct: true }, text: 'hi' }),
    ]);
    await slack.send({ chatId: 'C1', threadId: '100.1' }, 'Answer');
    const posted = new URLSearchParams(api.at(-1)!.body);
    expect(posted.get('channel')).toBe('C1');
    expect(posted.get('thread_ts')).toBe('100.1');
    expect(api.at(-1)!.headers.authorization).toBe('Bearer xoxb-1');
    stop.abort();
    await running;
  });

  it('gives a setup error for a refused token, and fetches files only from Slack', async () => {
    stubFetch(() => ({ ok: false, error: 'invalid_auth' }));
    const slack = new SlackTransport('xoxb-1', 'xapp-1');
    await expect(slack.run({ onMessage: () => {}, onReady: () => {} }, new AbortController().signal)).rejects.toThrow(
      GatewaySetupError,
    );
    await expect(
      slack.download({ name: 'a', ref: 'https://evil.test/file' }, new AbortController().signal),
    ).rejects.toThrow('not on Slack');
  });
});

describe('Discord (Gateway)', () => {
  beforeEach(() =>
    stubFetch((url) => {
      if (url.endsWith('/gateway/bot')) return { url: 'wss://gateway.discord.test' };
      if (url.endsWith('/channels/T1')) return { id: 'T1', type: 11, name: 'ideas', parent_id: 'C1' };
      if (url.includes('/messages')) return { id: 'sent' };
      return new Response(null, { status: 204 });
    }),
  );

  it('identifies, beats, takes mentions and direct messages, and resumes after a dropped connection', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const discord = new DiscordTransport('TOKEN');
      const got: Incoming[] = [];
      const ready: string[] = [];
      const stop = new AbortController();
      const handlers = { onMessage: (m: Incoming) => got.push(m), onReady: (b: string) => ready.push(b) };
      const first = discord.run(handlers, stop.signal);
      await tick();
      const s = socket();
      expect(s.url).toBe('wss://gateway.discord.test/?v=10&encoding=json');
      say(s, { op: 10, d: { heartbeat_interval: 1000 } });
      expect(s.sent[0]).toMatchObject({ op: 2, d: { token: 'TOKEN', intents: 37377 } });
      say(s, {
        op: 0,
        t: 'READY',
        s: 1,
        d: { user: { id: 'BOT', username: 'athena' }, session_id: 'S1', resume_gateway_url: 'wss://resume.test' },
      });
      expect(ready).toEqual(['@athena']);
      vi.advanceTimersByTime(1000);
      expect(s.sent.at(-1)).toEqual({ op: 1, d: 1 });
      say(s, { op: 11 });
      const create = (s2: number, d: Record<string, unknown>) =>
        say(s, { op: 0, t: 'MESSAGE_CREATE', s: s2, d: { type: 0, attachments: [], mentions: [], ...d } });
      create(2, {
        id: 'M1',
        channel_id: 'T1',
        guild_id: 'G1',
        author: { id: 'U1', username: 'ann', global_name: 'Ann' },
        content: '<@BOT> look',
        mentions: [{ id: 'BOT' }],
        attachments: [{ filename: 'a.png', size: 3, url: 'https://cdn.discordapp.com/a.png' }],
      });
      create(3, { id: 'M2', channel_id: 'D1', author: { id: 'U1', username: 'ann' }, content: 'dm' });
      create(4, { id: 'M3', channel_id: 'D1', author: { id: 'BOT', username: 'athena' }, content: 'mine' });
      await tick();
      expect(got).toEqual([
        expect.objectContaining({
          sourceId: 'M1',
          chat: { chatId: 'T1', title: '#ideas', direct: false, parentId: 'C1' },
          text: 'look',
          addressed: true,
          files: [{ name: 'a.png', size: 3, ref: 'https://cdn.discordapp.com/a.png' }],
        }),
        expect.objectContaining({ sourceId: 'M2', chat: { chatId: 'D1', title: 'ann', direct: true }, text: 'dm' }),
      ]);
      // dropped: the next connection resumes where it was
      s.close(4000);
      await first;
      const second = discord.run(handlers, stop.signal);
      await tick();
      const r = socket();
      expect(r.url).toBe('wss://resume.test/?v=10&encoding=json');
      say(r, { op: 10, d: { heartbeat_interval: 1000 } });
      expect(r.sent[0]).toEqual({ op: 6, d: { token: 'TOKEN', session_id: 'S1', seq: 4 } });
      stop.abort();
      await second;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops with what to change when Discord refuses the intents', async () => {
    const discord = new DiscordTransport('TOKEN');
    const running = discord.run({ onMessage: () => {}, onReady: () => {} }, new AbortController().signal);
    await tick();
    socket().close(4014);
    await expect(running).rejects.toThrow('Message Content Intent');
  });

  it('answers as a reply without pinging anyone, and fetches files only from its CDN', async () => {
    const discord = new DiscordTransport('TOKEN');
    await discord.send({ chatId: 'C1' }, 'Hi @everyone', 'M1');
    expect(api.at(-1)!.url).toMatch(/\/channels\/C1\/messages$/);
    expect(JSON.parse(api.at(-1)!.body)).toEqual({
      content: 'Hi @everyone',
      allowed_mentions: { parse: [] },
      message_reference: { message_id: 'M1', fail_if_not_exists: false },
    });
    expect(api.at(-1)!.headers.authorization).toBe('Bot TOKEN');
    await expect(
      discord.download({ name: 'a', ref: 'https://evil.test/a.png' }, new AbortController().signal),
    ).rejects.toThrow('not on Discord');
  });
});
