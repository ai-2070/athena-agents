import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayWhatsAppRelayEnvelope, GatewayWhatsAppRelayStatus } from '../../shared/types.ts';
import * as platforms from '../../shared/gateways.ts';
import { getGatewaySecrets } from '../../server/store.ts';
import { ensureBrain } from '../../server/projects.ts';
import { saveGatewayCredentials, saveGatewayInstance, withGatewayRoute } from '../../server/gateways/instances.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayWorker } from '../../server/gateways/worker.ts';
import { whatsAppTransport } from '../../server/gateways/whatsapp-transport.ts';
import type { Transport } from '../../server/gateways/worker.ts';
import { gatewayConfig } from './gateway-fixtures.ts';

const EPOCH = '00000000-0000-4000-8000-000000000001'; const INSTALLATION = '00000000-0000-4000-8000-000000000002';
const BUSINESS = '9000000001'; const ACTOR = '436641234567'; const SECRET = 'PRIVATE_META_APP_SECRET'; const TOKEN = 'PRIVATE_META_ACCESS_TOKEN';
const PULL = 'a'.repeat(64); const LEASE = 'b'.repeat(64); const ORIGIN = 'https://relay.example'; const FILE = '9300000001';
const limits = { bodyBytes: 1048576, queueBytes: 16777216, queueEvents: 1000, replayEntries: 10000, retentionMs: 259200000, replayMs: 604800000, pairingMs: 600000, leaseMs: 60000, batchBytes: 2097152, batchEvents: 20 };
const closes: (() => Promise<void>)[] = []; let accounts = 9400000000;
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function fixture() {
  const config = { ...gatewayConfig(String(accounts++)), name: 'WhatsApp transport', platform: 'whatsapp',
    senderPolicy: { platform: 'whatsapp', allowedPhones: [`+${ACTOR}`] }, scope: { directMessages: true, conversationIds: [], guildIds: [] } };
  const instance = saveGatewayInstance(config); saveGatewayCredentials(instance.id, { accessToken: TOKEN, signingSecret: SECRET, relayKey: PULL });
  const state = new GatewayStateAdapter(instance.id); await state.connect(); const inbox = new GatewayInbox(state);
  let currentInbox = inbox;
  inbox.bindWhatsAppRelayConnection({ origin: ORIGIN, installationId: INSTALLATION, businessAccountId: BUSINESS, phoneNumberId: instance.accountId, epoch: EPOCH }, 0);
  const queue: GatewayWhatsAppRelayEnvelope[] = []; let cursor = 0; let lastId = ''; let leased = false;
  const calls: string[] = []; const posts: Record<string, unknown>[] = []; const errors: unknown[] = []; const uploads: string[] = [];
  const metadata: Partial<GatewayWhatsAppRelayStatus> = {}; let ackFailure: 'before' | 'after' | undefined;
  let metaDenied = false; let relayStatus = 200; let stalled = false; let graphOrigin = '';
  const digest = crypto.createHash('sha256').update('hello').digest('hex');
  function enqueue(messageId: string, media = false) {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: BUSINESS, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: instance.accountId }, messages: [{ id: messageId, from: ACTOR, timestamp: String(Math.floor(Date.now() / 1000)),
        ...(media ? { type: 'document', document: { id: FILE, mime_type: 'text/plain', filename: 'input.txt', sha256: digest } } : { type: 'text', text: { body: messageId } }) }],
    } }] }] });
    const bodyBase64 = Buffer.from(raw).toString('base64');
    const envelope = { sequence: cursor + queue.length + 1, id: crypto.createHash('sha256').update(bodyBase64).digest('hex'), receivedAt: Date.now(), expiresAt: Date.now() + 60000,
      bodyBase64, signature: 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'), contentType: 'application/json' };
    queue.push(envelope); return envelope;
  }
  const status = () => ({ version: 1, installationId: INSTALLATION, businessAccountId: BUSINESS, phoneNumberId: instance.accountId, epoch: EPOCH,
    cursor, gap: null, limits, queuedEvents: queue.length, queuedBytes: 100 * queue.length, ...metadata });
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    const address = new URL(url); calls.push(address.pathname); expect(address.origin).toBe(ORIGIN);
    const headers = new Headers(init.headers); expect(headers.get('authorization')).toBe(`Bearer ${PULL}`); expect(init.redirect).toBe('error');
    if (stalled) return new Promise<Response>(() => {});
    if (relayStatus !== 200) return Response.json({ error: 'PRIVATE_RELAY_ERROR' }, { status: relayStatus, headers: { 'retry-after': '60' } });
    if (address.pathname === '/v1/status') return Response.json(status());
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (address.pathname === '/v1/claim') {
      expect(body.epoch).toBe(EPOCH); expect(leased).toBe(false); leased = true;
      return Response.json({ epoch: EPOCH, cursor, lease: LEASE, expiresAt: Date.now() + 60000 });
    }
    expect(headers.get('x-relay-lease')).toBe(LEASE);
    if (address.pathname === '/v1/pull') return Response.json({ ...status(), envelopes: queue.slice(0, 20), leaseExpiresAt: Date.now() + 60000 });
    if (address.pathname === '/v1/ack') {
      expect(currentInbox.whatsAppRelayState()!.receipt).toMatchObject({ sequence: body.through, id: body.eventId, confirmed: false });
      expect(currentInbox.list().every((event) => event.relay?.confirmed || !event.operationId)).toBe(true);
      if (ackFailure === 'before') { ackFailure = undefined; throw new Error('PRIVATE_ACK_ERROR'); }
      if (body.through !== cursor || body.eventId !== lastId) {
        const next = queue.shift()!; expect(next.id).toBe(body.eventId); expect(next.sequence).toBe(body.through); cursor = next.sequence; lastId = next.id;
      }
      if (ackFailure === 'after') { ackFailure = undefined; throw new Error('PRIVATE_ACK_ERROR'); }
      return Response.json({ cursor });
    }
    if (address.pathname === '/v1/release') { leased = false; return Response.json({ released: true }); }
    throw new Error('Unexpected relay fixture request');
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://fixture'); calls.push(url.pathname); expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
      let result: unknown;
      if (metaDenied) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'PRIVATE_META_ERROR' })); return; }
      if (req.method === 'POST') {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks);
        if (url.pathname.endsWith('/media')) {
          const form = await new Response(bytes, { headers: { 'content-type': req.headers['content-type']! } }).formData(); uploads.push(await (form.get('file') as Blob).text()); result = { id: '9900000001' };
        } else {
          const body = JSON.parse(bytes.toString()) as Record<string, unknown>; posts.push(body);
          result = { messaging_product: 'whatsapp', contacts: [{ input: ACTOR, wa_id: ACTOR }], messages: [{ id: `wamid.out-${posts.length}` }] };
        }
      } else if (url.pathname === `/v25.0/${instance.accountId}`) result = { id: instance.accountId };
      else if (url.pathname === `/v25.0/${BUSINESS}/phone_numbers`) result = { data: [{ id: instance.accountId }] };
      else if (url.pathname === `/v25.0/${FILE}`) {
        expect(currentInbox.whatsAppRelayState()!.receipt!.confirmed).toBe(true);
        result = { id: FILE, messaging_product: 'whatsapp', file_size: 5, mime_type: 'text/plain', sha256: digest, url: `${graphOrigin}/file` };
      } else if (url.pathname === '/file') { res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5' }); res.end('hello'); return; }
      else throw new Error('Unexpected Meta fixture request');
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
    } catch (error) { errors.push(error); res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); expect(address).not.toBeNull();
  if (!address || typeof address === 'string') throw new Error('No fixture address'); graphOrigin = `http://127.0.0.1:${address.port}`;
  closes.push(async () => { await state.disconnect(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); expect(errors).toEqual([]); });
  function transport(signal = new AbortController().signal, activity: (connected: boolean) => void = () => {}) {
    const value = whatsAppTransport(state, inbox, activity, signal, { testOrigin: graphOrigin, request }); closes.push(() => value.stop()); return value;
  }
  return { config, instance, state, inbox, queue, calls, posts, uploads, metadata, enqueue, request, transport, graphOrigin,
    useInbox: (value: GatewayInbox) => { currentInbox = value; },
    loseAck: (when: 'before' | 'after') => { ackFailure = when; }, denyMeta: () => { metaDenied = true; },
    setRelayStatus: (value: number) => { relayStatus = value; }, stall: () => { stalled = true; } };
}

