import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { Chat } from 'chat';
import type { Logger } from 'chat';
import { afterEach, describe, expect, it } from 'vitest';
import { DiscordIntakeAdapter } from '../../server/gateways/discord.ts';
import { GatewayInbox, gatewayInputAllowed } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { getGatewayInstance, saveGatewayInstance, saveGatewayCredentials } from '../../server/gateways/instances.ts';
import { gatewayConfig } from './gateway-fixtures.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { newAgent } from '../../server/library.ts';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { GatewayWorker, discordTransport } from '../../server/gateways/worker.ts';
import { gatewayPlatformAvailable } from '../../shared/gateways.ts';
import { GatewayFileProcessor } from '../../server/gateways/files.ts';
import { GatewayReplies } from '../../server/gateways/replies.ts';
import { selectGatewayDocuments } from '../../server/gateways/outgoing.ts';
import { ensureBrain } from '../../server/projects.ts';
import type { GatewayInboxJournal } from '../../shared/types.ts';

const GUILD = '100000000000000001'; const CHANNEL = '200000000000000001'; const THREAD = '300000000000000001';
const ALICE = '400000000000000001'; const BOB = '400000000000000002'; const DM = '500000000000000001';
const FIRST = '600000000000000001'; const SECOND = '600000000000000002'; const THIRD = '600000000000000003';
const permissionBits = (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 38n);
const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
let account = 900000000000000000n;
function message(id = FIRST, changes: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, channel_id: DM, author: { id: ALICE, username: 'Untrusted label' }, type: 0, content: 'Hello', attachments: [], mentions: [], ...changes };
}
async function fixture(options: { users?: string[]; directMessages?: boolean; wrongBot?: boolean; appFlags?: number; appBot?: string; omitAppBot?: boolean } = {}) {
  const config = { ...gatewayConfig(String(account++)), platform: 'discord', senderPolicy: { platform: 'discord', allowedUserIds: options.users ?? [] },
    scope: { directMessages: options.directMessages ?? true, conversationIds: [CHANNEL], guildIds: [GUILD] } };
  const instance = saveGatewayInstance(config); const state = new GatewayStateAdapter(instance.id); await state.connect(); const inbox = new GatewayInbox(state);
  const calls: { path: string; method: string; token: string; form?: FormData; payload?: Record<string, unknown> }[] = [];
  const channels: Record<string, Record<string, unknown>> = {
    [DM]: { id: DM, type: 1, recipients: [{ id: ALICE, bot: false }] },
    [CHANNEL]: { id: CHANNEL, guild_id: GUILD, type: 0, permission_overwrites: [] },
    [THREAD]: { id: THREAD, guild_id: GUILD, type: 11, parent_id: CHANNEL, thread_metadata: { archived: false, locked: false } },
  };
  let permissions = permissionBits; let roleIds: string[] = []; let additionalRoles: { id: string; permissions: string }[] = [];
  let actor: Record<string, unknown> = {}; let current = message(FIRST, { content: 'Edited text' });
  let replyChanges: Record<string, unknown> = {}; let posted = 700000000000000000n;
  let cdn: { body: string; length: number | null; redirect?: string } = { body: 'hello', length: 5 };
  let failure: { path: string; status: number } | undefined; let gate: { path: string; wait: () => Promise<void> } | undefined;
  const server = http.createServer(async (request, response) => {
    const path = request.url ?? ''; const call: typeof calls[number] = { path, method: request.method ?? '', token: request.headers.authorization ?? '' }; calls.push(call);
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.method === 'POST') {
      const bytes = new Uint8Array(Buffer.concat(chunks));
      if (request.headers['content-type']?.startsWith('multipart/form-data')) {
        call.form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type'] } }).formData();
        call.payload = JSON.parse(String(call.form.get('payload_json'))) as Record<string, unknown>;
      } else call.payload = JSON.parse(Buffer.from(bytes).toString()) as Record<string, unknown>;
    }
    if (path.startsWith('/attachments/')) {
      if (cdn.redirect) response.writeHead(302, { location: cdn.redirect });
      else if (cdn.length !== null) response.setHeader('content-length', cdn.length);
      else response.setHeader('transfer-encoding', 'chunked');
      response.end(cdn.body); return;
    }
    if (gate?.path === path) await gate.wait();
    if (failure?.path === path) { response.writeHead(failure.status, { 'content-type': 'application/json', 'retry-after': '7' }); response.end(JSON.stringify({ error: 'PRIVATE_PROVIDER_DETAIL' })); return; }
    let result: unknown;
    if (request.method === 'POST' && /^\/channels\/\d+\/messages$/.test(path)) {
      const file = call.form?.get('files[0]');
      result = { id: String(posted++), channel_id: path.split('/')[2], author: { id: instance.accountId, bot: true }, type: 19,
        ...call.payload, attachments: file instanceof Blob ? [{ id: '600000000000000009', filename: 'name' in file ? file.name : 'file.bin', size: file.size }] : [], ...replyChanges };
    }
    else if (path === '/users/@me') result = { id: options.wrongBot ? '999' : instance.accountId, bot: true, username: 'Athena' };
    else if (path === '/gateway/bot') result = { url: origin.replace('http:', 'ws:'), shards: 1, session_start_limit: { total: 1000, remaining: 999, reset_after: 10000, max_concurrency: 1 } };
    else if (path === '/oauth2/applications/@me') result = { id: instance.accountId, ...(options.omitAppBot ? {} : { bot: { id: options.appBot ?? instance.accountId, bot: true } }), flags: options.appFlags ?? (1 << 19) };
    else if (path === `/guilds/${GUILD}/roles`) result = [{ id: GUILD, permissions: String(permissions) }, ...additionalRoles];
    else if (path === `/guilds/${GUILD}/members/${instance.accountId}`) result = { user: { id: instance.accountId, bot: true }, roles: roleIds };
    else if (path.startsWith('/users/')) result = { id: path.split('/').at(-1), username: 'Verified Alice', bot: false, ...actor };
    else if (path.startsWith(`/guilds/${GUILD}/members/`)) result = { user: { id: path.split('/').at(-1), username: 'Verified Alice', bot: false, ...actor } };
    else if (/^\/channels\/\d+\/messages\/\d+$/.test(path)) result = current;
    else if (path.startsWith('/channels/')) result = channels[path.split('/').at(-1) ?? ''] ?? { id: '999', type: 3 };
    else { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  });
  const sockets = new WebSocketServer({ server }); const peers: WebSocket[] = []; const wire: { op: number; d: Record<string, unknown> }[] = [];
  sockets.on('connection', (peer) => {
    peers.push(peer); peer.on('message', (data) => {
      const value = JSON.parse(data.toString()) as typeof wire[number]; wire.push(value);
      if (value.op === 1) peer.send(JSON.stringify({ op: 11, d: null }));
      else if (value.op === 2) peer.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { v: 10, user: { id: instance.accountId, bot: true }, session_id: 'PRIVATE_SESSION_ID', resume_gateway_url: origin.replace('http:', 'ws:') } }));
      else if (value.op === 6) peer.send(JSON.stringify({ op: 0, s: Number(value.d.seq) + 1, t: 'RESUMED', d: {} }));
    }); peer.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const abort = new AbortController(); const origin = `http://127.0.0.1:${address.port}`;
  const adapter = new DiscordIntakeAdapter(instance.id, inbox, 'PRIVATE_BOT_TOKEN', { apiUrl: origin, fileOrigin: origin, signal: abort.signal });
  const chat = new Chat({ userName: 'Athena', adapters: { discord: adapter }, state, logger: quiet });
  closes.push(async () => { for (const peer of peers) peer.terminate(); await new Promise<void>((resolve) => sockets.close(() => resolve())); await adapter.disconnect(); await chat.shutdown(); await state.disconnect(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  let event = 0;
  return { config, instance, state, inbox, adapter, chat, abort, origin, calls, channels, peers, wire,
    sendGateway: (sequence: number, payload: unknown, type = 'MESSAGE_CREATE') => peers.at(-1)!.send(JSON.stringify({ op: 0, s: sequence, t: type, d: payload })),
    receive: (payload: unknown, type = 'MESSAGE_CREATE') => adapter.receiveDispatch(type, `dispatch-${++event}`, payload),
    reply: (value: Record<string, unknown>) => { replyChanges = value; }, cdn: (value: typeof cdn) => { cdn = value; },
    actor: (value: Record<string, unknown>) => { actor = value; }, update: (value: Record<string, unknown>) => { current = value; },
    permissions: (value: bigint) => { permissions = value; }, roles: (ids: string[], values: typeof additionalRoles) => { roleIds = ids; additionalRoles = values; },
    fail: (path: string, status: number) => { failure = { path, status }; }, gate: (path: string, wait: () => Promise<void>) => { gate = { path, wait }; }, clearGate: () => { gate = undefined; },
  };
}

describe('verified Discord event intake proof', () => {
  it('cancels one disconnected Gateway dispatch without closing later verified intake', async () => {
    const f = await fixture(); await f.chat.initialize();
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); f.gate(`/users/${ALICE}`, () => gate);
    const abort = new AbortController(); const task = f.adapter.receiveDispatch('MESSAGE_CREATE', 'canceled-dispatch', message(), abort.signal);
    try {
      await expect.poll(() => f.calls.some((call) => call.path === `/users/${ALICE}`)).toBe(true);
      abort.abort(); await expect(task).rejects.toThrow('Retry it before advancing recovery'); expect(f.inbox.list()).toHaveLength(0);
    } finally { release(); f.clearGate(); }
    expect((await f.receive(message()))?.input.sourceMessageId).toBe(FIRST);
  });

  it('verifies bot/application identity and the Message content capability before accepting input', async () => {
    const f = await fixture(); await expect(f.receive(message())).rejects.toThrow('Verify the Discord bot'); await f.chat.initialize();
    expect(f.adapter.botUserId).toBe(f.instance.accountId); const saved = await f.receive(message());
    expect(saved?.input).toMatchObject({ platform: 'discord', accountId: f.instance.accountId, actor: { id: ALICE, label: 'Verified Alice', kind: 'user' }, sourceMessageId: FIRST, threadId: '' });
    expect(f.calls.every((call) => call.method === 'GET' && call.token === 'Bot PRIVATE_BOT_TOKEN')).toBe(true);
    expect(gatewayPlatformAvailable('discord')).toBe(true);
    expect(f.calls.some((call) => call.path.includes('gateway'))).toBe(false);
    expect((await f.adapter.handleWebhook(new Request('http://localhost/unused'))).status).toBe(404);
    await expect(f.adapter.startGatewayListener({})).rejects.toThrow('durable Discord Gateway');
  });

  it.each([{ wrongBot: true }, { appFlags: 0 }, { appBot: ALICE }])('fails setup for an unverified identity or missing intent: %j', async (options) => {
    const f = await fixture(options); await expect(f.chat.initialize()).rejects.toThrow(); expect(f.inbox.list()).toEqual([]);
  });

  it('accepts omitted optional app bot metadata only with the authenticated bot/application ID', async () => {
    const f = await fixture({ omitAppBot: true }); await f.chat.initialize(); expect(await f.receive(message())).not.toBeNull();
  });

  it('stores only attachment IDs and bounded metadata, keeping file-only input out of model admission', async () => {
    const f = await fixture(); await f.chat.initialize(); const saved = await f.receive(message(FIRST, { content: '', attachments: [{ id: '700000000000000001', filename: 'photo.png', size: 12, content_type: 'image/png', url: 'https://cdn.discordapp.com/PRIVATE_URL', proxy_url: 'https://media.discordapp.net/PRIVATE_PROXY' }] }));
    expect(saved?.status).toBe('waiting-files'); expect(saved?.input.media[0]).toEqual({ kind: 'image', fileId: '700000000000000001', name: 'photo.png', mimeType: 'image/png', size: 12 });
    expect(f.inbox.claimNext()).toBeNull(); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).not.toContain('PRIVATE_');
  });

  it('deduplicates source IDs above the safe integer range, including replay after restart and retargeting', async () => {
    const f = await fixture(); await f.chat.initialize(); const original = await f.receive(message()); expect(original?.input.sourceMessageId).toBe(FIRST);
    expect((await f.receive(message()))?.id).toBe(original?.id);
    await f.state.disconnect(); await f.state.connect(); const agent = newAgent({ name: 'New Discord target' });
    saveGatewayInstance({ ...f.config, target: { kind: 'agent', id: agent.id } }, f.instance.id);
    expect((await f.receive(message()))?.id).toBe(original?.id); expect(f.inbox.list()).toHaveLength(1); expect(f.inbox.claimNext()).toBeNull();
  });

  it('supports an empty optional sender guard and rejects a nonmatching exact ID before channel lookups', async () => {
    const f = await fixture({ users: [BOB] }); await f.chat.initialize(); expect(await f.receive(message())).toBeNull(); expect(f.calls).toHaveLength(2);
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'discord', allowedUserIds: [] } }, f.instance.id);
    expect(await f.receive(message())).not.toBeNull();
  });

  it.each([{ author: { id: ALICE, bot: true } }, { author: { id: ALICE, system: true } }, { webhook_id: '123' }, { application_id: '123' }, { type: 7 }, { flags: 2 }, { flags: 16384 }, { message_snapshots: [{}] }])('refuses nonhuman, webhook or forwarded input: %j', async (changes) => {
    const f = await fixture(); await f.chat.initialize(); expect(await f.receive(message(FIRST, changes))).toBeNull(); expect(f.calls).toHaveLength(2); expect(f.inbox.list()).toEqual([]);
  });

  it('does not trust a human-looking raw actor when REST identifies a bot or another user', async () => {
    const f = await fixture(); await f.chat.initialize(); f.actor({ bot: true }); expect(await f.receive(message())).toBeNull();
    f.actor({ id: BOB }); expect(await f.receive(message())).toBeNull(); expect(f.inbox.list()).toEqual([]);
  });

  it('refuses malformed and missing actors, IDs or content instead of creating a receipt', async () => {
    const f = await fixture(); await f.chat.initialize();
    for (const changes of [{ author: null }, { id: Number(FIRST) }, { id: '18446744073709551616' }, { content: null }]) await expect(f.receive(message(FIRST, changes))).rejects.toThrow('verify or save');
    expect(f.inbox.list()).toEqual([]);
  });

  it('requires verified one-to-one DM recipients and respects the separate DM switch', async () => {
    const f = await fixture(); await f.chat.initialize(); f.channels[DM].recipients = [{ id: BOB }]; expect(await f.receive(message())).toBeNull();
    f.channels[DM].recipients = [{ id: ALICE }, { id: BOB }]; f.channels[DM].type = 3; expect(await f.receive(message())).toBeNull();
    saveGatewayInstance({ ...f.config, scope: { ...f.config.scope, directMessages: false } }, f.instance.id); expect(await f.receive(message())).toBeNull(); expect(f.inbox.list()).toEqual([]);
  });

  it('checks both guild and channel scope and requires an explicit mention for each new channel topic', async () => {
    const f = await fixture(); await f.chat.initialize(); const shared = { channel_id: CHANNEL, guild_id: GUILD };
    expect(await f.receive(message(FIRST, { ...shared, guild_id: '999' }))).toBeNull(); expect(f.calls).toHaveLength(2);
    expect(await f.receive(message(FIRST, shared))).toBeNull();
    const original = await f.receive(message(FIRST, { ...shared, mentions: [{ id: f.instance.accountId }], content: 'Help' })); expect(original).not.toBeNull();
    expect(await f.receive(message(SECOND, shared))).toBeNull();
    const follow = await f.receive(message(THIRD, { ...shared, type: 19, message_reference: { channel_id: CHANNEL, guild_id: GUILD, message_id: FIRST } }));
    expect(follow?.bindingId).toBe(original?.bindingId); expect(follow?.input.threadId).toBe(FIRST); expect(f.inbox.list()).toHaveLength(2);
  });

  it('maps confirmed bot replies to their exact saved topic without trusting other bot messages', async () => {
    const f = await fixture(); await f.chat.initialize(); const shared = { channel_id: CHANNEL, guild_id: GUILD };
    const original = await f.receive(message(FIRST, { ...shared, mentions: [{ id: f.instance.accountId }] })); const claimed = f.inbox.claimNext()!;
    f.inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, f.abort.signal)); f.inbox.finishDispatch(claimed.id, claimed.operationId!, 'Answer'); f.inbox.claimReply();
    f.inbox.settleReply(claimed.id, 0, { remoteId: `${f.adapter.encodeThreadId({ guildId: GUILD, channelId: CHANNEL })}/${SECOND}` });
    const follow = await f.receive(message(THIRD, { ...shared, type: 19, message_reference: { message_id: SECOND } })); expect(follow?.bindingId).toBe(original?.bindingId);
  });

  it('verifies native thread parents and keeps different thread histories apart', async () => {
    const f = await fixture(); await f.chat.initialize(); const thread = { channel_id: THREAD, guild_id: GUILD, mentions: [{ id: f.instance.accountId }] };
    const original = await f.receive(message(FIRST, thread)); expect(original?.input).toMatchObject({ conversationId: THREAD, parentConversationId: CHANNEL, guildId: GUILD, threadId: THREAD });
    const follow = await f.receive(message(SECOND, { ...thread, mentions: [] })); expect(follow?.bindingId).toBe(original?.bindingId);
    const other = '300000000000000002'; f.channels[other] = { ...f.channels[THREAD], id: other };
    const separate = await f.receive(message(THIRD, { ...thread, channel_id: other })); expect(separate?.bindingId).not.toBe(original?.bindingId);
    f.channels[CHANNEL].guild_id = '999'; expect(await f.receive(message('600000000000000004', thread))).toBeNull();
  });

  it('does not let a configured thread authorize its parent or sibling channels', async () => {
    const f = await fixture(); await f.chat.initialize(); saveGatewayInstance({ ...f.config, scope: { ...f.config.scope, conversationIds: [THREAD] } }, f.instance.id);
    expect(await f.receive(message(FIRST, { channel_id: CHANNEL, guild_id: GUILD, mentions: [{ id: f.instance.accountId }] }))).toBeNull();
    expect(await f.receive(message(FIRST, { channel_id: THREAD, guild_id: GUILD, mentions: [{ id: f.instance.accountId }] }))).not.toBeNull();
  });

  it.each([{ thread_metadata: { archived: true, locked: false } }, { thread_metadata: { archived: false, locked: true } }, { type: 12 }, { parent_id: '999' }])('refuses unavailable or unjoined private threads: %j', async (changes) => {
    const f = await fixture(); await f.chat.initialize(); Object.assign(f.channels[THREAD], changes);
    expect(await f.receive(message(FIRST, { channel_id: THREAD, guild_id: GUILD, mentions: [{ id: f.instance.accountId }] }))).toBeNull();
  });

  it('applies everyone, role and member permission overwrites in order', async () => {
    const f = await fixture(); await f.chat.initialize(); const raw = message(FIRST, { channel_id: CHANNEL, guild_id: GUILD, mentions: [{ id: f.instance.accountId }] });
    f.permissions((1n << 10n) | (1n << 16n)); await expect(f.receive(raw)).rejects.toThrow('verify or save');
    const role = '800000000000000001'; f.roles([role], [{ id: role, permissions: String(1n << 11n) }]); expect(await f.receive(raw)).not.toBeNull();
    f.channels[CHANNEL].permission_overwrites = [{ id: GUILD, type: 0, allow: '0', deny: String(1n << 10n) }]; await expect(f.receive(message(SECOND, { ...raw, id: SECOND }))).rejects.toThrow();
    f.channels[CHANNEL].permission_overwrites = [{ id: GUILD, type: 0, allow: '0', deny: String(1n << 10n) }, { id: role, type: 0, allow: String(1n << 10n), deny: '0' }, { id: f.instance.accountId, type: 1, deny: String(1n << 11n), allow: '0' }];
    await expect(f.receive(raw)).rejects.toThrow();
    f.permissions(8n); expect(await f.receive(raw)).not.toBeNull();
  });

  it('fetches complete partial edits, holds only the original saved topic and ignores metadata-only updates', async () => {
    const f = await fixture(); await f.chat.initialize(); const original = await f.receive(message()); const partial = { id: FIRST, channel_id: DM };
    f.update(message()); expect(await f.receive(partial, 'MESSAGE_UPDATE')).toBeNull(); expect(f.inbox.list()).toHaveLength(1);
    f.update(message(FIRST, { content: 'Changed request' })); const edit = await f.receive(partial, 'MESSAGE_UPDATE');
    expect(edit?.bindingId).toBe(original?.bindingId); expect(edit?.input.kind).toBe('edit'); expect(f.inbox.list()[0].status).toBe('needs-review'); expect(f.inbox.claimNext()).toBeNull();
    expect(await f.receive({ id: SECOND, channel_id: DM }, 'MESSAGE_UPDATE')).toBeNull();
  });

  it('rejects mismatched REST edits and permissions failures without treating failed events as committed', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.receive(message());
    f.update(message(SECOND)); expect(await f.receive({ id: FIRST, channel_id: DM }, 'MESSAGE_UPDATE')).toBeNull(); expect(f.inbox.list()).toHaveLength(1);
    f.fail(`/channels/${DM}/messages/${FIRST}`, 429); await expect(f.receive({ id: FIRST, channel_id: DM }, 'MESSAGE_UPDATE')).rejects.toThrow('Retry it before advancing recovery');
    expect(f.calls.filter((call) => call.path === `/channels/${DM}/messages/${FIRST}`)).toHaveLength(2);
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).not.toContain('PRIVATE_');
  });

  it('serializes asynchronous checks, detaches caller objects and rechecks revoked access at commit time', async () => {
    const f = await fixture(); await f.chat.initialize(); let release: (() => void) | undefined;
    f.gate(`/channels/${DM}`, () => new Promise<void>((resolve) => { release = resolve; })); const payload = message(); const first = f.receive(payload); payload.content = 'Changed after enqueue';
    await expect.poll(() => Boolean(release)).toBe(true); expect(f.inbox.list()).toEqual([]); f.clearGate(); release!(); expect((await first)?.input.text).toBe('Hello');
    f.gate(`/channels/${DM}`, () => new Promise<void>((resolve) => { release = resolve; })); release = undefined; const second = f.receive(message(SECOND));
    await expect.poll(() => Boolean(release)).toBe(true); saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'discord', allowedUserIds: [BOB] } }, f.instance.id);
    f.clearGate(); release!(); expect(await second).toBeNull(); expect(f.inbox.list()).toHaveLength(1);
  });

  it('bounds queued input and drains safely when disconnected during a permission lookup', async () => {
    const f = await fixture(); await f.chat.initialize(); let release: (() => void) | undefined;
    f.gate(`/channels/${DM}`, () => new Promise<void>((resolve) => { release = resolve; })); const pending = f.receive(message()).catch(() => null);
    await expect.poll(() => Boolean(release)).toBe(true); const jobs = Array.from({ length: 31 }, () => f.receive(message()).catch(() => null));
    await expect(f.receive(message())).rejects.toThrow('queue is full'); const stop = f.adapter.disconnect(); f.clearGate(); release!(); await Promise.all([pending, ...jobs, stop]); expect(f.inbox.list()).toEqual([]);
  });

  it('fails a local journal write without losing the source identity for a caller-controlled retry', async () => {
    const f = await fixture(); await f.chat.initialize(); fs.writeFileSync(f.state.inboxFile(), '{broken'); await expect(f.receive(message())).rejects.toThrow('verify or save');
    fs.unlinkSync(f.state.inboxFile()); expect(await f.receive(message())).not.toBeNull(); expect(f.inbox.list()).toHaveLength(1);
  });

  it('pins guild and parent metadata in both authorization and persistent bindings', async () => {
    const f = await fixture(); await f.chat.initialize(); const saved = await f.receive(message(FIRST, { channel_id: THREAD, guild_id: GUILD, mentions: [{ id: f.instance.accountId }] }));
    expect(gatewayInputAllowed(f.instance, saved!.input)).toBe(true); expect(gatewayInputAllowed(f.instance, { ...saved!.input, guildId: '999' })).toBe(false);
    expect(gatewayInputAllowed(f.instance, { ...saved!.input, parentConversationId: '999' })).toBe(false);
    const journal = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal; journal.bindings[0].guildId = '999'; fs.writeFileSync(f.state.inboxFile(), JSON.stringify(journal));
    expect(() => f.inbox.list()).toThrow('inconsistent'); expect(getGatewayInstance(f.instance.id).enabled).toBe(true);
  });
});

