import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayWhatsAppRelayEnvelope, GatewayWhatsAppRelayStatus } from '../../shared/types.ts';
import { whatsAppRelayOrigin } from '../../shared/gateway-whatsapp-relay.ts';
import { GatewayInbox, gatewayWhatsAppRecovery } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { restoreWhatsAppRecovery } from '../../server/gateways/whatsapp-recovery.ts';
import { WhatsAppRelayConsumer, WhatsAppRelayError } from '../../server/gateways/whatsapp-relay.ts';
import { gatewayConfig } from './gateway-fixtures.ts';

const EPOCH = '00000000-0000-4000-8000-000000000001';
const INSTALLATION = '00000000-0000-4000-8000-000000000002';
const BUSINESS = '9000000001';
const ORIGIN = 'https://relay.example';
const TOKEN = 'a'.repeat(64);
const LEASE = 'b'.repeat(64);
const SECRET = 'fake-consumer-meta-app-secret';
const limits = {
  bodyBytes: 1048576,
  queueBytes: 16777216,
  queueEvents: 1000,
  replayEntries: 10000,
  retentionMs: 259200000,
  replayMs: 604800000,
  pairingMs: 600000,
  leaseMs: 60000,
  batchBytes: 2097152,
  batchEvents: 20,
};
const closers: (() => Promise<void>)[] = [];
let accounts = 9200000000;
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
type Request = (url: string, init: RequestInit) => Promise<Response>;
async function fixture() {
  const config = {
    ...gatewayConfig(String(accounts++)),
    name: 'WhatsApp consumer',
    platform: 'whatsapp',
    senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436641234567'] },
    scope: { directMessages: true, conversationIds: [], guildIds: [] },
  };
  const instance = saveGatewayInstance(config);
  const state = new GatewayStateAdapter(instance.id);
  await state.connect();
  closers.push(() => state.disconnect());
  const inbox = new GatewayInbox(state);
  const connection = {
    origin: ORIGIN,
    installationId: INSTALLATION,
    businessAccountId: BUSINESS,
    phoneNumberId: instance.accountId,
    epoch: EPOCH,
  };
  inbox.bindWhatsAppRelayConnection(connection, 0);
  const queue: GatewayWhatsAppRelayEnvelope[] = [];
  let cursor = 0;
  let lastId = '';
  let claimed = false;
  let delivered = 0;
  const calls: string[] = [];
  const acknowledgements: number[] = [];
  const metadata: Partial<GatewayWhatsAppRelayStatus> = {};
  function enqueue(id: string) {
    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: BUSINESS,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: instance.accountId },
                messages: [{ id, from: '436641234567', timestamp: '1700000000', type: 'text', text: { body: id } }],
              },
            },
          ],
        },
      ],
    });
    const bodyBase64 = Buffer.from(raw).toString('base64');
    const event = {
      sequence: cursor + queue.length + 1,
      id: crypto.createHash('sha256').update(bodyBase64).digest('hex'),
      receivedAt: Date.now(),
      expiresAt: Date.now() + 60000,
      bodyBase64,
      signature: 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'),
      contentType: 'application/json',
    };
    queue.push(event);
    return event;
  }
  const status = () => ({
    version: 1,
    installationId: INSTALLATION,
    businessAccountId: BUSINESS,
    phoneNumberId: instance.accountId,
    epoch: EPOCH,
    cursor,
    gap: null,
    limits,
    queuedEvents: queue.length,
    queuedBytes: 100 * queue.length,
    ...metadata,
  });
  const request: Request = async (url, init) => {
    const address = new URL(url);
    const headers = new Headers(init.headers);
    calls.push(address.pathname);
    expect(address.origin).toBe(ORIGIN);
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.has('origin')).toBe(false);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (address.pathname === '/v1/status') {
      expect(init.method).toBe('GET');
      return Response.json(status());
    }
    expect(body.epoch ?? address.searchParams.get('epoch')).toBe(EPOCH);
    if (address.pathname === '/v1/claim') {
      expect(body.consumerId).toMatch(/^[a-f0-9-]{36}$/);
      if (claimed) return Response.json({ error: 'already_claimed' }, { status: 409 });
      claimed = true;
      delivered = cursor;
      return Response.json({ epoch: EPOCH, cursor, lease: LEASE, expiresAt: Date.now() + 60000 });
    }
    expect(headers.get('x-relay-lease')).toBe(LEASE);
    if (!claimed) return Response.json({ error: 'lease_required' }, { status: 409 });
    if (address.pathname === '/v1/pull') {
      expect(Number(address.searchParams.get('after'))).toBe(cursor);
      expect(address.searchParams.get('limit')).toBe('20');
      const envelopes = queue.slice(0, 20);
      delivered = envelopes.at(-1)?.sequence ?? cursor;
      return Response.json({ ...status(), envelopes, leaseExpiresAt: Date.now() + 60000 });
    }
    if (address.pathname === '/v1/ack') {
      const receipt = inbox.whatsAppRelayState()!.receipt!;
      expect(receipt.confirmed).toBe(false);
      expect(receipt.id).toBe(body.eventId);
      expect(receipt.sequence).toBe(body.through);
      if (body.through === cursor && body.eventId === lastId) return Response.json({ cursor });
      const next = queue[0];
      if (!next || next.sequence !== body.through || next.id !== body.eventId || next.sequence > delivered)
        return Response.json({ error: 'ack_not_delivered' }, { status: 409 });
      expect(
        inbox
          .list()
          .filter((event) => event.relay?.sequence === receipt.sequence)
          .every((event) => !event.operationId && !event.relay!.confirmed),
      ).toBe(true);
      cursor = next.sequence;
      lastId = next.id;
      queue.shift();
      acknowledgements.push(cursor);
      return Response.json({ cursor });
    }
    if (address.pathname === '/v1/release') {
      claimed = false;
      return Response.json({ released: true });
    }
    throw new Error('Unexpected fixture request');
  };
  function consumer(send: Request = request, timeoutMs = 1000) {
    const value = new WhatsAppRelayConsumer({ inbox, token: TOKEN, appSecret: SECRET, request: send, timeoutMs });
    closers.push(() => value.stop());
    return value;
  }
  return {
    config,
    instance,
    state,
    inbox,
    connection,
    calls,
    queue,
    acknowledgements,
    metadata,
    enqueue,
    request,
    consumer,
    loseLease: () => {
      claimed = false;
    },
    setCursor: (value: number, id = '') => {
      cursor = value;
      lastId = id;
    },
  };
}

