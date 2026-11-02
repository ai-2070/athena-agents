import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { Chat } from 'chat';
import type { Logger } from 'chat';
import { afterEach, describe, expect, it } from 'vitest';
import { DiscordIntakeAdapter } from '../../server/gateways/discord.ts';
import { GatewayInbox, gatewayInputAllowed } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { getGatewayInstance, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { gatewayConfig } from './gateway-fixtures.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { newAgent } from '../../server/library.ts';
import { gatewayPlatformAvailable } from '../../shared/gateways.ts';
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
  const calls: { path: string; method: string; token: string }[] = [];
  const channels: Record<string, Record<string, unknown>> = {
    [DM]: { id: DM, type: 1, recipients: [{ id: ALICE, bot: false }] },
    [CHANNEL]: { id: CHANNEL, guild_id: GUILD, type: 0, permission_overwrites: [] },
    [THREAD]: { id: THREAD, guild_id: GUILD, type: 11, parent_id: CHANNEL, thread_metadata: { archived: false, locked: false } },
  };
  let permissions = permissionBits; let roleIds: string[] = []; let additionalRoles: { id: string; permissions: string }[] = [];
  let actor: Record<string, unknown> = {}; let current = message(FIRST, { content: 'Edited text' });
  let failure: { path: string; status: number } | undefined; let gate: { path: string; wait: () => Promise<void> } | undefined;
  const server = http.createServer(async (request, response) => {
    const path = request.url ?? ''; calls.push({ path, method: request.method ?? '', token: request.headers.authorization ?? '' });
    if (gate?.path === path) await gate.wait();
    if (failure?.path === path) { response.writeHead(failure.status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'PRIVATE_PROVIDER_DETAIL' })); return; }
    let result: unknown;
    if (path === '/users/@me') result = { id: options.wrongBot ? '999' : instance.accountId, bot: true, username: 'Athena' };
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
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const abort = new AbortController(); const origin = `http://127.0.0.1:${address.port}`;
  const adapter = new DiscordIntakeAdapter(instance.id, inbox, 'PRIVATE_BOT_TOKEN', { apiUrl: origin, signal: abort.signal });
  const chat = new Chat({ userName: 'Athena', adapters: { discord: adapter }, state, logger: quiet });
  closes.push(async () => { await adapter.disconnect(); await chat.shutdown(); await state.disconnect(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  let event = 0;
  return { config, instance, state, inbox, adapter, chat, abort, origin, calls, channels,
    receive: (payload: unknown, type = 'MESSAGE_CREATE') => adapter.receiveDispatch(type, `dispatch-${++event}`, payload),
    actor: (value: Record<string, unknown>) => { actor = value; }, update: (value: Record<string, unknown>) => { current = value; },
    permissions: (value: bigint) => { permissions = value; }, roles: (ids: string[], values: typeof additionalRoles) => { roleIds = ids; additionalRoles = values; },
    fail: (path: string, status: number) => { failure = { path, status }; }, gate: (path: string, wait: () => Promise<void>) => { gate = { path, wait }; }, clearGate: () => { gate = undefined; },
  };
}

describe('verified Discord event intake proof', () => {
  it('verifies bot/application identity and the Message content capability before accepting input', async () => {
    const f = await fixture(); await expect(f.receive(message())).rejects.toThrow('Verify the Discord bot'); await f.chat.initialize();
    expect(f.adapter.botUserId).toBe(f.instance.accountId); const saved = await f.receive(message());
    expect(saved?.input).toMatchObject({ platform: 'discord', accountId: f.instance.accountId, actor: { id: ALICE, label: 'Verified Alice', kind: 'user' }, sourceMessageId: FIRST, threadId: '' });
    expect(f.calls.every((call) => call.method === 'GET' && call.token === 'Bot PRIVATE_BOT_TOKEN')).toBe(true);
    expect(gatewayPlatformAvailable('discord')).toBe(false);
    expect(f.calls.some((call) => call.path.includes('gateway'))).toBe(false);
    expect((await f.adapter.handleWebhook(new Request('http://localhost/unused'))).status).toBe(404);
    await expect(f.adapter.startGatewayListener({})).rejects.toThrow('recovery is not available');
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
