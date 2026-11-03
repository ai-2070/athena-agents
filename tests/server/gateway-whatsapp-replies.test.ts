import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chat } from 'chat';
import type { Logger } from 'chat';
import { WhatsAppGatewayAdapter } from '../../server/gateways/whatsapp.ts';
import { WhatsAppRelayIntake } from '../../server/gateways/whatsapp-intake.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayReplies } from '../../server/gateways/replies.ts';
import { saveGatewayInstance, withGatewayRoute } from '../../server/gateways/instances.ts';
import { selectGatewayDocuments } from '../../server/gateways/outgoing.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { ensureBrain } from '../../server/projects.ts';
import { listProjects, saveProjects, setActiveProject } from '../../server/store.ts';
import { gatewayConfig } from './gateway-fixtures.ts';
import type { GatewayInboxEvent } from '../../shared/types.ts';

const EPOCH = '00000000-0000-4000-8000-000000000001'; const BUSINESS = '9000000001'; const ALICE = '436641234567';
const TOKEN = 'FAKE_OUTBOUND_TOKEN'; const SECRET = 'FAKE_WHATSAPP_APP_SECRET'; const DAY = 86400000;
const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
let accounts = 9500000000; const closers: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closers.splice(0).reverse()) await close(); });

async function fixture() {
  const config = { ...gatewayConfig(String(accounts++)), name: 'WhatsApp replies', platform: 'whatsapp', senderPolicy: { platform: 'whatsapp', allowedPhones: [`+${ALICE}`] },
    scope: { directMessages: true, conversationIds: [], guildIds: [] } };
  const instance = saveGatewayInstance(config); const state = new GatewayStateAdapter(instance.id); await state.connect(); const inbox = new GatewayInbox(state);
  inbox.bindWhatsAppRelayConnection({ origin: 'https://relay.example', installationId: '00000000-0000-4000-8000-000000000002', businessAccountId: BUSINESS, phoneNumberId: instance.accountId, epoch: EPOCH }, 0);
  const posts: { path: string; payload?: Record<string, unknown>; form?: FormData }[] = []; const errors: unknown[] = [];
  let failure: { stage: 'messages' | 'media'; status: number; value?: unknown; raw?: string; drop?: boolean; retry?: string } | undefined;
  let responseChange: ((value: Record<string, unknown>) => unknown) | undefined;
  let hook: ((stage: string) => Promise<void> | void) | undefined; let now = Date.now();
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://fixture'); expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`); expect(request.headers.cookie).toBeUndefined();
      if (request.method === 'GET') {
        const result = url.pathname === `/v25.0/${instance.accountId}` ? { id: instance.accountId } : { data: [{ id: instance.accountId }] };
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result)); return;
      }
      expect(request.method).toBe('POST'); const stage = url.pathname.split('/').at(-1)!; expect(['messages', 'media']).toContain(stage);
      expect(url.pathname).toBe(`/v25.0/${instance.accountId}/${stage}`);
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks);
      const item: typeof posts[number] = { path: stage };
      if (stage === 'media') item.form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type']! } }).formData();
      else item.payload = JSON.parse(bytes.toString()) as Record<string, unknown>;
      posts.push(item); await hook?.(stage);
      if (failure?.stage === stage) {
        if (failure.drop) { response.destroy(); return; }
        response.writeHead(failure.status, { 'content-type': 'application/json', ...(failure.retry ? { 'retry-after': failure.retry } : {}) });
        response.end(failure.raw ?? JSON.stringify(failure.value ?? { error: { code: 100, message: 'PRIVATE_PROVIDER_DETAIL' } })); return;
      }
      const value = stage === 'media' ? { id: '9900000001' } : { messaging_product: 'whatsapp', contacts: [{ input: item.payload!.to, wa_id: item.payload!.to,
        ...(item.payload!.recipient ? { user_id: item.payload!.recipient } : {}) }], messages: [{ id: `wamid.sent-${posts.length}` }] };
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(responseChange?.(value) ?? value));
    } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const abort = new AbortController(); const origin = `http://127.0.0.1:${address.port}`;
  const adapter = new WhatsAppGatewayAdapter(instance.id, inbox, { businessAccountId: BUSINESS, accessToken: TOKEN, appSecret: SECRET }, { testOrigin: origin, signal: abort.signal, now: () => now });
  const chat = new Chat({ userName: 'Athena', adapters: { whatsapp: adapter }, state, logger: quiet }); await chat.initialize();
  const intake = new WhatsAppRelayIntake(instance.id, inbox, BUSINESS, SECRET); let sequence = 0;
  async function accept(options: { age?: number; userId?: string; hidden?: boolean; from?: string; confirmed?: boolean; timestamp?: number } = {}) {
    const messageId = `wamid.input-${++sequence}`;
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: BUSINESS, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: instance.accountId }, messages: [{ id: messageId, from: options.hidden ? undefined : options.from ?? ALICE,
        ...(options.userId ? { from_user_id: options.userId } : {}), type: 'text', timestamp: String(Math.floor((options.timestamp ?? Date.now() - (options.age ?? 0)) / 1000)), text: { body: 'Hello' } }],
    } }] }] });
    const bodyBase64 = Buffer.from(raw).toString('base64');
    await intake.receive(EPOCH, { sequence, id: crypto.createHash('sha256').update(bodyBase64).digest('hex'), bodyBase64, receivedAt: Date.now(), expiresAt: Date.now() + 60000,
      signature: 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'), contentType: 'application/json' }, async (proof) => {
      if (options.confirmed === false) throw new Error('Lost ACK'); return { epoch: proof.epoch, cursor: proof.sequence };
    });
    return inbox.list().find((event) => event.input.sourceMessageId === messageId);
  }
  async function assignment(options: Parameters<typeof accept>[0] = {}) {
    const event = (await accept(options))!; const claimed = inbox.claimNext()!;
    inbox.beginDispatch(event.id, claimed.operationId!, await gatewayConversation(claimed, abort.signal));
    return { event: inbox.list().find((item) => item.id === event.id)!, finish: (answer = 'Final answer') => inbox.finishDispatch(event.id, claimed.operationId!, answer) };
  }
  function replies() {
    const value = new GatewayReplies(inbox, (event, text, signal) => adapter.replyText(event, text, signal), abort.signal, () => true,
      (event, file, signal) => adapter.replyDocument(event, file, signal)); closers.push(() => value.stop()); return value;
  }
  async function file(event: GatewayInboxEvent, name = 'report.txt', text = 'selected result') {
    const directory = path.join(withGatewayRoute(event.route, ensureBrain), `whatsapp-out-${accounts}`); fs.mkdirSync(directory, { recursive: true });
    const full = path.join(directory, name); fs.writeFileSync(full, text);
    await selectGatewayDocuments(inbox, event.id, { paths: [full] }, abort.signal); return full;
  }
  closers.unshift(async () => { await adapter.disconnect(); await chat.shutdown(); await state.disconnect(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); expect(errors).toEqual([]); });
  return { config, instance, state, inbox, adapter, abort, posts, accept, assignment, replies, file, intake, origin,
    advance: (ms: number) => { now += ms; }, setNow: (value: number) => { now = value; }, fail: (value: typeof failure) => { failure = value; },
    hook: (value: typeof hook) => { hook = value; }, receipt: (value: typeof responseChange) => { responseChange = value; } };
}