async function supervised(f: Awaited<ReturnType<typeof fixture>>, options: { pending?: boolean; document?: boolean; monitorMs?: number } = {}) {
  // The platform stays unavailable in the product until pairing and review controls are ready.
  vi.spyOn(platforms, 'gatewayPlatformAvailable').mockReturnValue(true);
  await f.state.disconnect(); let saved: GatewayInbox | undefined; let submissions = 0; let signal: AbortSignal | undefined; let transport: Transport | undefined;
  const worker = new GatewayWorker(f.instance.id, { retryMs: 60000, monitorMs: options.monitorMs ?? 10,
    execution: {
      async submit(event, abort) {
        submissions++; expect(event.relay?.confirmed).toBe(true); signal = abort;
        if (options.document) {
          const file = path.join(withGatewayRoute(event.route, ensureBrain), `whatsapp-worker-${accounts}.txt`); fs.writeFileSync(file, 'Selected result');
          await worker.selectDocuments(event.id, { paths: [file] });
        }
        return {};
      },
      poll: () => options.pending ? { state: 'pending' } : { state: 'completed', answer: 'Worker final answer' },
    },
    transport: (state, inbox, activity, abort) => {
      saved = inbox; f.useInbox(inbox); transport = whatsAppTransport(state, inbox, activity, abort, { testOrigin: f.graphOrigin, request: f.request }); return transport;
    },
  }); closes.push(() => worker.stop()); await worker.start();
  return { worker, inbox: () => saved!, submissions: () => submissions, signal: () => signal, transport: () => transport! };
}

