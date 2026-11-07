import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dataPath } from '../../server/util.ts';
import type { GatewayWhatsAppRelayEnvelope, GatewayWhatsAppRelayStatus } from '../../shared/types.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { WhatsAppRelayConsumer } from '../../server/gateways/whatsapp-relay.ts';
import { inspectWhatsAppRecovery, reviewWhatsAppRecovery } from '../../server/gateways/whatsapp-recovery.ts';
import { gatewayConfig } from './gateway-fixtures.ts';

const exec = promisify(execFile); const opened: Miniflare[] = [];
const BUSINESS = '100000000000001'; const PHONE = '200000000000001'; const SECRET = 'PRIVATE_META_APPLICATION_SECRET'; const ADMIN = 'PRIVATE_ADMIN_KEY_' + 'a'.repeat(40);
const root = dataPath('whatsapp-relay-tests'); const wrapper = path.join(root, 'test.mjs'); let fixtures = 0;
beforeAll(async () => {
  fs.mkdirSync(root, { recursive: true });
  await exec('bun', ['scripts/build-whatsapp-relay.ts', '--outfile', path.join(root, 'worker.mjs')], { timeout: 20000 });
  // SQL controls exist only in this private test entrypoint, never the deployed Worker or public router.
  fs.writeFileSync(wrapper, `import worker, { WhatsAppRelayQueue } from './worker.mjs';
    export class TestQueue extends WhatsAppRelayQueue {
      constructor(ctx, env) { super(ctx, env); this.testStorage = ctx.storage; }
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/__test/expire-replay') { this.testStorage.sql.exec('UPDATE replay SET expires_at = 0'); return Response.json({ ok: true }); }
        if (path === '/__test/expire-and-alarm') { this.testStorage.sql.exec('UPDATE envelopes SET expires_at = 0'); await this.testStorage.setAlarm(Date.now() + 10); return Response.json({ ok: true }); }
        if (path === '/__test/expire-last') { this.testStorage.sql.exec('UPDATE envelopes SET expires_at = 0 WHERE sequence = (SELECT MAX(sequence) FROM envelopes)'); return Response.json({ ok: true }); }
        if (path === '/__test/expire') { this.testStorage.sql.exec('UPDATE envelopes SET expires_at = 0'); return Response.json({ ok: true }); }
        if (path === '/__test/expire-lease' || path === '/__test/expire-pair') {
          const meta = JSON.parse(this.testStorage.sql.exec('SELECT data FROM metadata WHERE id=1').one().data);
          if (path.endsWith('lease')) meta.leaseExpiresAt = 0; else meta.pairingExpiresAt = 0;
          this.testStorage.sql.exec('UPDATE metadata SET data=? WHERE id=1', JSON.stringify(meta)); return Response.json({ ok: true });
        }
        if (path === '/__test/fail-write') { this.testStorage.sql.exec("CREATE TRIGGER fail_ingest BEFORE INSERT ON replay BEGIN SELECT RAISE(ABORT, 'PRIVATE_DISK_FAILURE'); END"); return Response.json({ ok: true }); }
        if (path === '/__test/repair') { this.testStorage.sql.exec('DROP TRIGGER fail_ingest'); return Response.json({ ok: true }); }
        if (path === '/__test/inspect') return Response.json({ meta: JSON.parse(this.testStorage.sql.exec('SELECT data FROM metadata WHERE id=1').one().data), envelopes: this.testStorage.sql.exec('SELECT * FROM envelopes').toArray(), replay: this.testStorage.sql.exec('SELECT * FROM replay').toArray() });
        return super.fetch(request);
      }
    }
    export default worker;`);
});
afterEach(async () => { await Promise.all(opened.splice(0).map((mf) => mf.dispose())); });
function payload(text = 'Hello', phone = PHONE, business = BUSINESS) {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: business, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: phone },
    contacts: [{ wa_id: '436641234567', profile: { name: 'Untrusted label' } }], messages: [{ from: '436641234567', id: `wamid.${text}`, timestamp: '1800000000', type: 'text', text: { body: text } }] } }] }] });
}
function signature(body: string) { return `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`; }
async function fixture(changes: Record<string, string> = {}, directory = path.join(root, String(++fixtures))) {
  const mf = new Miniflare({ modules: true, modulesRoot: root, rootPath: root, scriptPath: wrapper, durableObjects: { QUEUE: { className: 'TestQueue', useSQLite: true } }, durableObjectsPersist: directory,
    compatibilityDate: '2026-07-30', log: new Log(LogLevel.NONE), bindings: { BUSINESS_ACCOUNT_ID: BUSINESS, PHONE_NUMBER_ID: PHONE, META_APP_SECRET: SECRET,
      META_VERIFY_TOKEN: 'PRIVATE_VERIFICATION_TOKEN', RELAY_ADMIN_KEY: ADMIN, ...changes } }); opened.push(mf);
  await mf.ready;
  const request = (route: string, options: { method?: string; body?: unknown; token?: string; lease?: string; raw?: string; headers?: Record<string, string> } = {}) => mf.dispatchFetch(`https://relay.test${route}`, {
    method: options.method ?? (options.body !== undefined || options.raw !== undefined ? 'POST' : 'GET'),
    headers: { ...(options.body !== undefined || options.raw !== undefined ? { 'content-type': 'application/json' } : {}), ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.lease ? { 'x-relay-lease': options.lease } : {}), ...options.headers },
    body: options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
  });
  const admin = (route: string, body: unknown = {}) => request(`/admin/${route}`, { token: ADMIN, body });
  const webhook = (body = payload(), headers: Record<string, string> = {}) => request('/webhooks/meta', { raw: body, headers: { 'x-hub-signature-256': signature(body), ...headers } });
  const control = async (route: string) => { const ns = await mf.getDurableObjectNamespace('QUEUE'); return ns.getByName('whatsapp-v1').fetch(`https://relay.test/__test/${route}`); };
  const pair = async () => {
    const codeResponse = await admin('pairing'); expect(codeResponse.status).toBe(200); const { code } = await codeResponse.json() as { code: string };
    const response = await request('/v1/pair', { body: { code } }); expect(response.status).toBe(200);
    const paired = await response.json() as GatewayWhatsAppRelayStatus & { token: string };
    const consumerId = crypto.randomUUID(); const claimed = await request('/v1/claim', { token: paired.token, body: { epoch: paired.epoch, consumerId } }); expect(claimed.status).toBe(200);
    const lease = (await claimed.json() as { lease: string }).lease;
    return { ...paired, lease, code, consumerId };
  };
  const pull = (paired: Awaited<ReturnType<typeof pair>>, cursor = paired.cursor) => request(`/v1/pull?epoch=${paired.epoch}&after=${cursor}`, { token: paired.token, lease: paired.lease });
  const ack = (paired: Awaited<ReturnType<typeof pair>>, event: GatewayWhatsAppRelayEnvelope) => request('/v1/ack', { token: paired.token, lease: paired.lease, body: { epoch: paired.epoch, through: event.sequence, eventId: event.id } });
  return { mf, close: async () => { const at = opened.indexOf(mf); if (at >= 0) opened.splice(at, 1); await mf.dispose(); }, request, admin, webhook, control, pair, pull, ack, directory };
}

