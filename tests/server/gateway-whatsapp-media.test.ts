import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { Chat } from 'chat';
import type { Logger } from 'chat';
import { afterEach, describe, expect, it } from 'vitest';
import { WhatsAppGatewayAdapter, whatsAppMediaUrl } from '../../server/gateways/whatsapp.ts';
import { WhatsAppRelayIntake } from '../../server/gateways/whatsapp-intake.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayFileProcessor } from '../../server/gateways/files.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { saveGatewayInstance, withGatewayRoute } from '../../server/gateways/instances.ts';
import { activeProject, listProjects, saveProjects, setActiveProject, withProject } from '../../server/store.ts';
import { uploadsRoot } from '../../server/uploads.ts';
import { gatewayConfig } from './gateway-fixtures.ts';
import { whatsAppMediaHash } from '../../shared/gateway-whatsapp.ts';
import type { GatewayDownloadSource } from '../../server/gateways/files.ts';

const EPOCH = '00000000-0000-4000-8000-000000000001'; const BUSINESS = '9000000001'; const FILE = '9300000001';
const SECRET = 'FAKE_META_APP_SECRET'; const TOKEN = 'FAKE_OUTBOUND_META_TOKEN'; const ALICE = '436641234567';
const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
const hash = crypto.createHash('sha256').update('hello').digest('hex');
const closers: (() => Promise<void>)[] = []; let accounts = 9400000000;
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function consume(source: GatewayDownloadSource): Promise<Buffer> {
  try { const chunks: Buffer[] = []; for await (const chunk of source.source) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks); }
  finally { await source.cancel?.(); }
}
async function fixture() {
  const config = { ...gatewayConfig(String(accounts++)), name: 'WhatsApp media', platform: 'whatsapp',
    senderPolicy: { platform: 'whatsapp', allowedPhones: [`+${ALICE}`] }, scope: { directMessages: true, conversationIds: [], guildIds: [] } };
  const instance = saveGatewayInstance(config); const state = new GatewayStateAdapter(instance.id); await state.connect(); const inbox = new GatewayInbox(state);
  inbox.bindWhatsAppRelayConnection({ origin: 'https://relay.example', installationId: '00000000-0000-4000-8000-000000000002', businessAccountId: BUSINESS, phoneNumberId: instance.accountId, epoch: EPOCH }, 0);
  const calls: { path: string; token: string; method: string }[] = [];
  const account: { id: string } = { id: instance.accountId };
  const pages: Record<string, unknown> = { '': { data: [{ id: instance.accountId }] } };
  const metadata: { id: string; messaging_product: string; file_size: number; sha256: string; mime_type: string; url: string } = {
    id: FILE, messaging_product: 'whatsapp', file_size: 5, sha256: hash, mime_type: 'text/plain', url: '',
  };
  const binary = { body: Buffer.from('hello'), status: 200, type: 'text/plain', length: '5' as string | null, redirect: '', encoding: '' };
  let failure: { path: string; status: number; body?: string } | undefined;
  let gate: { path: string; wait: () => Promise<void> } | undefined;
  const errors: unknown[] = [];
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://fixture');
      calls.push({ path: url.pathname + url.search, token: request.headers.authorization ?? '', method: request.method ?? '' });
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`); expect(request.method).toBe('GET'); expect(request.headers.cookie).toBeUndefined();
      if (gate?.path === url.pathname) await gate.wait();
      if (failure?.path === url.pathname) { response.writeHead(failure.status, { 'content-type': 'application/json' }); response.end(failure.body ?? '{"error":"PRIVATE_ERROR"}'); return; }
      if (url.pathname === '/file') {
        expect(request.headers['accept-encoding']).toBe('identity');
        if (binary.redirect) { response.writeHead(302, { location: binary.redirect }); response.end(); return; }
        response.statusCode = binary.status; response.setHeader('content-type', binary.type);
        if (binary.length !== null) response.setHeader('content-length', binary.length); else response.setHeader('transfer-encoding', 'chunked');
        if (binary.encoding) response.setHeader('content-encoding', binary.encoding);
        response.end(binary.body); return;
      }
      let result: unknown;
      if (url.pathname === `/v25.0/${instance.accountId}`) { expect(url.searchParams.get('fields')).toBe('id,display_phone_number'); result = account; }
      else if (url.pathname === `/v25.0/${BUSINESS}/phone_numbers`) {
        expect(url.searchParams.get('fields')).toBe('id,display_phone_number'); expect(url.searchParams.get('limit')).toBe('100'); result = pages[url.searchParams.get('after') ?? ''];
      } else if (url.pathname === `/v25.0/${FILE}`) result = metadata;
      else { response.writeHead(404); response.end(); return; }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result));
    } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const origin = `http://127.0.0.1:${address.port}`; metadata.url = `${origin}/file`;
  const abort = new AbortController();
  const adapter = new WhatsAppGatewayAdapter(instance.id, inbox, { businessAccountId: BUSINESS, accessToken: TOKEN, appSecret: SECRET }, { testOrigin: origin, signal: abort.signal });
  const chat = new Chat({ userName: 'Athena', adapters: { whatsapp: adapter }, state, logger: quiet });
  const intake = new WhatsAppRelayIntake(instance.id, inbox, BUSINESS, SECRET); let sequence = 0;
  const accept = async (overrides: Record<string, unknown> = {}, acknowledge = async (proof: { epoch: string; sequence: number }) => ({ epoch: proof.epoch, cursor: proof.sequence })) => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: BUSINESS, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: instance.accountId }, messages: [{ id: `wamid.${++sequence}`, timestamp: '1700000000', from: ALICE, type: 'document',
        document: { id: FILE, filename: '../../CON.txt', mime_type: 'text/plain', sha256: Buffer.from(hash, 'hex').toString('base64'), ...overrides } }],
    } }] }] });
    const bodyBase64 = Buffer.from(raw).toString('base64');
    await intake.receive(EPOCH, { sequence, id: crypto.createHash('sha256').update(bodyBase64).digest('hex'), receivedAt: Date.now(), expiresAt: Date.now() + 60000,
      bodyBase64, signature: 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'), contentType: 'application/json' }, acknowledge);
    return inbox.list().at(-1)!;
  };
  closers.push(async () => { gate = undefined; await adapter.disconnect(); await chat.shutdown(); await state.disconnect(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); expect(errors).toEqual([]); });
  return { instance, config, state, inbox, adapter, chat, calls, metadata, binary, account, pages, accept, origin, abort,
    fail: (value: typeof failure) => { failure = value; }, gate: (value: typeof gate) => { gate = value; } };
}

