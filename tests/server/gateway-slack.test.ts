import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { Chat } from 'chat';
import type { Logger } from 'chat';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox, gatewayInputAllowed } from '../../server/gateways/inbox.ts';
import { SlackIntakeAdapter } from '../../server/gateways/slack.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { gatewayConfig } from './gateway-fixtures.ts';
import { newAgent } from '../../server/library.ts';

const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
let account = 80000;
function message(id = '1700000000.000001', changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'message', channel: 'DALICE', channel_type: 'im', user: 'UALICE', ts: id, text: 'Hello', ...changes };
}
async function fixture(options: { users?: string[]; scope?: string[]; directMessages?: boolean; authTeam?: string; authEnterprise?: boolean; authError?: boolean } = {}) {
  const config = { ...gatewayConfig(`T${account++}`), platform: 'slack', senderPolicy: { platform: 'slack', allowedUserIds: options.users ?? [] },
    scope: { directMessages: options.directMessages ?? true, conversationIds: options.scope ?? ['CLOCAL'], guildIds: [] } };
  const instance = saveGatewayInstance(config); const state = new GatewayStateAdapter(instance.id); await state.connect();
  const inbox = new GatewayInbox(state); const abort = new AbortController();
  const acks: string[] = []; const calls: { method: string; token: string; fields: URLSearchParams }[] = []; const activity: boolean[] = [];
  let peer: WebSocket | undefined; let gate: (() => Promise<void>) | undefined;
  let userChanges: Record<string, unknown> = {}; let channelChanges: Record<string, unknown> = {};
  let apiError: string | undefined;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const method = request.url?.split('/').at(-1) ?? ''; const fields = new URLSearchParams(Buffer.concat(chunks).toString());
    calls.push({ method, token: request.headers.authorization ?? '', fields });
    let result: unknown;
    if (method === 'auth.test') result = options.authError ? { ok: false, error: 'invalid_auth', private: 'PRIVATE_BOT_TOKEN' }
      : { ok: true, team_id: options.authTeam ?? instance.accountId, user_id: 'UBOT', bot_id: 'BBOT', is_enterprise_install: options.authEnterprise ?? false };
    else if (method === 'bots.info') result = { ok: true, bot: { id: 'BBOT', user_id: 'UBOT', app_id: 'AAPP' } };
    else if (method === 'apps.connections.open') {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
      result = { ok: true, url: `ws://127.0.0.1:${address.port}/socket` };
    } else if (method === 'users.info') {
      await gate?.();
      result = apiError ? { ok: false, error: apiError, private: 'PRIVATE_PROVIDER_DETAIL' } : { ok: true, user: { id: fields.get('user'), team_id: instance.accountId, deleted: false, is_bot: false, is_app_user: false, profile: { display_name: 'Alice' }, ...userChanges } };
    } else if (method === 'conversations.info') {
      const id = fields.get('channel'); const direct = id?.startsWith('D');
      result = { ok: true, channel: { id, user: direct ? 'UALICE' : undefined, is_im: direct, is_mpim: false, is_ext_shared: false, is_org_shared: false, is_archived: false, is_member: true, ...channelChanges } };
    } else result = { ok: false, error: 'unexpected_request' };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => {
    peer = socket; socket.on('message', (value) => { const result = JSON.parse(value.toString()) as { envelope_id: string }; acks.push(result.envelope_id); });
    socket.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const adapter = new SlackIntakeAdapter(instance.id, inbox, 'xoxb-PRIVATE_BOT_TOKEN', 'xapp-PRIVATE_APP_TOKEN', (connected) => activity.push(connected), { apiUrl: `http://127.0.0.1:${address.port}/`, signal: abort.signal });
  const chat = new Chat({ userName: 'Athena', adapters: { slack: adapter }, state, logger: quiet, concurrency: 'concurrent' });
  closes.push(async () => { await chat.shutdown(); await state.disconnect(); for (const socket of sockets.clients) socket.terminate(); sockets.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  let sequence = 0;
  const send = (event: Record<string, unknown>, changes: Record<string, unknown> = {}, socketType = 'events_api') => {
    if (!peer) throw new Error('No socket'); const id = `envelope-${++sequence}`;
    peer.send(JSON.stringify({ envelope_id: id, type: socketType, payload: { type: 'event_callback', team_id: instance.accountId, api_app_id: 'AAPP', event_id: `Ev${sequence}`, event, ...changes } }));
    return id;
  };
  const delivered = async (event: Record<string, unknown>, changes: Record<string, unknown> = {}, type?: string) => {
    const id = send(event, changes, type); await expect.poll(() => acks.includes(id)).toBe(true); return id;
  };
  return { config, instance, state, inbox, adapter, chat, calls, acks, activity, abort, send, delivered,
    user: (changes: Record<string, unknown>) => { userChanges = changes; }, channel: (changes: Record<string, unknown>) => { channelChanges = changes; },
    gate: (value?: () => Promise<void>) => { gate = value; }, error: (value?: string) => { apiError = value; } };
}

describe('Slack durable Socket Mode intake', () => {
  it('authenticates both tokens separately and commits text/file descriptors before acknowledging', async () => {
    const f = await fixture(); await f.chat.initialize();
    expect(f.calls.find((call) => call.method === 'auth.test')?.token).toBe('Bearer xoxb-PRIVATE_BOT_TOKEN');
    expect(f.calls.find((call) => call.method === 'apps.connections.open')?.token).toBe('Bearer xapp-PRIVATE_APP_TOKEN');
    const id = await f.delivered(message('1700000000.000001', { text: '', files: [{ id: 'FFILE', name: 'plan.pdf', mimetype: 'application/pdf', size: 123, url_private: 'https://private-file/PRIVATE_URL' }] }));
    expect(f.acks).toContain(id); const saved = new GatewayInbox(f.state).list()[0];
    expect(saved.input).toMatchObject({ platform: 'slack', accountId: f.instance.accountId, actor: { id: 'UALICE', label: 'Alice', kind: 'user' }, text: '', media: [{ fileId: 'FFILE', name: 'plan.pdf', size: 123 }] });
    expect(saved.status).toBe('waiting-files'); expect(f.inbox.claimNext()).toBeNull();
    const disk = fs.readFileSync(f.state.inboxFile(), 'utf8'); expect(disk).not.toContain('PRIVATE_'); expect(disk).not.toContain('url_private');
    expect(f.calls.map((call) => call.method)).toEqual(['auth.test', 'bots.info', 'apps.connections.open', 'users.info', 'conversations.info']);
  });

  it('does not acknowledge until asynchronous sender checks and the durable commit finish', async () => {
    const f = await fixture(); await f.chat.initialize(); let release: (() => void) | undefined;
    f.gate(() => new Promise<void>((resolve) => { release = resolve; })); const id = f.send(message());
    await expect.poll(() => Boolean(release)).toBe(true); expect(f.acks).toEqual([]); expect(f.inbox.list()).toEqual([]);
    release!(); await expect.poll(() => f.acks.includes(id)).toBe(true); expect(f.inbox.list()).toHaveLength(1);
  });

  it('preserves socket arrival order while an earlier identity lookup is slow', async () => {
    const f = await fixture(); await f.chat.initialize(); let release: (() => void) | undefined;
    f.gate(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = f.send(message()); await expect.poll(() => Boolean(release)).toBe(true);
    const second = f.send(message('1700000000.000002')); const third = f.send(message('1700000000.000003'));
    f.gate(); release!(); await expect.poll(() => f.acks.includes(third)).toBe(true);
    expect(f.acks).toEqual([first, second, third]); expect(f.inbox.list().map((event) => event.input.sourceMessageId)).toEqual(['1700000000.000001', '1700000000.000002', '1700000000.000003']);
  });

  it('bounds its unacknowledged queue and does not accept queued input after cancellation', async () => {
    const f = await fixture(); await f.chat.initialize(); let release: (() => void) | undefined;
    f.gate(() => new Promise<void>((resolve) => { release = resolve; }));
    f.send(message()); await expect.poll(() => Boolean(release)).toBe(true);
    let overflow = '';
    for (let index = 2; index <= 33; index++) overflow = f.send(message(`1700000000.${String(index).padStart(6, '0')}`));
    await expect.poll(() => f.activity.includes(false)).toBe(true); expect(f.acks).not.toContain(overflow);
    expect(f.calls.filter((call) => call.method === 'users.info')).toHaveLength(1);
    f.abort.abort(); release!(); await f.adapter.disconnect(); expect(f.acks).toEqual([]); expect(f.inbox.list()).toEqual([]);
  });

  it('leaves a failed commit unacknowledged, then deduplicates a redelivery with another event ID', async () => {
    const f = await fixture(); await f.chat.initialize(); fs.writeFileSync(f.state.inboxFile(), '{broken');
    const failed = f.send(message()); await expect.poll(() => f.activity.includes(false)).toBe(true); expect(f.acks).not.toContain(failed);
    fs.unlinkSync(f.state.inboxFile()); await f.delivered(message()); await f.delivered(message());
    expect(f.inbox.list()).toHaveLength(1); const event = f.inbox.claimNext()!;
    expect(await gatewayConversation(event, f.abort.signal)).toMatchObject({ kind: 'brain', conversationId: event.bindingId });
  });

  it.each([{ authTeam: 'TOTHER' }, { authEnterprise: true }, { authError: true }])('does not open a socket with an unverified workspace installation: %j', async (options) => {
    const f = await fixture(options); await expect(f.chat.initialize()).rejects.toThrow();
    expect(f.calls.some((call) => call.method === 'apps.connections.open')).toBe(false); expect(f.inbox.list()).toEqual([]);
  });

  it('denies other workspaces/apps, external envelopes, missing senders and bot echoes before identity lookups', async () => {
    const f = await fixture(); await f.chat.initialize();
    for (const changes of [{ team_id: 'TOTHER' }, { api_app_id: 'AOTHER' }, { is_ext_shared_channel: true }, { is_enterprise_install: true }, { context_team_id: 'TOTHER' }]) await f.delivered(message(), changes);
    for (const changes of [{ user: 'UBOT' }, { bot_id: 'BOTHER' }, { bot_profile: { user_id: 'UALICE' } }, { subtype: 'bot_message' }, { subtype: 'channel_join' }, { team: 'TOTHER' }, { user_team: 'TOTHER' }]) await f.delivered(message('1700000000.000001', changes));
    expect(f.calls.some((call) => call.method === 'users.info')).toBe(false); expect(f.inbox.list()).toEqual([]);
  });

  it.each([{ team_id: 'TOTHER' }, { is_bot: true }, { is_app_user: true }, { deleted: true }, { is_stranger: true }, { id: 'UOTHER' }])('refuses an unverified local actor: %j', async (changes) => {
    const f = await fixture(); await f.chat.initialize(); f.user(changes); await f.delivered(message());
    expect(f.inbox.list()).toEqual([]); expect(f.calls.some((call) => call.method === 'conversations.info')).toBe(false);
  });

  it.each([{ is_ext_shared: true }, { is_org_shared: true }, { is_pending_ext_shared: true }, { is_mpim: true }, { is_archived: true }, { user: 'UOTHER' }, { id: 'DOTHER' }, { is_im: false }])('refuses an unsafe or mismatched conversation: %j', async (changes) => {
    const f = await fixture(); await f.chat.initialize(); f.channel(changes); await f.delivered(message()); expect(f.inbox.list()).toEqual([]);
  });

  it('allows an empty optional user list, enforces a populated list and rejects disabled DM scope', async () => {
    const f = await fixture({ users: ['UBOB'], directMessages: false }); await f.chat.initialize();
    await f.delivered(message()); expect(f.calls.some((call) => call.method === 'users.info')).toBe(false);
    saveGatewayInstance({ ...f.config, scope: { ...f.config.scope, directMessages: true } }, f.instance.id);
    await f.delivered(message()); expect(f.inbox.list()).toEqual([]);
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'slack', allowedUserIds: [] }, scope: { ...f.config.scope, directMessages: true } }, f.instance.id);
    await f.delivered(message()); expect(f.inbox.list()).toHaveLength(1);
  });

  it('requires a mention to bind each configured channel thread, then accepts its replies only', async () => {
    const f = await fixture(); await f.chat.initialize();
    const shared = { channel: 'CLOCAL', channel_type: 'channel' };
    await f.delivered(message('1700000000.000001', { ...shared, text: 'No mention' })); expect(f.inbox.list()).toHaveLength(0);
    await f.delivered(message('1700000000.000001', { ...shared, type: 'app_mention', text: '<@UBOT> Help' }));
    await f.delivered(message('1700000000.000002', { ...shared, thread_ts: '1700000000.000001', text: 'Here is more' }));
    await f.delivered(message('1700000000.000003', { ...shared, text: 'Unbound new topic' }));
    await f.delivered(message('1700000000.000004', { channel: 'COTHER', channel_type: 'channel', text: '<@UBOT> Help' }));
    expect(f.inbox.list()).toHaveLength(2); expect(new Set(f.inbox.list().map((event) => event.bindingId)).size).toBe(1);
    expect(f.inbox.list()[0].input.threadId).toBe('1700000000.000001');
  });

  it('does not widen an exact thread scope to the whole channel', async () => {
    const f = await fixture({ scope: ['CLOCAL/1700000000.000001'] }); await f.chat.initialize();
    await f.delivered(message('1700000000.000001', { channel: 'CLOCAL', channel_type: 'channel', text: '<@UBOT> Help' }));
    await f.delivered(message('1700000000.000002', { channel: 'CLOCAL', channel_type: 'channel', text: '<@UBOT> Other root' }));
    expect(f.inbox.list()).toHaveLength(1);
  });

  it('holds genuine edits using the original source and thread instead of starting a second assignment', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message());
    const original = f.inbox.list()[0]; await f.delivered({ type: 'message', subtype: 'message_changed', hidden: true, channel: 'DALICE', channel_type: 'im', message: { type: 'message', user: 'UALICE', ts: original.input.sourceMessageId, text: 'Changed request' } });
    expect(f.inbox.list().map((event) => event.status)).toEqual(['needs-review', 'needs-review']);
    expect(f.inbox.list()[1].input.sourceMessageId).toBe(original.input.sourceMessageId); expect(f.inbox.claimNext()).toBeNull();
  });

  it('ignores a link-preview update when the saved text and files have not changed', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message());
    await f.delivered({ type: 'message', subtype: 'message_changed', hidden: true, channel: 'DALICE', channel_type: 'im', message: { type: 'message', user: 'UALICE', ts: '1700000000.000001', text: 'Hello', attachments: [{ text: 'Fetched link preview' }] } });
    expect(f.inbox.list()).toHaveLength(1); expect(f.inbox.list()[0].status).toBe('queued');
  });

  it('keeps a DM root edit in its original conversation if Slack later adds a thread timestamp', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message());
    await f.delivered({ type: 'message', subtype: 'message_changed', channel: 'DALICE', message: { type: 'message', user: 'UALICE', ts: '1700000000.000001', thread_ts: '1700000000.000001', text: 'Edited root' } });
    const events = f.inbox.list(); expect(events).toHaveLength(2); expect(events[1].bindingId).toBe(events[0].bindingId);
    expect(events[0].status).toBe('needs-review'); expect(events[1].input.threadId).toBe('');
  });

  it('holds an edited channel reply using its saved thread when the edit omits thread_ts', async () => {
    const f = await fixture({ scope: ['CLOCAL/1700000000.000001'] }); await f.chat.initialize();
    await f.delivered(message('1700000000.000001', { channel: 'CLOCAL', channel_type: 'channel', text: '<@UBOT> Help' }));
    await f.delivered(message('1700000000.000002', { channel: 'CLOCAL', channel_type: 'channel', thread_ts: '1700000000.000001', text: 'Before edit' }));
    await f.delivered({ type: 'message', subtype: 'message_changed', channel: 'CLOCAL', message: { type: 'message', user: 'UALICE', ts: '1700000000.000002', text: 'After edit' } });
    const events = f.inbox.list(); expect(events).toHaveLength(3); expect(events[2].bindingId).toBe(events[1].bindingId);
    expect(events[1].status).toBe('needs-review'); expect(events[2].input.threadId).toBe('1700000000.000001');
  });

  it('leaves malformed message identities and missing actors unacknowledged without making API calls', async () => {
    const f = await fixture(); await f.chat.initialize(); const missing = f.send(message('1700000000.000001', { user: null }));
    await expect.poll(() => f.activity.includes(false)).toBe(true); expect(f.acks).not.toContain(missing);
    expect(f.inbox.list()).toEqual([]); expect(f.calls).toHaveLength(3);
  });

  it('rechecks current policy and routing after a delayed identity lookup', async () => {
    const f = await fixture(); await f.chat.initialize(); let release: (() => void) | undefined;
    f.gate(() => new Promise<void>((resolve) => { release = resolve; })); const id = f.send(message()); await expect.poll(() => Boolean(release)).toBe(true);
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'slack', allowedUserIds: ['UBOB'] } }, f.instance.id);
    release!(); await expect.poll(() => f.acks.includes(id)).toBe(true); expect(f.inbox.list()).toHaveLength(0);
    f.gate(); saveGatewayInstance(f.config, f.instance.id); await f.delivered(message()); const saved = f.inbox.list()[0];
    const agent = newAgent({ name: 'New Slack destination' }); saveGatewayInstance({ ...f.config, target: { kind: 'agent', id: agent.id } }, f.instance.id);
    expect(f.inbox.claimNext()).toBeNull(); expect(f.inbox.list()[0].status).toBe('needs-review'); expect(saved.route.target.kind).toBe('brain');
  });

  it('does not acknowledge API failures or publish their raw details', async () => {
    const f = await fixture(); await f.chat.initialize(); f.error('ratelimited'); const id = f.send(message());
    await expect.poll(() => f.activity.includes(false)).toBe(true); expect(f.acks).not.toContain(id); expect(f.inbox.list()).toEqual([]);
    f.error(); await f.delivered(message()); expect(JSON.stringify(f.inbox.list())).not.toContain('PRIVATE_');
  });

  it('acknowledges unsupported controls without invoking actions or receiving a message', async () => {
    const f = await fixture(); await f.chat.initialize(); for (const type of ['interactive', 'slash_commands']) await f.delivered(message(), {}, type);
    expect(f.inbox.list()).toEqual([]); expect(f.calls).toHaveLength(3);
  });

  it('stops admission and acknowledgement if disconnected during an identity lookup', async () => {
    const f = await fixture(); await f.chat.initialize(); let release: (() => void) | undefined;
    f.gate(() => new Promise<void>((resolve) => { release = resolve; })); const id = f.send(message()); await expect.poll(() => Boolean(release)).toBe(true);
    const stop = f.adapter.disconnect(); release!(); await stop;
    expect(f.acks).not.toContain(id); expect(f.inbox.list()).toEqual([]);
  });

  it('rechecks optional sender and scope rules for queued normalized input', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message()); const event = f.inbox.list()[0];
    expect(gatewayInputAllowed(f.instance, event.input)).toBe(true);
    expect(gatewayInputAllowed({ ...f.instance, senderPolicy: { platform: 'slack', allowedUserIds: ['UBOB'] } }, event.input)).toBe(false);
    expect(gatewayInputAllowed(f.instance, { ...event.input, actor: { ...event.input.actor, kind: 'bot' } })).toBe(false);
    expect(gatewayInputAllowed(f.instance, { ...event.input, sourceMessageId: '1700000000.1' })).toBe(false);
  });
});