async function completed(f: Awaited<ReturnType<typeof fixture>>, answer = 'Done'): Promise<string> {
  const claimed = f.inbox.claimNext()!;
  f.inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, f.abort.signal));
  f.inbox.finishDispatch(claimed.id, claimed.operationId!, answer); return claimed.id;
}
function files(f: Awaited<ReturnType<typeof fixture>>) {
  const processor = new GatewayFileProcessor(f.instance.id, f.inbox, (id, limit, signal, event) => f.adapter.downloadFileSource(id, limit, signal, event), f.abort.signal);
  closes.push(() => processor.stop()); return processor;
}
function replies(f: Awaited<ReturnType<typeof fixture>>) {
  const service = new GatewayReplies(f.inbox, (event, text, signal) => f.adapter.replyText(event, text, signal), f.abort.signal, () => true,
    (event, file, signal) => f.adapter.replyDocument(event, file, signal));
  closes.push(() => service.stop()); return service;
}
const attachmentId = '600000000000000005';
async function received(f: Awaited<ReturnType<typeof fixture>>, changes: Record<string, unknown> = {}) {
  await f.chat.initialize(); const input = message(FIRST, changes); f.update(input); return (await f.receive(input))!;
}
async function output(f: Awaited<ReturnType<typeof fixture>>, id: string): Promise<string> {
  const file = path.join(ensureBrain(), `discord-result-${f.instance.accountId}.txt`); fs.writeFileSync(file, 'result');
  await selectGatewayDocuments(f.inbox, id, { paths: [file] }, f.abort.signal); return file;
}