describe('WhatsApp replies and selected documents', () => {
  it('sends the full plain answer in claimed parts to the original recipient/message after project switching', async () => {
    const f = await fixture(); const work = await f.assignment({ userId: 'US.ALICE' }); const answer = 'a'.repeat(2999) + '🧪' + 'b'.repeat(3500); work.finish(answer);
    const other = { ...listProjects()[0], id: `whatsapp-reply-other-${accounts}`, name: 'Other' }; saveProjects([...listProjects(), other]); setActiveProject(other.id);
    await f.replies().wake(); const messages = f.posts.filter((post) => post.path === 'messages');
    expect(messages).toHaveLength(3); expect(messages.map((post) => (post.payload!.text as { body: string }).body).join('')).toBe(answer);
    for (const post of messages) expect(post.payload).toMatchObject({ messaging_product: 'whatsapp', recipient_type: 'individual', to: ALICE, recipient: 'US.ALICE', context: { message_id: work.event.input.sourceMessageId }, type: 'text', text: { preview_url: false } });
    expect(f.inbox.list()[0].reply!.parts.every((part) => part.status === 'sent')).toBe(true);
  });

  it('expires between reply parts, preserves the confirmed prefix and retries only after fresh confirmed activity', async () => {
    const f = await fixture(); const work = await f.assignment({ age: DAY - 5000 }); work.finish('x'.repeat(6500));
    f.hook((stage) => { if (stage === 'messages' && f.posts.length === 1) f.advance(10000); });
    const sender = f.replies(); await sender.wake();
    expect(f.inbox.list()[0].reply!.parts.map((part) => part.status)).toEqual(['sent', 'failed', 'pending']); expect(f.posts).toHaveLength(1);
    expect(f.inbox.list()[0].reply!.reason).toContain('message again');
    await expect(f.accept({ confirmed: false })).rejects.toThrow('Lost ACK'); f.inbox.retryReply(work.event.id); await sender.wake(); expect(f.posts).toHaveLength(1);
    await f.intake.confirmPending(async (proof) => ({ epoch: proof.epoch, cursor: proof.sequence })); f.inbox.retryReply(work.event.id); await sender.wake();
    expect(f.posts).toHaveLength(3); expect(f.inbox.list()[0].reply!.parts.every((part) => part.status === 'sent')).toBe(true);
  });

  it('does not open a window for another sender or extend it by replaying an old message', async () => {
    const f = await fixture(); const work = await f.assignment({ age: DAY + 10000 }); work.finish();
    await f.accept({ from: '436649876543' }); await f.accept({ age: DAY + 10000 }); await f.replies().wake();
    expect(f.posts).toEqual([]); expect(f.inbox.list()[0].reply!.reason).toContain('window closed');
    expect(f.inbox.list()[0].reply!.parts[0].status).toBe('failed');
  });

  it('clamps future signed timestamps to their first local receipt time', async () => {
    const f = await fixture(); const work = await f.assignment({ timestamp: Date.now() + 240000 }); work.finish();
    f.setNow(work.event.receivedAt + DAY + 1); await f.replies().wake(); expect(f.posts).toEqual([]);
  });

  it.each([0, DAY + 10000])('applies the same window check to advisory notices aged %s ms', async (age) => {
    const f = await fixture(); const work = await f.assignment({ age }); f.inbox.queueNotice(work.event.id, 'working');
    await f.replies().wake(); expect(f.posts).toHaveLength(age ? 0 : 1);
    expect(f.inbox.list()[0].notices!.working!.status).toBe(age ? 'failed' : 'sent');
  });

  it('confirms a phone receipt even when Meta adds a previously unseen user ID', async () => {
    const f = await fixture(); const work = await f.assignment(); work.finish();
    f.receipt((value) => ({ ...value, contacts: [{ input: ALICE, wa_id: ALICE, user_id: 'US.UNSEEN' }] }));
    await f.replies().wake(); expect(f.inbox.list()[0].reply!.parts[0].status).toBe('sent');
    expect(f.inbox.whatsAppRelayState()!.identities!.users).toEqual([]);
  });

  it('uploads only the selected verified file then sends one contextual document receipt', async () => {
    const f = await fixture(); const work = await f.assignment(); const target = await f.file(work.event, 'report.txt'); work.finish();
    await f.replies().wake(); expect(f.posts.map((post) => post.path)).toEqual(['messages', 'media', 'messages']);
    const form = f.posts[1].form!; expect(form.get('messaging_product')).toBe('whatsapp'); expect(form.get('type')).toBe('text/plain');
    expect(await (form.get('file') as Blob).text()).toBe(fs.readFileSync(target, 'utf8'));
    expect(f.posts[2].payload).toMatchObject({ to: ALICE, type: 'document', document: { id: '9900000001', filename: 'report.txt' }, context: { message_id: work.event.input.sourceMessageId } });
    expect(f.inbox.list()[0].outgoing![0].status).toBe('sent');
  });

  it.each(['before', 'upload'])('refuses an expired window %s the file message without a fallback send', async (stage) => {
    const f = await fixture(); const work = await f.assignment({ age: stage === 'upload' ? DAY - 5000 : 0 }); work.finish(); const sender = f.replies(); await sender.wake();
    await f.file(work.event);
    if (stage === 'before') f.advance(DAY + 10000); else f.hook((kind) => { if (kind === 'media') f.advance(10000); });
    await sender.wake(); expect(f.posts.filter((post) => post.path === 'messages')).toHaveLength(1);
    expect(f.posts.filter((post) => post.path === 'media')).toHaveLength(stage === 'before' ? 0 : 1);
    expect(f.inbox.list()[0].outgoing![0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('message again') });
  });

  it.each(['changed', 'unsupported', 'revoked'])('refuses %s files before uploading bytes', async (kind) => {
    const f = await fixture(); const work = await f.assignment(); work.finish(); const sender = f.replies(); await sender.wake();
    const target = await f.file(work.event, kind === 'unsupported' ? 'report.zip' : 'report.txt');
    if (kind === 'changed') fs.writeFileSync(target, 'changed output');
    if (kind === 'revoked') saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436649876543'] } }, f.instance.id);
    await sender.wake(); expect(f.posts.map((post) => post.path)).toEqual(['messages']); expect(f.inbox.list()[0].outgoing![0].status).toBe('failed');
    if (kind === 'unsupported') expect(f.inbox.list()[0].outgoing![0].reason).toContain('supported file');
  });

  it('requires a fresh claimed attempt and blocks concurrent duplicate POSTs', async () => {
    const f = await fixture(); const work = await f.assignment(); work.finish();
    await expect(f.adapter.replyText(f.inbox.list()[0], 'Final answer', f.abort.signal)).rejects.toMatchObject({ outcome: 'failed' });
    const claimed = f.inbox.claimReply()!; let release: () => void = () => {}; const wait = new Promise<void>((resolve) => { release = resolve; }); f.hook(() => wait);
    const first = f.adapter.replyText(claimed.event, claimed.event.reply!.parts[claimed.index].text, f.abort.signal);
    await expect.poll(() => f.posts.length).toBe(1);
    await expect(f.adapter.replyText(claimed.event, 'Final answer', f.abort.signal)).rejects.toMatchObject({ outcome: 'uncertain' }); release(); expect(await first).toContain('wamid.sent-'); expect(f.posts).toHaveLength(1);
  });

  it('refuses a claimed reply whose assignment was put under review before I/O', async () => {
    const f = await fixture(); const work = await f.assignment(); work.finish(); const claim = f.inbox.claimReply()!;
    f.inbox.review(work.event.id);
    await expect(f.adapter.replyText(claim.event, 'Final answer', f.abort.signal)).rejects.toMatchObject({ outcome: 'failed' }); expect(f.posts).toEqual([]);
  });

  it.each(['drop', 'missing', 'rate'])('never posts a document after an unconfirmed %s upload', async (kind) => {
    const f = await fixture(); const work = await f.assignment(); await f.file(work.event); work.finish();
    f.fail({ stage: 'media', status: kind === 'rate' ? 429 : 200, drop: kind === 'drop', value: {}, retry: '1' });
    const sender = f.replies(); await sender.wake(); await sender.wake();
    expect(f.posts.map((post) => post.path)).toEqual(['messages', 'media']);
    expect(f.inbox.list()[0].outgoing![0].status).toBe(kind === 'rate' ? 'pending' : 'failed');
  });

  it('does not reuse a send claim left by an earlier adapter connection', async () => {
    const f = await fixture(); const work = await f.assignment(); work.finish(); const claim = f.inbox.claimReply()!;
    await f.adapter.replyText(claim.event, 'Final answer', f.abort.signal); await f.adapter.disconnect();
    // A lost local settlement must not become a second POST on reconnect.
    const wire = f.posts[0]; expect(wire.path).toBe('messages');
    const next = new WhatsAppGatewayAdapter(f.instance.id, f.inbox, { businessAccountId: BUSINESS, accessToken: TOKEN, appSecret: SECRET }, { testOrigin: f.origin });
    const chat = new Chat({ userName: 'Athena', adapters: { whatsapp: next }, state: f.state, logger: quiet }); await chat.initialize();
    closers.push(async () => { await next.disconnect(); await chat.shutdown(); });
    await expect(next.replyText(claim.event, 'Final answer', f.abort.signal)).rejects.toMatchObject({ outcome: 'uncertain' });
    expect(f.posts).toHaveLength(1);
  });

  it.each(['drop', 'json', 'recipient', 'id', 'status'])('holds uncertain %s message outcomes without an automatic resend', async (kind) => {
    const f = await fixture(); const work = await f.assignment(); work.finish();
    if (kind === 'drop') f.fail({ stage: 'messages', status: 200, drop: true });
    if (kind === 'json') f.fail({ stage: 'messages', status: 200, raw: '{PRIVATE_BROKEN_BODY' });
    if (kind === 'recipient') f.receipt((value) => ({ ...value, contacts: [{ input: ALICE, wa_id: '436649876543' }] }));
    if (kind === 'id') f.receipt((value) => ({ ...value, messages: [] }));
    if (kind === 'status') f.fail({ stage: 'messages', status: 202, value: { messaging_product: 'whatsapp', contacts: [{ input: ALICE, wa_id: ALICE }], messages: [{ id: 'wamid.pending' }] } });
    const sender = f.replies(); await sender.wake(); await sender.wake(); expect(f.posts).toHaveLength(1);
    expect(f.inbox.list()[0].reply!.parts[0].status).toBe('uncertain'); expect(f.inbox.list()[0].reply!.reason).not.toContain('PRIVATE');
    f.inbox.recover(); await sender.wake(); expect(f.posts).toHaveLength(1);
  });

  it.each([401, 500, 429, 131047, 130429])('classifies provider refusal %s with safe durable outcomes', async (code) => {
    const f = await fixture(); const work = await f.assignment(); work.finish();
    f.fail({ stage: 'messages', status: code < 1000 ? code : 400, value: { error: { code, message: 'PRIVATE_PROVIDER_TOKEN' } }, retry: '1' });
    const sender = f.replies(); await sender.wake(); const part = f.inbox.list()[0].reply!.parts[0];
    expect(part.status).toBe(code === 429 || code === 130429 ? 'pending' : code === 500 ? 'uncertain' : 'failed');
    if (part.status === 'pending') expect(part.retryAt).toBeGreaterThan(Date.now());
    if (code === 131047) expect(f.inbox.list()[0].reply!.reason).toContain('message again');
    await sender.wake(); expect(f.posts).toHaveLength(1); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).not.toContain('PRIVATE_PROVIDER_TOKEN');
  });

  it('does not send a document after access is revoked while its upload completes', async () => {
    const f = await fixture(); const work = await f.assignment(); await f.file(work.event); work.finish();
    f.hook((stage) => { if (stage === 'media') saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436649876543'] } }, f.instance.id); });
    await f.replies().wake(); expect(f.posts.map((post) => post.path)).toEqual(['messages', 'media']); expect(f.inbox.list()[0].outgoing![0].status).toBe('failed');
  });
});