describe('WhatsApp account and media transport', () => {
  it('uses the pinned SDK with read-only phone/business checks and refuses its public webhook and unguarded sends', async () => {
    const f = await fixture(); await f.chat.initialize(); expect(f.adapter.botUserId).toBe(f.instance.accountId);
    for (const method of ['GET', 'POST']) expect((await f.adapter.handleWebhook(new Request('https://dashboard.test/webhook', { method }))).status).toBe(404);
    const count = f.calls.length;
    await expect(f.adapter.postMessage(`whatsapp:${f.instance.accountId}:${ALICE}`, 'hello')).rejects.toThrow('saved WhatsApp reply');
    await expect(f.adapter.sendTemplate(`whatsapp:${f.instance.accountId}:${ALICE}`, { name: 'never', language: 'en' })).rejects.toThrow('saved WhatsApp reply');
    await expect(f.adapter.downloadMedia(FILE)).rejects.toThrow('resend'); expect(f.calls).toHaveLength(count);
  });

  it.each(['phone', 'membership', 'permission', 'malformed'])('refuses bad %s checks before media access', async (kind) => {
    const f = await fixture();
    if (kind === 'phone') f.account.id = '999';
    if (kind === 'membership') f.pages[''] = { data: [{ id: '999' }] };
    if (kind === 'permission') f.fail({ path: `/v25.0/${BUSINESS}/phone_numbers`, status: 403 });
    if (kind === 'malformed') f.fail({ path: `/v25.0/${f.instance.accountId}`, status: 200, body: '{broken' });
    await expect(f.chat.initialize()).rejects.toThrow('could not verify');
    const event = await f.accept(); await expect(f.adapter.downloadFileSource(FILE, 100, f.abort.signal, event)).rejects.toThrow('resend');
    expect(f.calls.some((call) => call.path === `/v25.0/${FILE}`)).toBe(false);
  });

  it('follows bounded account cursors on the fixed API path rather than provider next URLs', async () => {
    const f = await fixture(); f.pages[''] = { data: [{ id: '999' }], paging: { next: 'https://never-fetch.invalid/PRIVATE_TOKEN', cursors: { after: 'next & page' } } };
    f.pages['next & page'] = { data: [{ id: f.instance.accountId }] }; await f.chat.initialize();
    expect(f.calls.at(-1)!.path).toContain('after=next%20%26%20page');
  });

  it.each(['missing', 'repeated', 'many'])('stops unsafe %s account pagination', async (kind) => {
    const f = await fixture();
    f.pages[''] = { data: [{ id: '999' }], paging: { next: 'https://never-fetch.invalid/', ...(kind === 'missing' ? {} : { cursors: { after: '1' } }) } };
    for (let i = 1; i <= 10; i++) f.pages[String(i)] = { data: [{ id: String(1000 + i) }], paging: { next: 'https://never-fetch.invalid/', cursors: { after: kind === 'repeated' ? '1' : String(i + 1) } } };
    await expect(f.chat.initialize()).rejects.toThrow('could not verify'); expect(f.calls.length).toBeLessThanOrEqual(11);
  });

  it('saves only hash-verified bytes under the bound project and downloads nothing before ACK', async () => {
    const f = await fixture(); await f.chat.initialize();
    const processor = new GatewayFileProcessor(f.instance.id, f.inbox, (...args) => f.adapter.downloadFileSource(...args), f.abort.signal); closers.push(() => processor.stop()); await processor.start();
    const project = activeProject(); const other = { ...project, id: `whatsapp-media-other-${accounts}`, name: 'Other' }; saveProjects([...listProjects(), other]); setActiveProject(other.id);
    await f.accept({}, async (proof) => { await processor.wake(); expect(f.calls.some((call) => call.path === `/v25.0/${FILE}`)).toBe(false); return { epoch: proof.epoch, cursor: proof.sequence }; });
    await processor.wake(); const saved = f.inbox.list()[0]; expect(saved.status).toBe('queued');
    const file = saved.files![0]; expect(file.sha256).toBe(hash); expect(fs.readFileSync(file.file!.path, 'utf8')).toBe('hello');
    expect(fs.realpathSync(file.file!.path).startsWith(fs.realpathSync(withProject(project, uploadsRoot)) + path.sep)).toBe(true); expect(file.file!.name).not.toContain('/');
    expect(saved.input.media[0].sha256).toBe(hash); expect(activeProject().id).toBe(other.id);
    await processor.wake(); expect(f.calls.filter((call) => call.path === '/file')).toHaveLength(1);
    const disk = fs.readFileSync(f.state.inboxFile(), 'utf8'); for (const secret of [TOKEN, SECRET, f.metadata.url]) expect(disk).not.toContain(secret);
  });

  it.each(['id', 'hash', 'mime', 'size', 'url', 'product'])('refuses mismatched %s metadata before requesting binary bytes', async (kind) => {
    const f = await fixture(); await f.chat.initialize(); const event = await f.accept();
    if (kind === 'id') f.metadata.id = '999';
    if (kind === 'hash') f.metadata.sha256 = '0'.repeat(64);
    if (kind === 'mime') f.metadata.mime_type = 'text/html';
    if (kind === 'size') f.metadata.file_size = 101;
    if (kind === 'url') f.metadata.url = 'https://attacker.example/PRIVATE_TOKEN';
    if (kind === 'product') f.metadata.messaging_product = 'other';
    await expect(f.adapter.downloadFileSource(FILE, 100, f.abort.signal, event)).rejects.toThrow(); expect(f.calls.some((call) => call.path === '/file')).toBe(false);
  });

  it.each(['bytes', 'short', 'long', 'headers', 'redirect', 'encoding', 'mime', 'partial'])('refuses bad %s while saving, leaving the whole input held', async (kind) => {
    const f = await fixture(); await f.chat.initialize();
    if (kind === 'bytes') f.binary.body = Buffer.from('other');
    if (kind === 'short') { f.binary.body = Buffer.from('hell'); f.binary.length = null; }
    if (kind === 'long') { f.binary.body = Buffer.from('helloo'); f.binary.length = null; }
    if (kind === 'headers') f.binary.length = '4';
    if (kind === 'redirect') f.binary.redirect = `${f.origin}/never`;
    if (kind === 'encoding') f.binary.encoding = 'gzip';
    if (kind === 'mime') f.binary.type = 'text/html';
    if (kind === 'partial') f.binary.status = 206;
    const event = await f.accept();
    const processor = new GatewayFileProcessor(f.instance.id, f.inbox, (...args) => f.adapter.downloadFileSource(...args), f.abort.signal); closers.push(() => processor.stop()); await processor.start();
    const saved = f.inbox.list()[0]; expect(saved.status).toBe('waiting-files'); expect(saved.files![0].status).toBe('failed'); expect(saved.files![0].file).toBeUndefined();
    expect(fs.readdirSync(withGatewayRoute(event.route, () => path.join(uploadsRoot(), saved.fileBatch!)))).toEqual([]);
    expect(f.inbox.claimNext()).toBeNull(); expect(f.calls.some((call) => call.path === '/never')).toBe(false);
  });

  it('requires signed hashes and rechecks sender policy and the saved descriptor before metadata I/O', async () => {
    const f = await fixture(); await f.chat.initialize(); const event = await f.accept(); const count = f.calls.length;
    await expect(f.adapter.downloadFileSource(FILE, 100, f.abort.signal, { ...event, input: { ...event.input, media: [{ ...event.input.media[0], sha256: '0'.repeat(64) }] } })).rejects.toThrow();
    await expect(f.adapter.downloadFileSource('999', 100, f.abort.signal, event)).rejects.toThrow();
    const missing = await f.accept({ sha256: undefined }); await expect(f.adapter.downloadFileSource(FILE, 100, f.abort.signal, missing)).rejects.toThrow();
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436649876543'] } }, f.instance.id);
    await expect(f.adapter.downloadFileSource(FILE, 100, f.abort.signal, event)).rejects.toThrow(); expect(f.calls).toHaveLength(count);
  });

  it('keeps canonical signed hashes and refuses a malformed one without ACK or a partial receipt', async () => {
    const f = await fixture(); const event = await f.accept({ sha256: hash.toUpperCase() }); expect(event.input.media[0].sha256).toBe(hash);
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); let acknowledgements = 0;
    await expect(f.accept({ sha256: 'not-a-provider-hash' }, async (proof) => { acknowledgements++; return { epoch: proof.epoch, cursor: proof.sequence }; })).rejects.toThrow('could not be verified');
    expect(acknowledgements).toBe(0); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
  });

  it('checks access again after metadata returns and drains stop during a stalled request', async () => {
    const f = await fixture(); await f.chat.initialize(); const event = await f.accept(); let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => { release = resolve; }); f.gate({ path: `/v25.0/${FILE}`, wait: () => wait });
    const pending = f.adapter.downloadFileSource(FILE, 100, f.abort.signal, event);
    await expect.poll(() => f.calls.some((call) => call.path === `/v25.0/${FILE}`)).toBe(true);
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436649876543'] } }, f.instance.id); release();
    await expect(pending).rejects.toThrow(); expect(f.calls.some((call) => call.path === '/file')).toBe(false);
    saveGatewayInstance(f.config, f.instance.id); let releaseStop: () => void = () => {};
    const waitStop = new Promise<void>((resolve) => { releaseStop = resolve; }); f.gate({ path: `/v25.0/${FILE}`, wait: () => waitStop });
    const stopped = f.adapter.downloadFileSource(FILE, 100, f.abort.signal, event); await expect.poll(() => f.calls.filter((call) => call.path === `/v25.0/${FILE}`).length).toBe(2);
    await f.adapter.disconnect(); await expect(stopped).rejects.toThrow(); releaseStop();
  });

  it('cancels an open binary stream and cannot download through the SDK buffered helper', async () => {
    const f = await fixture(); await f.chat.initialize(); const event = await f.accept();
    const download = await f.adapter.downloadFileSource(FILE, 100, f.abort.signal, event); await f.adapter.disconnect();
    await expect(consume(download)).rejects.toThrow();
  });

  it('rechecks reduced file limits before requesting the binary stream', async () => {
    const f = await fixture(); await f.chat.initialize(); const event = await f.accept(); let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => { release = resolve; }); f.gate({ path: `/v25.0/${FILE}`, wait: () => wait });
    const pending = f.adapter.downloadFileSource(FILE, 100, f.abort.signal, event);
    await expect.poll(() => f.calls.some((call) => call.path === `/v25.0/${FILE}`)).toBe(true);
    saveGatewayInstance({ ...f.config, fileLimits: { ...f.config.fileLimits, perFileBytes: 4 } }, f.instance.id); release();
    await expect(pending).rejects.toThrow('download limit'); expect(f.calls.some((call) => call.path === '/file')).toBe(false);
  });

  it('accepts only canonical provider hashes and trusted HTTPS CDN host families', () => {
    expect(whatsAppMediaHash(Buffer.from(hash, 'hex').toString('base64'))).toBe(hash); expect(whatsAppMediaHash(hash.toUpperCase())).toBe(hash);
    for (const value of ['bad', '0'.repeat(63), 'a'.repeat(43) + '=']) expect(whatsAppMediaHash(value)).toBeNull();
    for (const value of ['https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=123&hash=opaque', 'https://cdn.fbcdn.net/file']) expect(whatsAppMediaUrl(value)).toBe(value);
    for (const value of ['http://lookaside.fbsbx.com/file', 'https://lookaside.fbsbx.com.attacker.example/file', 'https://attackerfbcdn.net/file', 'https://user:pass@lookaside.fbsbx.com/file', 'https://lookaside.fbsbx.com:444/file', 'https://lookaside.fbsbx.com/file#', 'https://lookaside.fbsbx.com/file?access_token=PRIVATE', 'https://127.0.0.1/file']) expect(() => whatsAppMediaUrl(value)).toThrow();
  });
});