describe('supervised WhatsApp transport', () => {
  it('keeps the product unavailable while setup and recovery controls are incomplete', async () => {
    const f = await fixture(); expect(platforms.gatewayPlatformAvailable('whatsapp')).toBe(false); await f.state.disconnect();
    const worker = new GatewayWorker(f.instance.id); closes.push(() => worker.stop()); await worker.start();
    expect(worker.health().status).toBe('needs-setup'); expect(f.calls).toEqual([]);
  });

  it('verifies Meta before relay I/O, then runs signed intake, private files, work and selected documents through the worker', async () => {
    const f = await fixture(); f.enqueue('wamid.request', true); const run = await supervised(f, { document: true });
    expect(run.worker.health().status).toBe('connected'); await expect.poll(() => run.inbox().list()[0].outgoing?.[0].status).toBe('sent');
    const event = run.inbox().list()[0]; expect(run.submissions()).toBe(1); expect(fs.readFileSync(event.files![0].file!.path, 'utf8')).toBe('hello');
    expect(f.calls.slice(0, 3)).toEqual([`/v25.0/${f.instance.accountId}`, `/v25.0/${BUSINESS}/phone_numbers`, '/v1/status']);
    expect(f.posts.map((post) => post.type)).toEqual(['text', 'document']); expect(f.uploads).toEqual(['Selected result']);
    expect(f.posts[0]).toMatchObject({ to: ACTOR, context: { message_id: 'wamid.request' }, text: { body: 'Worker final answer' } });
    await run.worker.stop(); expect(f.calls.at(-1)).toBe('/v1/release'); await f.state.connect();
    expect(new GatewayInbox(f.state).list()[0].reply!.parts[0].status).toBe('sent');
    const disk = fs.readFileSync(f.state.inboxFile(), 'utf8'); for (const secret of [TOKEN, SECRET, PULL, LEASE]) expect(disk).not.toContain(secret);
  });

  it.each(['before', 'after'] as const)('recovers a lost ACK %s remote commit without starting work early or duplicating a run', async (when) => {
    const f = await fixture(); f.enqueue('wamid.request'); f.loseAck(when); const first = await supervised(f);
    expect(first.worker.health().status).toBe('retrying'); expect(first.submissions()).toBe(0); expect(f.posts).toEqual([]);
    await first.worker.stop(); const second = await supervised(f); await expect.poll(() => second.inbox().list()[0].reply?.parts[0].status).toBe('sent');
    expect(second.submissions()).toBe(1); expect(second.inbox().list()).toHaveLength(1); await second.worker.stop();
    const third = await supervised(f); expect(third.submissions()).toBe(0); expect(f.posts).toHaveLength(1);
  });

  it('keeps two business phones independent even when they receive the same source message ID', async () => {
    const first = await fixture(); const second = await fixture(); first.enqueue('wamid.same'); second.enqueue('wamid.same');
    const one = await supervised(first); const two = await supervised(second);
    await expect.poll(() => one.inbox().list()[0].reply?.parts[0].status).toBe('sent');
    await expect.poll(() => two.inbox().list()[0].reply?.parts[0].status).toBe('sent');
    expect(one.submissions()).toBe(1); expect(two.submissions()).toBe(1); expect(first.posts).toHaveLength(1); expect(second.posts).toHaveLength(1);
    expect(one.inbox().list()[0].input.accountId).toBe(first.instance.accountId); expect(two.inbox().list()[0].input.accountId).toBe(second.instance.accountId);
    await one.worker.stop(); expect(two.worker.health().status).toBe('connected'); expect(two.transport().alive()).toBe(true);
  });

  it('requires saved pairing before contacting Meta or the relay', async () => {
    const f = await fixture(); const instance = saveGatewayInstance({ ...f.config, accountId: String(accounts++) });
    saveGatewayCredentials(instance.id, { accessToken: TOKEN, signingSecret: SECRET, relayKey: PULL });
    const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect());
    expect(() => whatsAppTransport(state, new GatewayInbox(state), () => {}, new AbortController().signal)).toThrow('pairing'); expect(f.calls).toEqual([]);
  });

  it.each(['accessToken', 'signingSecret', 'relayKey'] as const)('requires %s before either service is contacted', async (key) => {
    const f = await fixture(); const secrets = { ...getGatewaySecrets(f.instance.id) }; delete secrets[key]; saveGatewayCredentials(f.instance.id, secrets);
    expect(() => f.transport()).toThrow('before connecting'); expect(f.calls).toEqual([]);
  });

  it('does not claim or ACK the relay when Meta account verification fails', async () => {
    const f = await fixture(); f.enqueue('wamid.request'); f.denyMeta(); const run = await supervised(f);
    expect(run.worker.health().status).toBe('needs-setup'); expect(run.submissions()).toBe(0); expect(f.calls).not.toContain('/v1/status');
    expect(f.queue).toHaveLength(1); expect(JSON.stringify(run.worker.health())).not.toContain('PRIVATE_');
  });

  it('holds gaps durably and refuses reconnect before any network I/O', async () => {
    const f = await fixture(); f.enqueue('wamid.request'); const run = await supervised(f, { pending: true });
    await expect.poll(() => run.submissions()).toBe(1); f.metadata.gap = { at: Date.now(), through: 2 };
    await expect.poll(() => run.worker.health().status).toBe('needs-setup'); expect(run.signal()!.aborted).toBe(true);
    expect(run.worker.health().recoveryRequired).toBe(true); expect(f.posts).toEqual([]);
    const count = f.calls.length; await run.worker.start(); expect(f.calls).toHaveLength(count); expect(run.worker.health().recoveryRequired).toBe(true);
    await run.worker.stop(); await f.state.connect(); expect(new GatewayInbox(f.state).whatsAppRelayState()!.recovery!.reason).toBe('gap');
    expect(new GatewayInbox(f.state).list()[0].status).toBe('needs-review');
  });

  it.each([401, 429, 503])('publishes a safe HTTP %s outcome and honors the relay retry time', async (status) => {
    const f = await fixture(); f.setRelayStatus(status); const run = await supervised(f);
    expect(run.worker.health().status).toBe(status === 401 ? 'needs-setup' : 'retrying'); expect(JSON.stringify(run.worker.health())).not.toContain('PRIVATE_');
    if (status !== 401) expect(run.worker.health().retryAt! - Date.now()).toBeGreaterThan(55000);
    expect(f.calls.filter((call) => call === '/v1/status')).toHaveLength(1); expect(run.submissions()).toBe(0);
  });

  it('aborts the worker signal on a later relay failure before the monitor runs', async () => {
    const f = await fixture(); f.enqueue('wamid.request'); const run = await supervised(f, { pending: true, monitorMs: 60000 }); await expect.poll(() => run.submissions()).toBe(1);
    f.setRelayStatus(503); await expect.poll(() => run.signal()!.aborted).toBe(true);
    expect(run.transport().failure?.()).toMatchObject({ kind: 'retry' });
    await expect.poll(() => run.worker.health().status).toBe('retrying'); expect(f.posts).toEqual([]);
  });

  it('stops a stalled startup pull and releases state for another connection', async () => {
    const f = await fixture(); f.stall(); const abort = new AbortController(); const transport = f.transport(abort.signal);
    const start = transport.start(); const outcome = start.catch((error: unknown) => error);
    await expect.poll(() => f.calls.includes('/v1/status')).toBe(true); abort.abort(); await transport.stop();
    expect(await outcome).toMatchObject({ kind: 'retry' }); expect(transport.alive()).toBe(false); expect(f.posts).toEqual([]);
    await f.state.connect(); expect(f.inbox.list()).toEqual([]);
  });
});
