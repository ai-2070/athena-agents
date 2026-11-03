import fs from 'node:fs';
import path from 'node:path';
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
import { GatewayFileProcessor } from '../../server/gateways/files.ts';
import { GatewayReplies } from '../../server/gateways/replies.ts';
import { selectGatewayDocuments } from '../../server/gateways/outgoing.ts';
import { ensureBrain } from '../../server/projects.ts';
import { GatewayWorker } from '../../server/gateways/worker.ts';

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
  const acks: string[] = []; const calls: { method: string; token: string; fields: URLSearchParams; bytes: string }[] = []; const activity: boolean[] = [];
  let peer: WebSocket | undefined; let gate: (() => Promise<void>) | undefined;
  let userChanges: Record<string, unknown> = {}; let channelChanges: Record<string, unknown> = {};
  let apiError: string | undefined;
  let fileChanges: Record<string, unknown> = {}; let replyChanges: Record<string, unknown> = {};
  let failure: { method: string; status: number; error?: string } | undefined;
  let redirect = false; let uploadUrl: string | undefined; let posts = 0;
  let uploadHook: (() => void) | undefined;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const method = request.url?.split('/').at(-1) ?? ''; const fields = new URLSearchParams(Buffer.concat(chunks).toString());
    calls.push({ method, token: request.headers.authorization ?? '', fields, bytes: Buffer.concat(chunks).toString() });
    if (failure?.method === method) { response.writeHead(failure.status, { 'content-type': 'application/json', 'retry-after': '7' }); response.end(JSON.stringify({ ok: false, error: failure.error ?? 'PRIVATE_ERROR' })); return; }
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
    const origin = `http://127.0.0.1:${address.port}`;
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
    } else if (method === 'files.info') result = { ok: true, file: { id: fields.get('file'), user: 'UALICE', user_team: instance.accountId, mode: 'hosted', is_external: false, size: 5, ims: ['DALICE'], url_private_download: `${origin}/files-pri/proof.txt`, ...fileChanges } };
    else if (method === 'proof.txt') { if (redirect) response.writeHead(302, { location: '/forbidden-download' }); response.end('hello'); return; }
    else if (method === 'chat.postMessage') result = { ok: true, channel: fields.get('channel'), ts: `1700000001.${String(++posts).padStart(6, '0')}`, ...replyChanges };
    else if (method === 'files.getUploadURLExternal') result = { ok: true, file_id: 'FOUT', upload_url: uploadUrl ?? `${origin}/upload/proof` };
    else if (method === 'proof') { uploadHook?.(); response.end('OK'); return; }
    else if (method === 'files.completeUploadExternal') result = { ok: true, files: [{ id: 'FOUT' }] };
    else result = { ok: false, error: 'unexpected_request' };
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket) => {
    peer = socket; socket.on('message', (value) => { const result = JSON.parse(value.toString()) as { envelope_id: string }; acks.push(result.envelope_id); });
    socket.send(JSON.stringify({ type: 'hello', num_connections: 1 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const origin = `http://127.0.0.1:${address.port}`;
  const adapter = new SlackIntakeAdapter(instance.id, inbox, 'xoxb-PRIVATE_BOT_TOKEN', 'xapp-PRIVATE_APP_TOKEN', (connected) => activity.push(connected), { apiUrl: `${origin}/`, fileOrigin: origin, signal: abort.signal });
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
  return { config, instance, state, inbox, adapter, chat, calls, acks, activity, abort, send, delivered, origin,
    file: (changes: Record<string, unknown>) => { fileChanges = changes; }, reply: (changes: Record<string, unknown>) => { replyChanges = changes; },
    fail: (value?: typeof failure) => { failure = value; }, redirect: () => { redirect = true; }, uploadUrl: (value: string) => { uploadUrl = value; }, disconnect: () => peer?.close(),
    uploadHook: (value: () => void) => { uploadHook = value; },
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
    expect(events[0].status).toBe('needs-review'); expect(events[1].input.threadId).toBe('1700000000.000001');
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

async function completed(f: Awaited<ReturnType<typeof fixture>>, answer = 'Done') {
  const claimed = f.inbox.claimNext()!;
  f.inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, f.abort.signal));
  f.inbox.finishDispatch(claimed.id, claimed.operationId!, answer); return claimed.id;
}
function fileProcessor(f: Awaited<ReturnType<typeof fixture>>) {
  const processor = new GatewayFileProcessor(f.instance.id, f.inbox, (id, limit, signal, event) => f.adapter.downloadFileSource(id, limit, signal, event), f.abort.signal);
  closes.push(() => processor.stop()); return processor;
}
function replies(f: Awaited<ReturnType<typeof fixture>>) {
  const service = new GatewayReplies(f.inbox, (event, text, signal) => f.adapter.replyText(event, text, signal), f.abort.signal, () => true,
    (event, file, signal) => f.adapter.replyDocument(event, file, signal));
  closes.push(() => service.stop()); return service;
}

describe('Slack files and replies', () => {
  it('saves a private file with verified identity, bounded bytes and no private URL in the journal', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message('1700000000.000001', { text: '', files: [{ id: 'FFILE', name: '../../plan.txt', size: 5 }] }));
    await fileProcessor(f).start(); const saved = f.inbox.list()[0]; expect(saved.status).toBe('queued');
    expect(fs.readFileSync(saved.files![0].file!.path, 'utf8')).toBe('hello'); expect(saved.files![0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(f.calls.find((call) => call.method === 'proof.txt')?.token).toBe('Bearer xoxb-PRIVATE_BOT_TOKEN');
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).not.toContain('/files-pri/');
    await completed(f); await replies(f).wake(); expect(f.inbox.list()[0].reply?.parts[0].status).toBe('sent');
  });

  it.each([{ user_team: 'TOTHER' }, { is_external: true }, { mode: 'external' }, { ims: [] }, { id: 'FOTHER' }, { shared_team_ids: ['TOTHER'] }, { url_private_download: 'https://example.invalid/files-pri/proof' }])('refuses an unsafe file before downloading: %j', async (changes) => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message('1700000000.000001', { files: [{ id: 'FFILE' }] }));
    f.file(changes); await fileProcessor(f).start(); expect(f.inbox.list()[0].files![0].status).toBe('failed'); expect(f.inbox.claimNext()).toBeNull();
    expect(f.calls.some((call) => call.method === 'proof.txt')).toBe(false);
  });

  it('refuses download redirects and retains the failed quota reservation', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message('1700000000.000001', { files: [{ id: 'FFILE' }] })); f.redirect();
    await fileProcessor(f).start(); const file = f.inbox.list()[0].files![0]; expect(file.status).toBe('failed'); expect(file.attempts[0].bytes).toBeGreaterThan(0);
    expect(f.calls.some((call) => call.method === 'forbidden-download')).toBe(false);
  });

  it('splits long replies into plain text parts in the original DM thread without mentioning anyone', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message()); const text = '<!channel> *literal* & 😊 '.repeat(350);
    await completed(f, text); await replies(f).wake();
    const posts = f.calls.filter((call) => call.method === 'chat.postMessage'); expect(posts.length).toBeGreaterThan(1);
    expect(posts.map((call) => call.fields.get('text')).join('')).toBe(text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    expect(posts.every((call) => call.fields.get('text')!.length <= 3000)).toBe(true);
    for (const post of posts) { expect(post.fields.get('thread_ts')).toBe('1700000000.000001'); expect(post.fields.get('mrkdwn')).toBe('false'); expect(post.fields.get('link_names')).toBe('false'); expect(post.fields.get('parse')).toBe('none'); }
    expect(f.inbox.list()[0].reply?.parts.every((part) => part.status === 'sent')).toBe(true);
    await f.delivered(message('1700000000.000002', { thread_ts: '1700000000.000001' }));
    await f.delivered(message('1700000000.000003'));
    const events = f.inbox.list(); expect(events[1].bindingId).toBe(events[0].bindingId); expect(events[2].bindingId).not.toBe(events[0].bindingId);
  });

  it.each([{ status: 429, result: 'pending' }, { status: 500, result: 'uncertain' }, { status: 200, error: 'not_in_channel', result: 'failed' }])('records $status send outcomes without hidden SDK retries', async ({ status, error, result }) => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message()); await completed(f);
    f.fail({ method: 'chat.postMessage', status, error }); await replies(f).wake();
    expect(f.inbox.list()[0].reply?.parts[0].status).toBe(result); expect(f.calls.filter((call) => call.method === 'chat.postMessage')).toHaveLength(1);
    if (status === 429) expect(f.inbox.list()[0].reply?.parts[0].retryAt).toBeGreaterThan(Date.now() + 5000);
    expect(JSON.stringify(f.inbox.list())).not.toContain('PRIVATE_ERROR');
  });

  it('holds a mismatched destination or truncated reply instead of confirming delivery', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message()); await completed(f);
    f.reply({ warning: 'message_truncated', response_metadata: { warnings: ['message_truncated'] } }); await replies(f).wake(); expect(f.inbox.list()[0].reply?.parts[0].status).toBe('uncertain');
  });

  it('rechecks local sender and channel status before sending', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message()); await completed(f); f.channel({ is_ext_shared: true });
    await replies(f).wake(); expect(f.inbox.list()[0].reply?.parts[0].status).toBe('failed'); expect(f.calls.some((call) => call.method === 'chat.postMessage')).toBe(false);
  });

  it('uploads selected verified bytes once and shares them in the original thread after the final reply', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message()); const id = await completed(f);
    const file = path.join(ensureBrain(), `slack-result-${account}.txt`); fs.writeFileSync(file, 'result');
    await selectGatewayDocuments(f.inbox, id, { paths: [file] }, f.abort.signal); const service = replies(f); await service.wake();
    const steps = f.calls.filter((call) => ['chat.postMessage', 'files.getUploadURLExternal', 'proof', 'files.completeUploadExternal'].includes(call.method));
    expect(steps.map((call) => call.method)).toEqual(['chat.postMessage', 'files.getUploadURLExternal', 'proof', 'files.completeUploadExternal']);
    expect(steps[2].bytes).toBe('result'); expect(steps[2].token).toBe(''); expect(steps[3].fields.get('channel_id')).toBe('DALICE'); expect(steps[3].fields.get('thread_ts')).toBe('1700000000.000001');
    expect(f.inbox.list()[0].outgoing?.[0]).toMatchObject({ status: 'sent', remoteId: expect.stringContaining('FOUT') });
    await service.wake(); expect(f.calls.filter((call) => call.method === 'files.completeUploadExternal')).toHaveLength(1);
    fs.writeFileSync(file, 'changed'); await expect(f.adapter.replyDocument(f.inbox.list()[0], f.inbox.list()[0].outgoing![0], f.abort.signal)).rejects.toMatchObject({ outcome: 'failed' });
  });

  it('does not complete a file share if its source changes while uploading bytes', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message()); const id = await completed(f);
    const file = path.join(ensureBrain(), `slack-edited-${account}.txt`); fs.writeFileSync(file, 'result');
    await selectGatewayDocuments(f.inbox, id, { paths: [file] }, f.abort.signal);
    f.uploadHook(() => { const original = f.inbox.list()[0]; f.inbox.accept({ ...original.input, kind: 'edit', sourceEventId: 'during-upload', text: 'Changed request' }); });
    await replies(f).wake(); expect(f.inbox.list()[0].outgoing?.[0].status).toBe('failed');
    expect(f.calls.some((call) => call.method === 'files.completeUploadExternal')).toBe(false);
  });

  it('keeps an uncertain file completion held and does not share again automatically', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message()); const id = await completed(f);
    const file = path.join(ensureBrain(), `slack-uncertain-${account}.txt`); fs.writeFileSync(file, 'result');
    await selectGatewayDocuments(f.inbox, id, { paths: [file] }, f.abort.signal); f.fail({ method: 'files.completeUploadExternal', status: 500 }); const service = replies(f);
    await service.wake(); await service.wake(); expect(f.inbox.list()[0].outgoing?.[0].status).toBe('uncertain');
    expect(f.calls.filter((call) => call.method === 'files.completeUploadExternal')).toHaveLength(1);
  });

  it('refuses an off-origin upload URL without sending bytes or credentials to it', async () => {
    const f = await fixture(); await f.chat.initialize(); await f.delivered(message()); const id = await completed(f);
    const file = path.join(ensureBrain(), `slack-location-${account}.txt`); fs.writeFileSync(file, 'result');
    await selectGatewayDocuments(f.inbox, id, { paths: [file] }, f.abort.signal); f.uploadUrl('https://example.invalid/upload/private'); await replies(f).wake();
    expect(f.calls.some((call) => call.method === 'proof')).toBe(false); expect(f.inbox.list()[0].outgoing?.[0].status).not.toBe('sent');
  });

  it('runs Slack through the shared worker, reconnects without replay and releases ownership on pause', async () => {
    const f = await fixture(); await f.state.disconnect(); let saved: GatewayInbox | undefined; let submissions = 0;
    const worker = new GatewayWorker(f.instance.id, { retryMs: 5, monitorMs: 10,
      execution: { async submit() { submissions++; return {}; }, poll() { return { state: 'completed', answer: 'Worker answer' }; } },
      transport: (state, inbox, activity, signal) => {
        saved = inbox;
        const adapter = new SlackIntakeAdapter(f.instance.id, inbox, 'xoxb-PRIVATE_BOT_TOKEN', 'xapp-PRIVATE_APP_TOKEN', activity, { apiUrl: `${f.origin}/`, fileOrigin: f.origin, signal });
        const chat = new Chat({ userName: 'Athena', adapters: { slack: adapter }, state, logger: quiet });
        return { start: () => chat.initialize(), stop: () => chat.shutdown(), alive: () => adapter.isConnected,
          download: (id, limit, signal, event) => adapter.downloadFileSource(id, limit, signal, event), reply: (event, text, signal) => adapter.replyText(event, text, signal), upload: (event, file, signal) => adapter.replyDocument(event, file, signal) };
      },
    }); closes.push(() => worker.stop()); await worker.start(); expect(worker.health().status).toBe('connected');
    await f.delivered(message('1700000000.000001', { files: [{ id: 'FFILE' }] }));
    await expect.poll(() => saved?.list()[0].reply?.parts[0].status).toBe('sent'); expect(submissions).toBe(1);
    f.disconnect(); await expect.poll(() => f.calls.filter((call) => call.method === 'apps.connections.open').length).toBe(2);
    await f.delivered(message('1700000000.000001', { files: [{ id: 'FFILE' }] })); expect(saved!.list()).toHaveLength(1); expect(submissions).toBe(1);
    await worker.stop(); await f.state.connect(); expect(new GatewayInbox(f.state).list()[0].reply?.parts[0].status).toBe('sent');
  });
});