describe('hosted WhatsApp relay', () => {
  it('reviews a real retained gap locally after remote administration without promoting a lost ACK or restarting saved work', async () => {
    const f = await fixture(); const paired = await f.pair();
    expect((await f.request('/v1/release', { token: paired.token, lease: paired.lease, body: { epoch: paired.epoch } })).status).toBe(200);
    const config = { ...gatewayConfig(PHONE), platform: 'whatsapp', senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436641234567'] }, scope: { directMessages: true, conversationIds: [], guildIds: [] } };
    const instance = saveGatewayInstance(config); saveGatewayCredentials(instance.id, { relayKey: paired.token, signingSecret: SECRET });
    const state = new GatewayStateAdapter(instance.id); await state.connect(); const inbox = new GatewayInbox(state); let consumer: WhatsAppRelayConsumer | undefined; let loseAck = false;
    const request = async (url: string, init: RequestInit): Promise<Response> => {
      expect(new URL(url).origin).toBe('https://relay.test');
      const result = await f.mf.dispatchFetch(url, { method: init.method, body: typeof init.body === 'string' ? init.body : undefined, headers: Object.fromEntries(new Headers(init.headers)), signal: init.signal });
      if (loseAck && url.endsWith('/v1/ack')) throw new Error('Lost response after remote ACK commit');
      return new Response(await result.arrayBuffer(), { status: result.status, headers: Object.fromEntries(result.headers) });
    };
    const send = (text: string) => f.webhook(payload(text).replaceAll('1800000000', String(Math.floor(Date.now() / 1000))));
    try {
      inbox.bindWhatsAppRelayConnection({ origin: 'https://relay.test', installationId: paired.installationId, businessAccountId: BUSINESS, phoneNumberId: PHONE, epoch: paired.epoch }, 0);
      consumer = new WhatsAppRelayConsumer({ inbox, token: paired.token, appSecret: SECRET, request });
      expect((await send('saved')).status).toBe(200); expect(await consumer.poll()).toBe(1);
      loseAck = true; expect((await send('pending')).status).toBe(200); await expect(consumer.poll()).rejects.toThrow('could not connect'); await consumer.stop();
      expect((await send('lost')).status).toBe(200); await f.control('expire'); saveGatewayInstance({ ...config, enabled: false }, instance.id);
      const preview = await inspectWhatsAppRecovery(inbox, { request }); expect(preview.reason).toBe('gap'); expect(inbox.list()).toHaveLength(2);
      expect((await f.admin('recovery', { epoch: paired.epoch, through: 3, acknowledgeGap: true })).status).toBe(200);
      expect(await reviewWhatsAppRecovery(inbox, { revision: preview.gap!.revision, acknowledgeGap: true }, { request })).toEqual({ reason: null, gap: null });
      expect(inbox.whatsAppRelayState()!.cursor).toBe(3); expect(inbox.list().every((event) => event.status === 'needs-review' && !event.operationId)).toBe(true); expect(inbox.list()[1].relay!.confirmed).toBe(false);
      await state.disconnect(); await state.connect(); loseAck = false; saveGatewayInstance(config, instance.id);
      consumer = new WhatsAppRelayConsumer({ inbox, token: paired.token, appSecret: SECRET, request });
      expect((await send('fresh')).status).toBe(200); expect(await consumer.poll()).toBe(1);
      expect(inbox.list()[2]).toMatchObject({ status: 'queued', relay: { sequence: 4, confirmed: true } }); expect(inbox.claimNext()).toBeNull();
      expect(inbox.list()[1].relay!.confirmed).toBe(false);
    } finally { await consumer?.stop(); await state.disconnect(); }
  });
  it('retains signed user ID rotations only for the configured business phone', async () => {
    const f = await fixture(); const paired = await f.pair();
    const rotation = (phone = PHONE) => JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: BUSINESS, changes: [{ field: 'user_id_update', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, user_id_update: [{ timestamp: '1700000010', user_id: { previous: 'US.OLD', current: 'US.NEW' } }],
    } }] }] });
    expect((await f.webhook(rotation())).status).toBe(200);
    expect((await f.webhook(rotation('999'))).status).toBe(503);
    expect((await f.webhook(rotation(), { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) })).status).toBe(401);
    const response = await f.pull(paired); const { envelopes } = await response.json() as { envelopes: GatewayWhatsAppRelayEnvelope[] };
    expect(envelopes).toHaveLength(1); expect(Buffer.from(envelopes[0].bodyBase64, 'base64').toString()).toBe(rotation());
  });
  it('verifies the Meta challenge without exposing the verification token', async () => {
    const f = await fixture(); const response = await f.request('/webhooks/meta?hub.mode=subscribe&hub.verify_token=PRIVATE_VERIFICATION_TOKEN&hub.challenge=12345');
    expect(response.status).toBe(200); expect(await response.text()).toBe('12345'); expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await f.request('/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345')).status).toBe(403);
  });
  it('pairs once, verifies exact signed bytes, stores before acknowledgement and erases acknowledged bodies', async () => {
    const f = await fixture(); const paired = await f.pair(); const raw = payload('Signed 😊 body');
    expect((await f.webhook(raw)).status).toBe(200); const first = await f.pull(paired); expect(first.status).toBe(200);
    const received = await first.json() as GatewayWhatsAppRelayStatus & { envelopes: GatewayWhatsAppRelayEnvelope[] };
    expect(received.envelopes).toHaveLength(1); expect(Buffer.from(received.envelopes[0].bodyBase64, 'base64').toString()).toBe(raw); expect(received.envelopes[0].signature).toBe(signature(raw));
    expect((await f.ack(paired, received.envelopes[0])).status).toBe(200); expect((await f.ack(paired, received.envelopes[0])).status).toBe(200);
    const inspect = await (await f.control('inspect')).json() as { envelopes: unknown[]; replay: unknown[]; meta: Record<string, unknown> }; expect(inspect.envelopes).toHaveLength(0); expect(inspect.replay).toHaveLength(1);
    expect(JSON.stringify(inspect)).not.toContain(raw); for (const value of [paired.token, paired.code, paired.lease]) expect(JSON.stringify(inspect)).not.toContain(value);
    expect((await f.webhook(raw)).status).toBe(200); expect((await (await f.pull(paired, 1)).json() as { envelopes: unknown[] }).envelopes).toHaveLength(0);
    expect((await f.request('/v1/pair', { body: { code: paired.code } })).status).toBe(403);
  });
  it.each(['missing', 'wrong', 'changed-body'])('refuses %s signatures without storing the webhook', async (kind) => {
    const f = await fixture(); const paired = await f.pair();
    const response = await f.webhook(payload('changed'), { 'x-hub-signature-256': kind === 'missing' ? '' : kind === 'wrong' ? 'sha256=' + '0'.repeat(64) : signature(payload('original')) });
    expect(response.status).toBe(401); expect((await (await f.pull(paired)).json() as { envelopes: unknown[] }).envelopes).toHaveLength(0);
  });

  it('preserves original whitespace, Unicode bytes and the signature/content-type headers', async () => {
    const f = await fixture(); const paired = await f.pair(); const raw = '  ' + payload('😊 quoted "text"').replace(/,/g, ',\n') + '\n';
    expect((await f.webhook(raw, { 'content-type': 'application/json; charset=utf-8' })).status).toBe(200);
    const envelope = (await (await f.pull(paired)).json() as { envelopes: GatewayWhatsAppRelayEnvelope[] }).envelopes[0];
    expect(Buffer.from(envelope.bodyBase64, 'base64').toString()).toBe(raw); expect(envelope.signature).toBe(signature(raw)); expect(envelope.contentType).toBe('application/json; charset=utf-8');
  });

  it.each(['phone', 'business', 'mixed'])('refuses a signed foreign %s payload instead of leaking another account into this queue', async (kind) => {
    const f = await fixture(); const paired = await f.pair(); let raw = payload('foreign', kind === 'phone' ? '999' : PHONE, kind === 'business' ? '999' : BUSINESS);
    if (kind === 'mixed') { const value = JSON.parse(raw) as { entry: unknown[] }; value.entry.push((JSON.parse(payload('other', '999')) as { entry: unknown[] }).entry[0]); raw = JSON.stringify(value); }
    expect((await f.webhook(raw)).status).toBe(503); expect((await (await f.pull(paired)).json() as { envelopes: unknown[] }).envelopes).toHaveLength(0);
  });

  it('isolates pairings and admin authority across relay deployments', async () => {
    const first = await fixture(); const second = await fixture(); const a = await first.pair(); const b = await second.pair();
    expect((await second.request('/v1/status', { token: a.token })).status).toBe(401); expect((await first.request('/admin/revoke', { token: a.token, body: { acknowledgeDrop: true } })).status).toBe(401);
    expect((await first.request('/v1/status', { token: b.token })).status).toBe(401);
  });

  it('bounds queues, still acknowledges duplicates when full, and accepts a new body only after space is freed', async () => {
    const f = await fixture({ MAX_EVENTS: '2' }); const paired = await f.pair();
    expect((await f.webhook(payload('one'))).status).toBe(200); expect((await f.webhook(payload('two'))).status).toBe(200);
    expect((await f.webhook(payload('three'))).status).toBe(503); expect((await f.webhook(payload('one'))).status).toBe(200);
    const rows = (await (await f.pull(paired)).json() as { envelopes: GatewayWhatsAppRelayEnvelope[] }).envelopes; expect(rows.map((item) => item.sequence)).toEqual([1, 2]);
    expect((await f.ack(paired, rows[1])).status).toBe(200); expect((await f.webhook(payload('three'))).status).toBe(200);
    expect((await (await f.pull(paired, 2)).json() as { envelopes: GatewayWhatsAppRelayEnvelope[] }).envelopes.map((item) => item.sequence)).toEqual([3]);
  });

  it('bounds raw webhook bytes and replay markers even after raw bodies were acknowledged', async () => {
    const f = await fixture({ MAX_BYTES: '1024', MAX_REPLAY_IDS: '1' }); const paired = await f.pair();
    expect((await f.webhook(payload('x'.repeat(2000)))).status).toBe(503); expect((await f.webhook(payload('one'))).status).toBe(200);
    const row = (await (await f.pull(paired)).json() as { envelopes: GatewayWhatsAppRelayEnvelope[] }).envelopes[0]; await f.ack(paired, row);
    expect((await f.webhook(payload('two'))).status).toBe(503); await f.control('expire-replay'); expect((await f.webhook(payload('two'))).status).toBe(200);
    expect((await f.webhook(payload('x'.repeat(1024 * 1024)))).status).toBe(413);
  });

  it('never acknowledges a failed SQL commit and can accept the exact retry after repair', async () => {
    const f = await fixture(); const paired = await f.pair(); await f.control('fail-write');
    const failure = await f.webhook(); expect(failure.status).toBe(503); expect(await failure.text()).not.toContain('PRIVATE_DISK_FAILURE');
    const inspect = await (await f.control('inspect')).json() as { envelopes: unknown[]; replay: unknown[]; meta: { nextSequence: number } };
    expect(inspect.envelopes).toHaveLength(0); expect(inspect.replay).toHaveLength(0); expect(inspect.meta.nextSequence).toBe(1);
    await f.control('repair'); expect((await f.webhook()).status).toBe(200); expect((await (await f.pull(paired)).json() as { envelopes: GatewayWhatsAppRelayEnvelope[] }).envelopes[0].sequence).toBe(1);
  });

  it('allows one pull consumer, renews its lease and refuses stale leases or undelivered acknowledgements', async () => {
    const f = await fixture(); const paired = await f.pair(); await f.webhook();
    expect((await f.request('/v1/claim', { token: paired.token, body: { epoch: paired.epoch, consumerId: paired.consumerId } })).status).toBe(409);
    const ack = { epoch: paired.epoch, through: 1, eventId: 'a'.repeat(64) };
    expect((await f.request('/v1/ack', { token: paired.token, lease: paired.lease, body: ack })).status).toBe(409);
    expect((await f.pull(paired, 1)).status).toBe(409);
    const row = (await (await f.pull(paired)).json() as { envelopes: GatewayWhatsAppRelayEnvelope[] }).envelopes[0];
    expect((await f.request('/v1/ack', { token: paired.token, lease: paired.lease, body: { ...ack, through: 2 } })).status).toBe(409);
    await f.control('expire-lease'); expect((await f.ack(paired, row)).status).toBe(409);
    const claim = await f.request('/v1/claim', { token: paired.token, body: { epoch: paired.epoch, consumerId: crypto.randomUUID() } }); expect(claim.status).toBe(200);
    const lease = (await claim.json() as { lease: string }).lease; expect(lease).not.toBe(paired.lease); expect((await f.pull(paired)).status).toBe(409);
    expect((await f.ack({ ...paired, lease }, row)).status).toBe(409);
    expect((await f.pull({ ...paired, lease })).status).toBe(200); expect((await f.ack({ ...paired, lease }, row)).status).toBe(200);
  });

  it('reports retention gaps and requires the current explicit administrative review before another consumer can proceed', async () => {
    const f = await fixture(); const paired = await f.pair(); await f.webhook(); await f.control('expire');
    expect((await f.pull(paired)).status).toBe(410); const status = await (await f.request('/v1/status', { token: paired.token })).json() as GatewayWhatsAppRelayStatus;
    expect(status.gap).toMatchObject({ through: 1 }); expect(status.queuedEvents).toBe(0);
    expect((await f.admin('recovery', { epoch: paired.epoch, through: 2, acknowledgeGap: true })).status).toBe(409);
    expect((await f.admin('recovery', { epoch: paired.epoch, through: 1 })).status).toBe(400);
    expect((await f.admin('recovery', { epoch: paired.epoch, through: 1, acknowledgeGap: true })).status).toBe(200);
    expect((await f.admin('recovery', { epoch: paired.epoch, through: 1, acknowledgeGap: true })).status).toBe(409);
    const claim = await f.request('/v1/claim', { token: paired.token, body: { epoch: paired.epoch, consumerId: paired.consumerId } }); expect(claim.status).toBe(200);
    const lease = (await claim.json() as { lease: string }).lease; expect((await (await f.pull({ ...paired, lease }, 1)).json() as { envelopes: unknown[] }).envelopes).toHaveLength(0);
  });

  it('revokes the pull token and lease, drops raw bodies only after explicit acknowledgement and changes epoch', async () => {
    const f = await fixture(); const paired = await f.pair(); await f.webhook();
    expect((await f.admin('revoke')).status).toBe(400); expect((await f.admin('revoke', { acknowledgeDrop: true })).status).toBe(200);
    expect((await f.pull(paired)).status).toBe(401); expect((await f.webhook(payload('later'))).status).toBe(503);
    const fresh = await f.pair(); expect(fresh.epoch).not.toBe(paired.epoch); expect(fresh.cursor).toBe(1);
    expect((await f.request('/v1/ack', { token: fresh.token, lease: fresh.lease, body: { epoch: paired.epoch, through: 1, eventId: 'a'.repeat(64) } })).status).toBe(409);
    expect((await (await f.pull(fresh)).json() as { envelopes: unknown[] }).envelopes).toHaveLength(0);
  });

  it('expires pairing codes and never silently rotates a live pull token', async () => {
    const f = await fixture(); const first = await (await f.admin('pairing')).json() as { code: string };
    expect((await f.admin('pairing')).status).toBe(409); await f.control('expire-pair');
    expect((await f.request('/v1/pair', { body: { code: first.code } })).status).toBe(403);
    const paired = await f.pair(); expect((await f.admin('pairing', { replacePending: true })).status).toBe(409);
    expect((await f.request('/v1/status', { token: paired.token })).status).toBe(200);
  });

  it('persists the queue, replay markers, acknowledgements and lease across a runtime restart', async () => {
    const first = await fixture(); const paired = await first.pair(); await first.webhook(); await first.close();
    const next = await fixture({}, first.directory); const response = await next.pull(paired); expect(response.status).toBe(200);
    const row = (await response.json() as { envelopes: GatewayWhatsAppRelayEnvelope[] }).envelopes[0]; expect(row.sequence).toBe(1); expect((await next.ack(paired, row)).status).toBe(200);
    await next.close(); const third = await fixture({}, first.directory); expect((await third.webhook()).status).toBe(200);
    expect((await (await third.pull(paired, 1)).json() as { envelopes: unknown[] }).envelopes).toHaveLength(0);
  });

  it('refuses a stored account being reassigned by a configuration change', async () => {
    const first = await fixture(); const paired = await first.pair(); await first.close(); const next = await fixture({ PHONE_NUMBER_ID: '999' }, first.directory);
    expect((await next.request('/v1/status', { token: paired.token })).status).toBe(503);
  });

  it.each(['/admin/pairing', '/v1/claim', '/v1/ack'])('refuses browser-origin requests and unknown routes at %s', async (route) => {
    const f = await fixture(); expect((await f.request(route, { body: {}, token: ADMIN, headers: { origin: 'https://example.com' } })).status).toBe(403);
    expect((await f.request('/__test/inspect')).status).toBe(404); expect((await f.mf.dispatchFetch('http://relay.test/health')).status).toBe(400);
  });

  it('serializes competing ingests without exceeding capacity or assigning a sequence to rejected bodies', async () => {
    const f = await fixture({ MAX_EVENTS: '1' }); await f.pair();
    const responses = await Promise.all(['one', 'two', 'three'].map((text) => f.webhook(payload(text))));
    expect(responses.map((item) => item.status).sort()).toEqual([200, 503, 503]);
    const saved = await (await f.control('inspect')).json() as { envelopes: unknown[]; replay: unknown[]; meta: { nextSequence: number } };
    expect(saved.envelopes).toHaveLength(1); expect(saved.replay).toHaveLength(1); expect(saved.meta.nextSequence).toBe(2);
  });

  it('bounds a pull response without truncating the original signed envelope', async () => {
    const f = await fixture(); const paired = await f.pair();
    for (const id of ['one', 'two']) {
      const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: BUSINESS, changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: PHONE }, messages: [{ id, text: { body: 'x'.repeat(800000) } }] } }] }] });
      expect((await f.webhook(raw)).status).toBe(200);
    }
    const response = await f.pull(paired); const raw = await response.text(); expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2 * 1024 * 1024);
    const received = JSON.parse(raw) as { envelopes: GatewayWhatsAppRelayEnvelope[] }; expect(received.envelopes).toHaveLength(1);
    expect((JSON.parse(Buffer.from(received.envelopes[0].bodyBase64, 'base64').toString()) as { entry: unknown[] }).entry).toHaveLength(1);
    await f.ack(paired, received.envelopes[0]); expect((await (await f.pull(paired, 1)).json() as { envelopes: GatewayWhatsAppRelayEnvelope[] }).envelopes[0].sequence).toBe(2);
  });

  it('releases ownership without acknowledging content so a fresh consumer can receive it', async () => {
    const f = await fixture(); const paired = await f.pair(); await f.webhook();
    expect((await f.request('/v1/release', { token: paired.token, lease: paired.lease, body: { epoch: paired.epoch } })).status).toBe(200);
    expect((await f.pull(paired)).status).toBe(409);
    const claim = await f.request('/v1/claim', { token: paired.token, body: { epoch: paired.epoch, consumerId: crypto.randomUUID() } }); expect(claim.status).toBe(200);
    const lease = (await claim.json() as { lease: string }).lease; expect((await (await f.pull({ ...paired, lease })).json() as { envelopes: unknown[] }).envelopes).toHaveLength(1);
  });

  it('removes the explicitly reviewed prefix even if expiry order changed after a retention update', async () => {
    const f = await fixture(); const paired = await f.pair(); await f.webhook(payload('one')); await f.webhook(payload('two')); await f.control('expire-last');
    expect((await f.pull(paired)).status).toBe(410);
    expect((await f.admin('recovery', { epoch: paired.epoch, through: 2, acknowledgeGap: true })).status).toBe(200);
    expect((await (await f.request('/v1/status', { token: paired.token })).json() as GatewayWhatsAppRelayStatus)).toMatchObject({ cursor: 2, queuedEvents: 0, gap: null });
  });

  it('expires raw content through the scheduled alarm even without a pull request', async () => {
    const f = await fixture(); await f.pair(); await f.webhook(); await f.control('expire-and-alarm');
    await expect.poll(async () => (await (await f.control('inspect')).json() as { envelopes: unknown[] }).envelopes.length).toBe(0);
    const saved = await (await f.control('inspect')).json() as { meta: { lostThrough: number; gapAt: number } };
    expect(saved.meta.lostThrough).toBe(1); expect(saved.meta.gapAt).toBeGreaterThan(0);
  });

});