describe('Discord files and replies', () => {
  it('refreshes attachment URLs from the saved message and saves bounded bytes without leaking tokens to the CDN', async () => {
    const f = await fixture(); await received(f, { attachments: [{ id: attachmentId, filename: '../../plan.txt', size: 5, url: 'https://expired.invalid/PRIVATE_URL' }] });
    f.update(message(FIRST, { attachments: [{ id: attachmentId, filename: '../../plan.txt', size: 5, url: `${f.origin}/attachments/${DM}/${attachmentId}/plan.txt?ex=PRIVATE_SIGNATURE` }] }));
    await files(f).start(); const saved = f.inbox.list()[0]; expect(saved.status).toBe('queued');
    expect(fs.readFileSync(saved.files![0].file!.path, 'utf8')).toBe('hello'); expect(saved.files![0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.calls.find((call) => call.path.startsWith('/attachments/'))?.token).toBe('');
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).not.toContain('PRIVATE_');
  });

  it.each(['https://steal.invalid/attachments/1/2/file.txt', 'http://cdn.discordapp.com/attachments/1/2/file.txt', '/attachments/999/600000000000000005/file.txt', '/attachments/500000000000000001/999/file.txt', '/attachments/500000000000000001/600000000000000005/a%2fb'])('refuses an untrusted attachment location: %s', async (location) => {
    const f = await fixture(); const descriptor = { id: attachmentId, filename: 'plan.txt', size: 5 }; await received(f, { attachments: [descriptor] });
    f.update(message(FIRST, { attachments: [{ ...descriptor, url: location.startsWith('/') ? f.origin + location : location }] }));
    await files(f).start(); expect(f.inbox.list()[0].files![0].status).toBe('failed'); expect(f.inbox.claimNext()).toBeNull();
    expect(f.calls.some((call) => call.path.startsWith('/attachments/'))).toBe(false);
  });

  it.each(['redirect', 'wrong-length', 'oversize', 'short-body', 'changed-source'])('holds unsafe or incomplete attachment transfers and keeps their quota charge: %s', async (reason) => {
    const f = await fixture(); const descriptor = { id: attachmentId, filename: 'plan.txt', size: 5 }; await received(f, { attachments: [descriptor] });
    f.update(message(FIRST, { content: reason === 'changed-source' ? 'Changed' : 'Hello', attachments: [{ ...descriptor, url: `${f.origin}/attachments/${DM}/${attachmentId}/plan.txt` }] }));
    if (reason === 'redirect') f.cdn({ body: '', length: 0, redirect: '/forbidden-download' });
    if (reason === 'wrong-length') f.cdn({ body: 'hello!', length: 6 });
    if (reason === 'oversize') f.cdn({ body: 'x'.repeat(2048), length: null });
    if (reason === 'short-body') f.cdn({ body: 'hi', length: null });
    await files(f).start(); const saved = f.inbox.list()[0]; expect(saved.files![0].status).toBe('failed'); expect(saved.files![0].attempts[0].bytes).toBeGreaterThan(0);
    expect(f.inbox.claimNext()).toBeNull(); expect(f.calls.some((call) => call.path === '/forbidden-download')).toBe(false);
  });

  it('splits long answers without splitting emoji and sends exact parts as replies with no mentions or previews', async () => {
    const f = await fixture(); await received(f); const answer = 'a'.repeat(1999) + '😊 <@123> @everyone **answer** '.repeat(150);
    await completed(f, answer); await replies(f).wake(); const posts = f.calls.filter((call) => call.method === 'POST');
    expect(posts.length).toBeGreaterThan(1); expect(posts.map((call) => call.payload!.content).join('')).toBe(answer);
    for (const post of posts) {
      expect(String(post.payload!.content).length).toBeLessThanOrEqual(2000); expect(String(post.payload!.content)).not.toMatch(/[\ud800-\udbff]$/);
      expect(post.payload).toMatchObject({ allowed_mentions: { parse: [], replied_user: false }, flags: 4, enforce_nonce: true,
        message_reference: { message_id: FIRST, channel_id: DM, fail_if_not_exists: true } });
      expect(String(post.payload!.nonce)).toHaveLength(24); expect(post.token).toBe('Bot PRIVATE_BOT_TOKEN');
    }
    expect(new Set(posts.map((call) => call.payload!.nonce)).size).toBe(posts.length);
    expect(f.inbox.list()[0].reply?.parts.every((part) => part.status === 'sent')).toBe(true); await replies(f).wake(); expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(posts.length);
  });

  it.each([{ status: 429, outcome: 'pending' }, { status: 500, outcome: 'uncertain' }, { status: 408, outcome: 'uncertain' }, { status: 403, outcome: 'failed' }, { status: 404, outcome: 'failed' }])('records HTTP $status without automatic send retries', async ({ status, outcome }) => {
    const f = await fixture(); await received(f); await completed(f); f.fail(`/channels/${DM}/messages`, status); const service = replies(f);
    await service.wake(); await service.wake(); const part = f.inbox.list()[0].reply!.parts[0]; expect(part.status).toBe(outcome); expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    if (status === 429) expect(part.retryAt).toBeGreaterThan(Date.now() + 5000); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).not.toContain('PRIVATE_PROVIDER_DETAIL');
  });

  it.each([{ channel_id: '999' }, { content: 'truncated' }, { nonce: 'wrong' }, { author: { id: ALICE, bot: false } }, { message_reference: { message_id: SECOND } }])('holds an unconfirmed or altered response instead of claiming success: %j', async (changes) => {
    const f = await fixture(); await received(f); await completed(f); f.reply(changes); await replies(f).wake(); expect(f.inbox.list()[0].reply?.parts[0].status).toBe('uncertain');
  });

  it('rechecks sender rules and live DM recipients before posting', async () => {
    const f = await fixture(); await received(f); await completed(f); f.channels[DM] = { id: DM, type: 1, recipients: [{ id: BOB }] };
    await replies(f).wake(); expect(f.inbox.list()[0].reply?.parts[0].status).toBe('failed'); expect(f.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('detects source changes during preflight and permits delivery only after an explicit retry of the saved answer', async () => {
    const f = await fixture(); await received(f); const id = await completed(f); f.update(message(FIRST, { content: 'Changed request' })); const service = replies(f);
    await service.wake(); expect(f.inbox.list()[0].reply?.parts[0].status).toBe('failed'); expect(f.calls.some((call) => call.method === 'POST')).toBe(false);
    expect(f.inbox.list().filter((event) => event.input.kind === 'edit')).toHaveLength(1);
    f.inbox.retryReply(id); await service.wake(); expect(f.inbox.list()[0].reply?.parts[0].status).toBe('sent');
  });

  it('records repeated or empty text changes and still allows a reviewed retry', async () => {
    const f = await fixture(); await received(f); const id = await completed(f); const service = replies(f);
    for (const content of ['First change', 'Second change', 'First change', '']) {
      f.update(message(FIRST, { content })); await service.wake(); expect(f.inbox.list()[0].reply?.parts[0].status).toBe('failed'); f.inbox.retryReply(id);
    }
    expect(f.inbox.list().filter((event) => event.input.kind === 'edit')).toHaveLength(4);
    await service.wake(); expect(f.inbox.list()[0].reply?.parts[0].status).toBe('sent'); expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('blocks delivery while a partial update is being verified and holds work when that check fails', async () => {
    const f = await fixture(); await received(f); await completed(f);
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); f.gate(`/channels/${DM}/messages/${FIRST}`, () => gate);
    const pending = f.receive({ id: FIRST, channel_id: DM }, 'MESSAGE_UPDATE'); const rejected = expect(pending).rejects.toThrow('Retry it before advancing recovery');
    try {
      await replies(f).wake(); expect(f.calls.some((call) => call.method === 'POST')).toBe(false); f.fail(`/channels/${DM}/messages/${FIRST}`, 500);
    } finally { release(); f.clearGate(); }
    await rejected; expect(f.inbox.list()[0].reply?.parts[0].status).toBe('failed');
  });

  it('rechecks source versions after asynchronous checks and refuses a forged destination or unclaimed send', async () => {
    const f = await fixture(); const event = await received(f); await completed(f);
    await expect(f.adapter.replyText({ ...event, input: { ...event.input, conversationId: CHANNEL } }, 'Done', f.abort.signal)).rejects.toMatchObject({ outcome: 'failed' });
    await expect(f.adapter.replyText(event, 'Done', f.abort.signal)).rejects.toMatchObject({ outcome: 'failed' }); expect(f.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('honors a local hold that arrives while destination checks are running', async () => {
    const f = await fixture(); await received(f); const id = await completed(f); const claimed = f.inbox.claimReply()!;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); f.gate(`/users/${ALICE}`, () => gate);
    const task = f.adapter.replyText(claimed.event, 'Done', f.abort.signal); const failed = expect(task).rejects.toMatchObject({ outcome: 'failed' });
    try {
      await expect.poll(() => f.calls.filter((call) => call.path === `/users/${ALICE}`).length).toBe(2); f.inbox.review(id);
    } finally { release(); f.clearGate(); }
    await failed; expect(f.calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('releases a partial-update barrier when only unchanged metadata was received', async () => {
    const f = await fixture(); await received(f); await completed(f);
    expect(await f.receive({ id: FIRST, channel_id: DM }, 'MESSAGE_UPDATE')).toBeNull(); await replies(f).wake(); expect(f.inbox.list()[0].reply?.parts[0].status).toBe('sent');
  });

  it.each(['working', 'approval'] as const)('sends a claimed %s notice and maps a human reply back to its topic', async (kind) => {
    const f = await fixture(); const original = await received(f, { channel_id: CHANNEL, guild_id: GUILD, mentions: [{ id: f.instance.accountId }] });
    const claimed = f.inbox.claimNext()!; f.inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, f.abort.signal)); f.inbox.queueNotice(claimed.id, kind);
    await replies(f).wake(); const notice = f.inbox.list()[0].notices?.[kind]; expect(notice?.status).toBe('sent');
    const follow = await f.receive(message(SECOND, { channel_id: CHANNEL, guild_id: GUILD, type: 19, message_reference: { message_id: '700000000000000000' } }));
    expect(follow?.bindingId).toBe(original.bindingId); expect(f.calls.find((call) => call.method === 'POST')?.payload?.content).toBe(notice?.text);
  });

  it('delivers in the actual native thread and refuses a thread that was locked after intake', async () => {
    const f = await fixture(); await received(f, { channel_id: THREAD, guild_id: GUILD, mentions: [{ id: f.instance.accountId }] }); await completed(f, 'x'.repeat(2001));
    const first = f.inbox.claimReply()!; const remoteId = await f.adapter.replyText(first.event, first.event.reply!.parts[first.index].text, f.abort.signal); f.inbox.settleReply(first.event.id, first.index, { remoteId });
    expect(f.calls.find((call) => call.method === 'POST')?.path).toBe(`/channels/${THREAD}/messages`);
    f.channels[THREAD].thread_metadata = { archived: false, locked: true }; await replies(f).wake();
    expect(f.inbox.list()[0].reply?.parts[1].status).toBe('failed'); expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('uploads selected verified bytes once as a document after text and maps replies to that delivery', async () => {
    const f = await fixture(); const original = await received(f, { channel_id: CHANNEL, guild_id: GUILD, mentions: [{ id: f.instance.accountId }] });
    const id = await completed(f); await output(f, id); f.permissions(permissionBits | (1n << 15n)); await replies(f).wake();
    const posts = f.calls.filter((call) => call.method === 'POST'); expect(posts).toHaveLength(2);
    const file = posts[1].form?.get('files[0]'); expect(file).toBeInstanceOf(Blob); expect(await (file as Blob).text()).toBe('result');
    expect(posts[1].payload).toMatchObject({ attachments: [{ id: 0 }], message_reference: { message_id: FIRST, channel_id: CHANNEL } });
    const saved = f.inbox.list()[0]; expect(saved.outgoing?.[0]).toMatchObject({ status: 'sent', remoteId: expect.stringContaining('/700000000000000001') });
    const follow = await f.receive(message(SECOND, { channel_id: CHANNEL, guild_id: GUILD, type: 19, message_reference: { message_id: '700000000000000001' } })); expect(follow?.bindingId).toBe(original.bindingId);
  });

  it('requires Attach files permission even when ordinary text replies are allowed', async () => {
    const f = await fixture(); await received(f, { channel_id: CHANNEL, guild_id: GUILD, mentions: [{ id: f.instance.accountId }] }); const id = await completed(f); await output(f, id);
    await replies(f).wake(); expect(f.inbox.list()[0].reply?.parts[0].status).toBe('sent'); expect(f.inbox.list()[0].outgoing?.[0].status).toBe('failed'); expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('refuses changed output bytes before uploading', async () => {
    const f = await fixture(); await received(f); const id = await completed(f); const file = await output(f, id); fs.writeFileSync(file, 'changed'); const service = replies(f);
    await service.wake(); expect(f.inbox.list()[0].outgoing?.[0].status).toBe('failed'); expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('keeps an uncertain multipart send held for explicit retry', async () => {
    const f = await fixture(); await received(f); const id = await completed(f); await output(f, id);
    const service = replies(f); // Finish text before failing the following document post.
    const first = f.inbox.claimReply()!; f.inbox.settleReply(id, first.index, { remoteId: 'already-confirmed' }); f.fail(`/channels/${DM}/messages`, 500);
    await service.wake(); await service.wake(); expect(f.inbox.list()[0].outgoing?.[0].status).toBe('uncertain'); expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});

describe('supervised Discord connections', () => {
  async function supervised(f: Awaited<ReturnType<typeof fixture>>, answer = 'Worker answer') {
    await f.state.disconnect(); saveGatewayCredentials(f.instance.id, { botToken: 'PRIVATE_BOT_TOKEN' });
    let saved: GatewayInbox | undefined; let submissions = 0;
    const worker = new GatewayWorker(f.instance.id, { retryMs: 5, monitorMs: 10,
      execution: { async submit() { submissions++; return {}; }, poll() { return { state: 'completed', answer }; } },
      transport: (state, inbox, activity, signal) => { saved = inbox; return discordTransport(state, inbox, activity, signal, { apiUrl: f.origin, fileOrigin: f.origin, testOrigin: f.origin.replace('http:', 'ws:') }); },
    }); closes.push(() => worker.stop()); await worker.start();
    return { worker, inbox: () => saved!, submissions: () => submissions };
  }

  it('runs intake and replies through the shared worker, resumes without a duplicate run and releases ownership on pause', async () => {
    const f = await fixture(); f.update(message()); const run = await supervised(f);
    expect(run.worker.health().status).toBe('connected'); f.sendGateway(2, message());
    await expect.poll(() => run.inbox().list()[0]?.reply?.parts[0]?.status, { timeout: 5000 }).toBe('sent');
    expect(run.submissions()).toBe(1); f.peers[0].terminate(); await expect.poll(() => f.peers.length).toBe(2);
    await expect.poll(() => run.worker.health().status).toBe('connected'); f.sendGateway(4, message());
    await expect.poll(() => run.inbox().list().length).toBe(1); expect(run.submissions()).toBe(1);
    expect(f.wire.filter((value) => value.op === 2)).toHaveLength(1); expect(f.wire.find((value) => value.op === 6)?.d.seq).toBe(2);
    await run.worker.stop(); await f.state.connect(); expect(f.inbox.list()[0].reply?.parts[0].status).toBe('sent');
  });

  it.each([4007, 4014])('stops automatic reconnects on a lost session or fatal setup close %s', async (code) => {
    const f = await fixture(); const run = await supervised(f); f.peers[0].close(code, 'PRIVATE_ERROR');
    await expect.poll(() => run.worker.health().status).toBe('needs-setup');
    expect(run.worker.health().recoveryRequired).toBe(code === 4007 ? true : undefined);
    expect(JSON.stringify(run.worker.health())).not.toContain('PRIVATE_'); expect(f.peers).toHaveLength(1);
    if (code === 4007) { await run.worker.start(); expect(run.worker.health().recoveryRequired).toBe(true); expect(f.calls.filter((call) => call.path === '/users/@me')).toHaveLength(1); }
  });

  it('honors persisted Discord waits before auth checks even after a manual reconnect', async () => {
    const f = await fixture(); const run = await supervised(f); f.peers[0].send(JSON.stringify({ op: 9, d: true }));
    await expect.poll(() => run.worker.health().retryAt).toBeGreaterThan(Date.now() + 3000);
    await run.worker.start(); expect(f.calls.filter((call) => call.path === '/users/@me')).toHaveLength(1); expect(f.peers).toHaveLength(1);
  });

  it('keeps two bot instances, their private histories and reply destinations separate', async () => {
    const first = await fixture(); const second = await fixture(); first.update(message()); second.update(message());
    const a = await supervised(first, 'First answer'); const b = await supervised(second, 'Second answer');
    first.sendGateway(2, message()); second.sendGateway(2, message());
    await expect.poll(() => a.inbox().list()[0]?.reply?.parts[0].status, { timeout: 5000 }).toBe('sent');
    await expect.poll(() => b.inbox().list()[0]?.reply?.parts[0].status, { timeout: 5000 }).toBe('sent');
    expect(a.inbox().list()[0].bindingId).not.toBe(b.inbox().list()[0].bindingId);
    expect(first.calls.find((call) => call.method === 'POST')?.payload?.content).toBe('First answer'); expect(second.calls.find((call) => call.method === 'POST')?.payload?.content).toBe('Second answer');
    expect(a.submissions()).toBe(1); expect(b.submissions()).toBe(1);
  });
});