describe('authenticated WhatsApp relay consumption', () => {
  it('pins HTTPS origins and refuses credentials, paths, queries, fragments and redirects in setup', () => {
    expect(whatsAppRelayOrigin('https://relay.example/')).toBe(ORIGIN);
    for (const value of [
      'http://relay.example',
      'https://user:secret@relay.example',
      'https://relay.example/path',
      'https://relay.example?token=secret',
      'https://relay.example#fragment',
      'https://relay.example/?',
      'https://relay.example/#',
    ])
      expect(() => whatsAppRelayOrigin(value)).toThrow('HTTPS address');
  });

  it('consumes ordered batches, commits before every ACK and keeps credentials out of durable state', async () => {
    const f = await fixture();
    for (let i = 0; i < 23; i++) f.enqueue(`message-${i}`);
    const consumer = f.consumer();
    expect(await consumer.poll()).toBe(20);
    expect(await consumer.poll()).toBe(3);
    expect(await consumer.poll()).toBe(0);
    expect(f.inbox.whatsAppRelayState()!.cursor).toBe(23);
    expect(f.acknowledgements).toHaveLength(23);
    expect(f.inbox.list()).toHaveLength(23);
    expect(f.calls.filter((path) => path === '/v1/claim')).toHaveLength(1);
    const disk = fs.readFileSync(f.state.inboxFile(), 'utf8');
    for (const value of [TOKEN, LEASE, SECRET, 'bodyBase64', 'signature']) expect(disk).not.toContain(value);
    await consumer.stop();
    expect(f.calls.at(-1)).toBe('/v1/release');
  });

  it.each(['before', 'after'])(
    'recovers a lost ACK response %s remote commit, using the saved exact envelope',
    async (when) => {
      const f = await fixture();
      f.enqueue('message');
      const first = f.consumer(async (url, init) => {
        if (url.endsWith('/v1/ack')) {
          if (when === 'after') await f.request(url, init);
          throw new Error('PRIVATE_TOKEN in network error');
        }
        return f.request(url, init);
      });
      await expect(first.poll()).rejects.toMatchObject({ kind: 'retry' });
      expect(f.inbox.claimNext()).toBeNull();
      await first.stop();
      await f.state.disconnect();
      await f.state.connect();
      const second = f.consumer();
      expect(await second.poll()).toBe(when === 'before' ? 1 : 0);
      expect(f.inbox.list()).toHaveLength(1);
      expect(f.inbox.whatsAppRelayState()!.cursor).toBe(1);
      expect(f.acknowledgements).toEqual([1]);
      expect(f.inbox.claimNext()).not.toBeNull();
      expect(f.inbox.claimNext()).toBeNull();
    },
  );

  it.each(['installationId', 'businessAccountId', 'phoneNumberId', 'epoch', 'cursor'])(
    'holds work and a durable review marker for changed %s',
    async (field) => {
      const f = await fixture();
      f.enqueue('first');
      const consumer = f.consumer();
      await consumer.poll();
      Object.assign(f.metadata, {
        [field]: field === 'cursor' ? 8 : field === 'epoch' || field === 'installationId' ? crypto.randomUUID() : '999',
      });
      await expect(consumer.poll()).rejects.toMatchObject({ kind: 'review' });
      expect(f.inbox.list()[0].status).toBe('needs-review');
      expect(f.inbox.claimNext()).toBeNull();
      await consumer.stop();
      const count = f.calls.length;
      expect(() => f.consumer()).toThrow('recovery');
      expect(f.calls).toHaveLength(count);
      expect(() => f.inbox.bindWhatsAppRelayConnection(f.connection, 1)).toThrow('recovery');
    },
  );

  it.each(['before', 'after'])(
    'requires the exact ACK after restoring an installation with a lost reply %s remote commit',
    async (when) => {
      const f = await fixture();
      f.enqueue('held-before-restoration');
      saveGatewayCredentials(f.instance.id, { relayKey: TOKEN, signingSecret: SECRET });
      const first = f.consumer(async (url, init) => {
        if (url.endsWith('/v1/ack')) {
          if (when === 'after') await f.request(url, init);
          throw new Error('Lost ACK reply');
        }
        return f.request(url, init);
      });
      await expect(first.poll()).rejects.toMatchObject({ kind: 'retry' });
      await first.stop();
      f.metadata.installationId = crypto.randomUUID();
      const changed = f.consumer();
      await expect(changed.poll()).rejects.toMatchObject({ kind: 'review', recovery: 'installation' });
      await changed.stop();
      saveGatewayInstance({ ...f.config, enabled: false }, f.instance.id);
      delete f.metadata.installationId;
      const calls = f.calls.length;
      const revision = gatewayWhatsAppRecovery(f.instance.id).restoration!.revision;
      await restoreWhatsAppRecovery(f.inbox, { revision, acknowledgeRestore: true }, { request: f.request });
      expect(f.calls.slice(calls)).toEqual(['/v1/status']);
      expect(f.inbox.whatsAppRelayState()!.receipt!.confirmed).toBe(false);
      expect(f.inbox.whatsAppRelayState()!.cursor).toBe(0);
      expect(f.inbox.list()[0].status).toBe('needs-review');
      await f.state.disconnect();
      await f.state.connect();
      saveGatewayInstance(f.config, f.instance.id);
      const resumed = f.consumer();
      await resumed.poll();
      expect(f.acknowledgements).toEqual([1]);
      expect(f.inbox.whatsAppRelayState()!.receipt!.confirmed).toBe(true);
      expect(f.inbox.list()).toHaveLength(1);
      expect(f.inbox.claimNext()).toBeNull();
      expect(f.inbox.list()[0].operationId).toBeUndefined();
    },
  );

  it('still refuses the same invalid signed envelope after a connection-hold restoration', async () => {
    const f = await fixture();
    f.enqueue('invalid').signature = 'sha256=' + '0'.repeat(64);
    saveGatewayCredentials(f.instance.id, { relayKey: TOKEN, signingSecret: SECRET });
    const first = f.consumer();
    await expect(first.poll()).rejects.toMatchObject({ kind: 'review', recovery: 'envelope' });
    await first.stop();
    saveGatewayInstance({ ...f.config, enabled: false }, f.instance.id);
    const revision = gatewayWhatsAppRecovery(f.instance.id).restoration!.revision;
    await restoreWhatsAppRecovery(f.inbox, { revision, acknowledgeRestore: true }, { request: f.request });
    saveGatewayInstance(f.config, f.instance.id);
    const resumed = f.consumer();
    await expect(resumed.poll()).rejects.toMatchObject({ kind: 'review', recovery: 'envelope' });
    expect(f.inbox.list()).toEqual([]);
    expect(f.acknowledgements).toEqual([]);
    expect(f.inbox.whatsAppRelayState()!.recovery!.reason).toBe('envelope');
  });

  it('never changes the paired origin or account based on status metadata', async () => {
    const f = await fixture();
    expect(() => f.inbox.bindWhatsAppRelayConnection({ ...f.connection, origin: 'https://other.example' }, 0)).toThrow(
      'pairing changed',
    );
    expect(() => f.inbox.bindWhatsAppRelayConnection({ ...f.connection, phoneNumberId: '999' }, 0)).toThrow(
      'paired WhatsApp phone',
    );
    expect(f.calls).toEqual([]);
  });

  it.each(['status', 'pull'])('holds accepted work when retention expires during %s', async (stage) => {
    const f = await fixture();
    f.enqueue('first');
    const first = f.consumer();
    await first.poll();
    await first.stop();
    if (stage === 'status') f.metadata.gap = { at: Date.now(), through: 2 };
    const second = f.consumer(async (url, init) =>
      url.includes('/v1/pull') ? Response.json({ error: 'retention_gap' }, { status: 410 }) : f.request(url, init),
    );
    await expect(second.poll()).rejects.toMatchObject({ kind: 'review', recovery: 'gap' });
    expect(f.inbox.whatsAppRelayState()!.recovery!.reason).toBe('gap');
    expect(f.inbox.whatsAppRelayState()!.cursor).toBe(1);
    expect(() => f.inbox.checkAccess(f.inbox.list()[0])).toThrow('recovery');
    expect(f.inbox.list()[0].status).toBe('needs-review');
  });

  it('refuses a pending ACK with the wrong remote envelope ID even when the cursor matches', async () => {
    const f = await fixture();
    f.enqueue('first');
    const first = f.consumer(async (url, init) => {
      const response = await f.request(url, init);
      if (url.endsWith('/v1/ack')) throw new Error('Lost response');
      return response;
    });
    await expect(first.poll()).rejects.toMatchObject({ kind: 'retry' });
    await first.stop();
    f.setCursor(1, '0'.repeat(64));
    await expect(f.consumer().poll()).rejects.toMatchObject({ kind: 'review' });
    expect(f.inbox.whatsAppRelayState()!.receipt!.confirmed).toBe(false);
    expect(f.inbox.claimNext()).toBeNull();
  });

  it('requires a protocol HTTP 200 rather than an asynchronously accepted ACK', async () => {
    const f = await fixture();
    f.enqueue('first');
    const consumer = f.consumer(async (url, init) =>
      url.endsWith('/v1/ack') ? Response.json({ cursor: 1 }, { status: 202 }) : f.request(url, init),
    );
    await expect(consumer.poll()).rejects.toMatchObject({ kind: 'review' });
    expect(f.inbox.whatsAppRelayState()!.receipt!.confirmed).toBe(false);
    expect(f.inbox.whatsAppRelayState()!.cursor).toBe(0);
    expect(f.acknowledgements).toEqual([]);
    expect(f.inbox.claimNext()).toBeNull();
  });

  it('refuses a different pending body before ACK', async () => {
    const f = await fixture();
    f.enqueue('first');
    const first = f.consumer(async (url, init) => {
      if (url.endsWith('/v1/ack')) throw new Error('No remote ACK');
      return f.request(url, init);
    });
    await expect(first.poll()).rejects.toMatchObject({ kind: 'retry' });
    await first.stop();
    f.queue[0].id = '0'.repeat(64);
    await expect(f.consumer().poll()).rejects.toMatchObject({ kind: 'review' });
    expect(f.acknowledgements).toEqual([]);
  });

  it.each(['sequence', 'duplicate', 'signature'])(
    'refuses a bad %s in the pulled batch before releasing work',
    async (kind) => {
      const f = await fixture();
      f.enqueue('first');
      f.enqueue('second');
      if (kind === 'sequence') f.queue[1].sequence = 3;
      if (kind === 'duplicate') f.queue[1].id = f.queue[0].id;
      if (kind === 'signature') f.queue[0].signature = 'sha256=' + '0'.repeat(64);
      await expect(f.consumer().poll()).rejects.toMatchObject({ kind: 'review' });
      expect(f.acknowledgements).toEqual([]);
      expect(f.inbox.list()).toEqual([]);
      expect(f.inbox.whatsAppRelayState()!.recovery).toBeDefined();
    },
  );

  it('never sends an ACK after a local receipt write fails', async () => {
    const f = await fixture();
    f.enqueue('first');
    const consumer = f.consumer();
    const write = fs.writeFileSync.bind(fs);
    const fail = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).includes('inbox.json')) throw new Error('PRIVATE_DISK_PATH');
      return write(file, ...args);
    });
    await expect(consumer.poll()).rejects.toMatchObject({ kind: 'retry' });
    fail.mockRestore();
    expect(f.calls).not.toContain('/v1/ack');
    expect(f.inbox.list()).toEqual([]);
    expect(await consumer.poll()).toBe(1);
    expect(f.acknowledgements).toEqual([1]);
  });

  it('handles competing and expired leases without guessing ownership or retrying requests silently', async () => {
    const f = await fixture();
    f.enqueue('first');
    const first = f.consumer();
    await first.poll();
    const competitor = f.consumer();
    await expect(competitor.poll()).rejects.toMatchObject({ kind: 'retry' });
    f.loseLease();
    await expect(first.poll()).rejects.toMatchObject({ kind: 'retry' });
    expect(await first.poll()).toBe(0);
    expect(f.calls.filter((path) => path === '/v1/claim')).toHaveLength(2);
  });

  it('waits after a remote lease conflict, including a claim response lost by an earlier process', async () => {
    const f = await fixture();
    await f.request(`${ORIGIN}/v1/claim`, {
      method: 'POST',
      body: JSON.stringify({ epoch: EPOCH, consumerId: crypto.randomUUID() }),
      headers: { authorization: `Bearer ${TOKEN}` },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    const consumer = f.consumer();
    await expect(consumer.poll()).rejects.toMatchObject({ kind: 'retry' });
    expect(consumer.failure()!.retryAt! - Date.now()).toBeGreaterThan(55000);
    expect(f.calls).not.toContain('/v1/pull');
    f.loseLease();
    expect(await consumer.poll()).toBe(0);
  });

  it.each([401, 403, 429, 503])('classifies HTTP %s without exposing private response details', async (status) => {
    const f = await fixture();
    const consumer = f.consumer(async () =>
      Response.json({ error: 'PRIVATE_RESPONSE_TOKEN' }, { status, headers: { 'retry-after': '12' } }),
    );
    let caught: unknown;
    try {
      await consumer.poll();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WhatsAppRelayError);
    expect(caught).toMatchObject({ kind: status < 429 ? 'setup' : 'retry' });
    expect(String(caught)).not.toContain('PRIVATE_RESPONSE_TOKEN');
    expect(f.inbox.whatsAppRelayState()!.cursor).toBe(0);
    if (caught instanceof WhatsAppRelayError && status >= 429)
      expect(caught.retryAt! - Date.now()).toBeGreaterThan(10000);
  });

  it('treats an HTML proxy outage as a retry and discards its private body', async () => {
    const f = await fixture();
    const consumer = f.consumer(
      async () =>
        new Response('<html>PRIVATE_PROXY_ERROR</html>', { status: 503, headers: { 'content-type': 'text/html' } }),
    );
    await expect(consumer.poll()).rejects.toMatchObject({ kind: 'retry' });
    expect(f.inbox.whatsAppRelayState()!.recovery).toBeUndefined();
    expect(String(consumer.failure())).not.toContain('PRIVATE_PROXY_ERROR');
  });

  it.each(['json', 'length', 'bytes', 'utf8', 'redirect'])(
    'rejects malformed %s responses with bounded reads and safe errors',
    async (kind) => {
      const f = await fixture();
      const consumer = f.consumer(async () => {
        if (kind === 'redirect') return Response.redirect('https://other.example/PRIVATE_KEY', 302);
        const body =
          kind === 'utf8' ? Buffer.from([0xff]) : kind === 'bytes' ? 'x'.repeat(65537) : 'PRIVATE_RESPONSE_TOKEN';
        return new Response(body, {
          headers: { 'content-type': 'application/json', ...(kind === 'length' ? { 'content-length': '65537' } : {}) },
        });
      });
      await expect(consumer.poll()).rejects.toMatchObject({ kind: 'review' });
      expect(String(consumer.failure())).not.toContain('PRIVATE_');
      expect(f.inbox.list()).toEqual([]);
    },
  );

  it('times out stalled requests and drains stop without sending an ACK or retaining local ownership', async () => {
    const f = await fixture();
    const first = f.consumer(async () => new Promise<Response>(() => {}), 10);
    await expect(first.poll()).rejects.toMatchObject({ kind: 'retry' });
    await first.stop();
    const second = f.consumer(async () => new Promise<Response>(() => {}));
    const pending = second.poll();
    await second.stop();
    await expect(pending).rejects.toMatchObject({ kind: 'retry' });
    expect(await f.consumer().poll()).toBe(0);
    expect(f.acknowledgements).toEqual([]);
  });

  it('cancels a stalled response body within the request deadline', async () => {
    const f = await fixture();
    let cancelled = false;
    const consumer = f.consumer(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      10,
    );
    await expect(consumer.poll()).rejects.toMatchObject({ kind: 'retry' });
    expect(cancelled).toBe(true);
  });

  it('stops an in-flight ACK safely and lets the next consumer confirm the same remote receipt', async () => {
    const f = await fixture();
    f.enqueue('first');
    const first = f.consumer(async (url, init) => {
      const response = await f.request(url, init);
      return url.endsWith('/v1/ack') ? new Promise<Response>(() => {}) : response;
    });
    const pending = first.poll();
    await expect.poll(() => f.acknowledgements.length).toBe(1);
    await first.stop();
    await expect(pending).rejects.toMatchObject({ kind: 'retry' });
    expect(f.inbox.whatsAppRelayState()!.receipt!.confirmed).toBe(false);
    expect(f.inbox.claimNext()).toBeNull();
    expect(await f.consumer().poll()).toBe(0);
    expect(f.inbox.list()).toHaveLength(1);
    expect(f.inbox.whatsAppRelayState()!.receipt!.confirmed).toBe(true);
  });

  it('polls automatically after start and stops future timers before releasing its lease', async () => {
    const f = await fixture();
    vi.useFakeTimers();
    f.enqueue('first');
    const consumer = f.consumer();
    await consumer.start();
    expect(consumer.alive()).toBe(true);
    f.enqueue('second');
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.acknowledgements).toEqual([1, 2]);
    await consumer.stop();
    const count = f.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.calls).toHaveLength(count);
    expect(consumer.alive()).toBe(false);
  });
});
