import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalWhatsAppPhone, normalizeWhatsAppPhone, whatsAppSenderPhone } from '../../shared/gateway-whatsapp.ts';
import type { GatewayWhatsAppReceipt } from '../../shared/types.ts';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox, gatewayInboxHistory, gatewayInputAllowed } from '../../server/gateways/inbox.ts';
import { GatewayFileProcessor } from '../../server/gateways/files.ts';
import { WhatsAppRelayIntake } from '../../server/gateways/whatsapp-intake.ts';
import { WhatsAppIdentities } from '../../server/gateways/whatsapp-identities.ts';
import { listProjects, saveProjects } from '../../server/store.ts';
import { gatewayConfig } from './gateway-fixtures.ts';

const SECRET = 'fake-local-meta-app-secret'; const BUSINESS = '9000000001'; const ALICE = '436641234567'; const BOB = '436649876543';
const EPOCH = '00000000-0000-4000-8000-000000000001';
const closers: (() => Promise<void>)[] = []; let account = 9100000000;
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const ack = async (proof: GatewayWhatsAppReceipt) => ({ epoch: proof.epoch, cursor: proof.sequence });
function message(id = 'wamid.1', overrides: Record<string, unknown> = {}) {
  return { id, from: ALICE, timestamp: '1700000000', type: 'text', text: { body: 'Hello' }, ...overrides };
}
function body(phone: string, messages: unknown[] = [message()], values: Record<string, unknown> = {}) {
  return { object: 'whatsapp_business_account', entry: [{ id: BUSINESS, changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { phone_number_id: phone }, messages, ...values,
  } }] }] };
}
function envelope(payload: unknown, sequence = 1, secret = SECRET) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const bodyBase64 = bytes.toString('base64');
  return { sequence, id: crypto.createHash('sha256').update(bodyBase64).digest('hex'), receivedAt: Date.now(), expiresAt: Date.now() + 60000,
    bodyBase64, signature: `sha256=${crypto.createHmac('sha256', secret).update(bytes).digest('hex')}`, contentType: 'application/json' };
}
function rotation(phone: string, overrides: Record<string, unknown> = {}) {
  const payload = body(phone, [], { user_id_update: [{ timestamp: '1700000010', user_id: { previous: 'US.OLD', current: 'US.NEW' }, ...overrides }] });
  payload.entry[0].changes[0].field = 'user_id_update'; return payload;
}
async function fixture() {
  const config = { ...gatewayConfig(String(account++)), name: 'WhatsApp intake', platform: 'whatsapp',
    senderPolicy: { platform: 'whatsapp', allowedPhones: [`+${ALICE}`] }, scope: { directMessages: true, conversationIds: [], guildIds: [] } };
  const instance = saveGatewayInstance(config); const state = new GatewayStateAdapter(instance.id); await state.connect();
  closers.push(() => state.disconnect()); const inbox = new GatewayInbox(state); inbox.bindWhatsAppRelay(EPOCH, 0);
  const intake = new WhatsAppRelayIntake(instance.id, inbox, BUSINESS, SECRET);
  return { instance, config, state, inbox, intake, body: (messages?: unknown[], values?: Record<string, unknown>) => body(instance.accountId, messages, values) };
}

describe('WhatsApp phone policy', () => {
  it('normalizes complete numbers and requires an explicit country for local notation', () => {
    expect(normalizeWhatsAppPhone('+43 664 1234567')).toBe(`+${ALICE}`);
    expect(normalizeWhatsAppPhone('0664 1234567', 'AT')).toBe(`+${ALICE}`);
    expect(normalizeWhatsAppPhone('0664 1234567')).toBeNull();
    expect(normalizeWhatsAppPhone('Call +43 664 1234567')).toBeNull();
    expect(normalizeWhatsAppPhone('+43 664 1234567 ext. 5')).toBeNull();
    for (const value of ['+123', '+99912345678', '6641234567', '+436641234567x5']) expect(canonicalWhatsAppPhone(value)).toBe(false);
    expect(whatsAppSenderPhone(ALICE)).toBe(`+${ALICE}`);
    for (const value of [`+${ALICE}`, '6641234567', '0436641234567', 'BSUID-ALICE', undefined]) expect(whatsAppSenderPhone(value)).toBeNull();
  });

  it('rejects invalid canonical-looking numbers in configuration', async () => {
    const f = await fixture();
    for (const phone of ['+123', '+999123456789', '+43 664 1234567']) expect(() => saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: [phone] } }, f.instance.id)).toThrow();
  });
});

describe('verified WhatsApp identity mappings', () => {
  it('keeps signed phone mappings across restart and accepts later BSUID-only messages in the same binding', async () => {
    const f = await fixture();
    await f.intake.receive(EPOCH, envelope(f.body([message('known', { from_user_id: 'US.OLD' })])), ack);
    await f.state.disconnect(); await f.state.connect();
    const restarted = new WhatsAppRelayIntake(f.instance.id, new GatewayInbox(f.state), BUSINESS, SECRET);
    await restarted.receive(EPOCH, envelope(f.body([message('hidden', { from: undefined, from_user_id: 'US.OLD', timestamp: '1700000001' })]), 2), ack);
    const [first, second] = f.inbox.list();
    expect(second.input.actor.id).toBe(`+${ALICE}`); expect(second.input.whatsappUserId).toBe('US.OLD');
    expect(second.bindingId).toBe(first.bindingId);
    expect(f.inbox.whatsAppRelayState()!.identities).toMatchObject({ businessAccountId: BUSINESS, users: [{ id: 'US.OLD', phone: `+${ALICE}`, retired: false }] });
  });

  it('uses only a unique matching signed contact to establish a missing phone', async () => {
    const f = await fixture();
    const contact = { user_id: 'US.CONTACT', wa_id: ALICE, profile: { name: 'Alice' } };
    await f.intake.receive(EPOCH, envelope(f.body([message('contact', { from: undefined, from_user_id: 'US.CONTACT' })], { contacts: [contact] })), ack);
    expect(f.inbox.list()[0].input.actor).toMatchObject({ id: `+${ALICE}`, label: 'Alice' });
    const receipt = await f.intake.receive(EPOCH, envelope(f.body([
      message('wrong', { from: undefined, from_user_id: 'US.OTHER' }),
      message('parent-only', { from: undefined, from_parent_user_id: 'US.CONTACT' }),
    ], { contacts: [contact] }), 2), ack);
    expect(receipt).toMatchObject({ accepted: 0, unmatchedSenders: 2 }); expect(f.inbox.list()).toHaveLength(1);
  });

  it('revokes old aliases and queued files on rotation without carrying phone permission to the new ID', async () => {
    const f = await fixture();
    await f.intake.receive(EPOCH, envelope(f.body([
      message('known', { from_user_id: 'US.OLD' }), message('file', { from_user_id: 'US.OLD', type: 'document', document: { id: 'media', mime_type: 'text/plain' } }),
    ])), ack);
    await f.intake.receive(EPOCH, envelope(rotation(f.instance.accountId), 2), async (proof) => {
      expect(f.inbox.list().every((event) => event.status === 'needs-review')).toBe(true);
      expect(() => f.inbox.checkAccess(f.inbox.list()[0])).toThrow('identity changed');
      return ack(proof);
    });
    const receipt = await f.intake.receive(EPOCH, envelope(f.body([
      message('old-hidden', { from: undefined, from_user_id: 'US.OLD', timestamp: '1700000011' }),
      message('new-hidden', { from: undefined, from_user_id: 'US.NEW', timestamp: '1700000011' }),
      message('new-phone', { from: BOB, from_user_id: 'US.NEW', timestamp: '1700000012' }),
    ]), 3), ack);
    expect(receipt).toMatchObject({ accepted: 0, ignored: 3, unmatchedSenders: 2 });
    expect(f.inbox.list()).toHaveLength(2); expect(f.inbox.list()[1].fileBatch).toBeUndefined(); expect(f.inbox.claimNext()).toBeNull();
    expect(f.inbox.whatsAppRelayState()!.identities!.users).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'US.OLD', retired: true }), expect.objectContaining({ id: 'US.NEW', phone: `+${BOB}`, retired: false }),
    ]));
  });

  it('requires the new phone to be independently allowed and opens its own conversation', async () => {
    const f = await fixture(); await f.intake.receive(EPOCH, envelope(f.body([message('known', { from_user_id: 'US.OLD' })])), ack);
    const old = f.inbox.list()[0];
    await f.intake.receive(EPOCH, envelope(rotation(f.instance.accountId, { wa_id: BOB }), 2), ack);
    const hidden = (id: string) => f.body([message(id, { from: undefined, from_user_id: 'US.NEW', timestamp: '1700000011' })]);
    expect((await f.intake.receive(EPOCH, envelope(hidden('denied'), 3), ack)).accepted).toBe(0);
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: [`+${BOB}`] } }, f.instance.id);
    expect((await f.intake.receive(EPOCH, envelope(hidden('allowed'), 4), ack)).accepted).toBe(1);
    const current = f.inbox.list()[1]; expect(current.input.actor.id).toBe(`+${BOB}`);
    expect(current.bindingId).not.toBe(old.bindingId); expect(current.input.conversationId).toBe(`+${BOB}`);
  });

  it('handles signed number-change system messages and holds earlier phone-only work', async () => {
    const f = await fixture(); await f.intake.receive(EPOCH, envelope(f.body([message('phone-only'), message('known', { from_user_id: 'US.OLD' })])), ack);
    await f.intake.receive(EPOCH, envelope(f.body([message('system', { type: 'system', timestamp: '1700000010', system: {
      type: 'user_changed_number', user_id: 'US.NEW', wa_id: BOB, body: 'Never interpreted as a command',
    } })]), 2), ack);
    expect(f.inbox.list()).toHaveLength(2); expect(f.inbox.list().every((event) => event.status === 'needs-review')).toBe(true);
    expect(f.inbox.whatsAppRelayState()!.identities!.phoneChanges).toEqual([{ phone: `+${ALICE}`, at: 1700000010000 }]);
    const replay = await f.intake.receive(EPOCH, envelope(f.body([message('late-old', { from_user_id: 'US.OLD', timestamp: '1700000020' })]), 3), ack);
    expect(replay.accepted).toBe(0); expect(replay.unmatchedSenders).toBe(1);
  });

  it('keeps retired IDs blocked when old signed messages or rotations arrive in a new batch', async () => {
    const f = await fixture(); const original = message('known', { from_user_id: 'US.OLD' });
    await f.intake.receive(EPOCH, envelope(f.body([original])), ack);
    await f.intake.receive(EPOCH, envelope(rotation(f.instance.accountId, { wa_id: BOB }), 2), ack);
    await f.intake.receive(EPOCH, envelope(rotation(f.instance.accountId, { user_id: { previous: 'US.NEW', current: 'US.NEWER' }, timestamp: '1700000020' }), 3), ack);
    await f.intake.receive(EPOCH, envelope(rotation(f.instance.accountId, { wa_id: ALICE }), 4), ack);
    const receipt = await f.intake.receive(EPOCH, envelope(f.body([original, message('forged-current', { from: undefined, from_user_id: 'US.NEW', timestamp: '1700000021' })]), 5), ack);
    expect(receipt.accepted).toBe(0); expect(f.inbox.list()).toHaveLength(1);
    expect(f.inbox.whatsAppRelayState()!.identities!.users.find((user) => user.id === 'US.NEW')!.retired).toBe(true);
  });

  it.each(['phone', 'contact'])('revokes conflicting %s mappings even when both phones are allowed', async (kind) => {
    const f = await fixture(); saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: [`+${ALICE}`, `+${BOB}`] } }, f.instance.id);
    await f.intake.receive(EPOCH, envelope(f.body([message('known', { from_user_id: 'US.OLD' })])), ack);
    const conflicting = f.body([message('conflict', { from: kind === 'phone' ? BOB : ALICE, from_user_id: 'US.OLD', timestamp: '1700000001' })],
      kind === 'contact' ? { contacts: [{ user_id: 'US.OLD', wa_id: BOB, profile: { name: 'Alice' } }] } : {});
    expect((await f.intake.receive(EPOCH, envelope(conflicting, 2), ack)).accepted).toBe(0);
    expect(f.inbox.list()[0].status).toBe('needs-review'); expect(f.inbox.claimNext()).toBeNull();
  });

  it('keeps mappings private to their instance and business account', async () => {
    const first = await fixture(); const second = await fixture();
    await first.intake.receive(EPOCH, envelope(first.body([message('known', { from_user_id: 'US.OLD' })])), ack);
    expect((await second.intake.receive(EPOCH, envelope(second.body([message('hidden', { from: undefined, from_user_id: 'US.OLD' })])), ack)).accepted).toBe(0);
    expect(() => new WhatsAppRelayIntake(first.instance.id, first.inbox, '9000000099', SECRET)).toThrow('verified');
    expect(() => new WhatsAppRelayIntake(second.instance.id, first.inbox, BUSINESS, SECRET)).toThrow('verified');
    expect(first.inbox.whatsAppRelayState()!.identities!.businessAccountId).toBe(BUSINESS);
  });

  it('refuses incomplete or undated rotations without acknowledging or changing saved mappings', async () => {
    const f = await fixture(); await f.intake.receive(EPOCH, envelope(f.body([message('known', { from_user_id: 'US.OLD' })])), ack);
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); const acknowledge = vi.fn(ack);
    for (const changes of [{ timestamp: undefined }, { user_id: undefined }, { user_id: { previous: 'US.OLD', current: 'US.OLD' } }]) {
      await expect(f.intake.receive(EPOCH, envelope(rotation(f.instance.accountId, changes), 2), acknowledge)).rejects.toThrow('verified');
      expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
    }
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it('applies a later rotation in the same batch before admitting the earlier message', async () => {
    const f = await fixture(); const payload = f.body([message('old', { from_user_id: 'US.OLD' })]);
    payload.entry[0].changes.push(rotation(f.instance.accountId).entry[0].changes[0]);
    const receipt = await f.intake.receive(EPOCH, envelope(payload), ack);
    expect(receipt).toMatchObject({ accepted: 0, ignored: 2 }); expect(f.inbox.list()).toEqual([]);
  });

  it('bounds retired identity storage without discarding replay protection', () => {
    const state = { businessAccountId: BUSINESS, users: Array.from({ length: 10000 }, (_, i) => ({ id: `US.${i}`, phone: null, at: 1700000000000, retired: true })), phoneChanges: [] };
    const identities = new WhatsAppIdentities(BUSINESS, state);
    expect(() => identities.resolve('US.EXTRA', `+${ALICE}`, 1700000001000)).toThrow('store is full');
    expect(identities.state.users).toHaveLength(10000); expect(identities.resolve('US.1', `+${ALICE}`, 1700000001000)).toBeNull();
  });

  it('clears a previously known current phone when a rotation withholds it', async () => {
    const f = await fixture(); saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: [`+${ALICE}`, `+${BOB}`] } }, f.instance.id);
    await f.intake.receive(EPOCH, envelope(f.body([
      message('old', { from_user_id: 'US.OLD' }), message('current', { from: BOB, from_user_id: 'US.NEW' }), message('phone-only', { from: BOB }),
    ])), ack);
    await f.intake.receive(EPOCH, envelope(rotation(f.instance.accountId), 2), ack);
    expect(f.inbox.list().every((event) => event.status === 'needs-review')).toBe(true);
    expect(f.inbox.whatsAppRelayState()!.identities!.users.find((user) => user.id === 'US.NEW')!.phone).toBeNull();
    expect(f.inbox.whatsAppRelayState()!.identities!.phoneChanges).toEqual(expect.arrayContaining([{ phone: `+${BOB}`, at: 1700000010000 }]));
  });

  it('commits mapping revocation, held work and the relay receipt together, or leaves all three unchanged', async () => {
    const f = await fixture(); await f.intake.receive(EPOCH, envelope(f.body([message('known', { from_user_id: 'US.OLD' })])), ack);
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); const write = fs.writeFileSync.bind(fs);
    const failure = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).includes('inbox.json')) throw new Error('identity disk full');
      return write(file, ...args);
    });
    const acknowledge = vi.fn(ack);
    await expect(f.intake.receive(EPOCH, envelope(rotation(f.instance.accountId), 2), acknowledge)).rejects.toThrow('identity disk full');
    failure.mockRestore(); expect(acknowledge).not.toHaveBeenCalled(); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
    expect(f.inbox.list()[0].status).toBe('queued'); expect(f.inbox.whatsAppRelayState()!.identities!.users[0].retired).toBe(false);
    await f.intake.receive(EPOCH, envelope(rotation(f.instance.accountId), 2), ack);
    expect(f.inbox.list()[0].status).toBe('needs-review'); expect(f.inbox.whatsAppRelayState()!.cursor).toBe(2);
  });
});

describe('verified local WhatsApp relay intake', () => {
  it('commits the whole batch and its pinned routes before ACK, then releases text and files', async () => {
    const f = await fixture(); let downloads = 0;
    const processor = new GatewayFileProcessor(f.instance.id, f.inbox, async () => { downloads++; return { source: Readable.from(['hello']), declaredBytes: 5 }; }, new AbortController().signal);
    closers.push(() => processor.stop()); await processor.start();
    const receive = f.intake.receive(EPOCH, envelope(f.body([
      message(), message('wamid.file', { type: 'document', document: { id: 'media-1', mime_type: 'text/plain', filename: 'plan.txt' } }),
    ])), async (proof) => {
      const saved = f.inbox.list(); expect(saved).toHaveLength(2); expect(saved.every((event) => !event.relay!.confirmed)).toBe(true);
      expect(f.inbox.claimNext()).toBeNull(); await processor.wake(); expect(downloads).toBe(0);
      expect(() => f.inbox.prepareFiles(saved[1].id, () => 'should-not-create')).toThrow('acknowledgement');
      expect(f.inbox.whatsAppRelayState()!.receipt).toMatchObject({ accepted: 2, confirmed: false });
      return ack(proof);
    });
    await receive; await processor.wake();
    expect(downloads).toBe(1); expect(f.inbox.list()[1].files![0].status).toBe('saved');
    expect(f.inbox.claimNext()!.input.text).toBe('Hello');
    expect(f.inbox.list()[0].input.sentAt).toBe(1700000000000);
    expect(f.inbox.whatsAppRelayState()).toMatchObject({ cursor: 1, receipt: { confirmed: true } });
  });

  it('recovers an ACK reply lost after remote commit without releasing work early or re-accepting the body', async () => {
    const f = await fixture(); const value = envelope(f.body()); let remoteCursor = 0;
    await expect(f.intake.receive(EPOCH, value, async (proof) => { remoteCursor = proof.sequence; throw new Error('lost reply'); })).rejects.toThrow('lost reply');
    expect(f.inbox.claimNext()).toBeNull(); expect(f.inbox.list()[0].operationId).toBeUndefined();
    await f.state.disconnect(); await f.state.connect();
    const restarted = new WhatsAppRelayIntake(f.instance.id, new GatewayInbox(f.state), BUSINESS, SECRET);
    await restarted.confirmPending(async (proof) => { expect(proof.sequence).toBe(remoteCursor); return ack(proof); });
    expect(f.inbox.claimNext()).not.toBeNull();
    const unusedAck = vi.fn(ack); await restarted.receive(EPOCH, value, unusedAck); expect(unusedAck).not.toHaveBeenCalled();
    expect(f.inbox.list()).toHaveLength(1); expect(f.inbox.claimNext()).toBeNull();
  });

  it('holds mismatched acknowledgements and rejects skipped batches, epoch changes and concurrent intake', async () => {
    const f = await fixture(); const value = envelope(f.body());
    await expect(f.intake.receive(EPOCH, value, async (proof) => ({ epoch: proof.epoch, cursor: 2 }))).rejects.toThrow('does not match');
    expect(f.inbox.claimNext()).toBeNull();
    await expect(f.intake.receive(EPOCH, envelope(f.body([message('wamid.2')]), 2), ack)).rejects.toThrow('saved relay receipt');
    expect(() => f.inbox.bindWhatsAppRelay(crypto.randomUUID(), 0)).toThrow('cursor changed');
    await f.intake.confirmPending(async (proof) => {
      await expect(f.intake.receive(EPOCH, value, ack)).rejects.toThrow('Finish');
      await expect(f.intake.confirmPending(ack)).rejects.toThrow('Finish');
      return ack(proof);
    });
    await expect(f.intake.receive(EPOCH, envelope(f.body([message('wamid.3')]), 3), ack)).rejects.toThrow('saved relay receipt');
    expect(f.inbox.whatsAppRelayState()!.cursor).toBe(1);
  });

  it.each(['signature', 'digest', 'base64', 'encoding', 'content-type', 'account', 'phone', 'field', 'json', 'utf8', 'timestamp'])('refuses %s errors without writing receipts or acknowledging', async (failure) => {
    const f = await fixture(); let payload: unknown = f.body();
    if (failure === 'account') payload = { ...f.body(), entry: [{ ...f.body().entry[0], id: '999' }] };
    if (failure === 'phone') payload = body('999');
    if (failure === 'field') payload = { ...f.body(), entry: [{ ...f.body().entry[0], changes: [{ ...f.body().entry[0].changes[0], field: 'account_update' }] }] };
    if (failure === 'json') payload = Buffer.from('{broken');
    if (failure === 'utf8') payload = Buffer.from([0xff]);
    if (failure === 'timestamp') payload = f.body([message('wamid.bad', { timestamp: '9999999999999' })]);
    const value = envelope(payload, 1, failure === 'signature' ? 'wrong-secret' : SECRET);
    if (failure === 'digest') value.id = '0'.repeat(64);
    if (failure === 'base64') value.bodyBase64 += '\n';
    if (failure === 'encoding') Object.assign(value, { contentEncoding: 'gzip' });
    if (failure === 'content-type') value.contentType = 'text/plain';
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); const acknowledge = vi.fn(ack);
    await expect(f.intake.receive(EPOCH, value, acknowledge)).rejects.toThrow('could not be verified');
    expect(acknowledge).not.toHaveBeenCalled(); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
  });

  it('rejects a mixed business-phone batch as a whole', async () => {
    const f = await fixture(); const payload = f.body(); payload.entry[0].changes.push(body('999').entry[0].changes[0]);
    const acknowledge = vi.fn(ack); await expect(f.intake.receive(EPOCH, envelope(payload), acknowledge)).rejects.toThrow('verified');
    expect(f.inbox.list()).toEqual([]); expect(acknowledge).not.toHaveBeenCalled();
  });

  it('denies missing phones, suffixes, typed numbers, contact-card claims, status and actions', async () => {
    const f = await fixture();
    const messages = [
      message('other', { from: BOB }), message('suffix', { from: '6641234567' }),
      message('bsuid', { from: undefined, from_user_id: 'BSUID-ALICE', text: { body: `My phone is +${ALICE}` } }),
      message('forward', { from: BOB, context: { from: ALICE }, text: { body: 'forwarded' } }),
      message('card', { from: BOB, type: 'contacts', contacts: [{ phones: [{ wa_id: ALICE }] }] }),
      message('button', { type: 'button', button: { payload: 'run' } }),
      message('system', { type: 'system', system: { type: 'user_changed_user_id', wa_id: ALICE, user_id: 'BSUID-ALICE' } }),
    ];
    const receipt = await f.intake.receive(EPOCH, envelope(f.body(messages, {
      contacts: [{ wa_id: ALICE, user_id: 'UNRELATED-BSUID', profile: { name: 'Allowed person' } }],
      statuses: [{ id: 'status-only', recipient_id: ALICE, status: 'read' }],
    })), ack);
    expect(receipt).toMatchObject({ accepted: 0, ignored: 7, unmatchedSenders: 2, confirmed: true });
    expect(f.inbox.list()).toEqual([]); expect(f.inbox.whatsAppRelayState()!.cursor).toBe(1);
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).not.toContain('My phone');
  });

  it('uses only the matching signed sender for labels and strips URLs and callbacks from media', async () => {
    const f = await fixture(); const payload = f.body([message('file', { type: 'image', image: {
      id: 'meta-media', mime_type: 'image/png', caption: 'A drawing', url: 'https://private.test/token', fetchData: 'malicious',
    } })], { contacts: [{ wa_id: BOB, profile: { name: 'Wrong contact' } }] });
    await f.intake.receive(EPOCH, envelope(payload), ack);
    const saved = f.inbox.list()[0]; expect(saved.input.actor.label).toBe(`+${ALICE}`);
    expect(saved.input.media).toEqual([{ kind: 'image', fileId: 'meta-media', mimeType: 'image/png' }]);
    const disk = fs.readFileSync(f.state.inboxFile(), 'utf8');
    for (const secret of ['private.test', 'malicious', 'Wrong contact', SECRET, 'bodyBase64', 'signature']) expect(disk).not.toContain(secret);
  });

  it('deduplicates stable source messages across batches and route changes, and rechecks sender revocation', async () => {
    const f = await fixture(); const first = listProjects()[0]; const second = { ...first, id: `whatsapp-other-${account}`, name: 'Other' };
    saveProjects([...listProjects(), second]);
    await expect(f.intake.receive(EPOCH, envelope(f.body()), async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    saveGatewayInstance({ ...f.config, projectId: second.id }, f.instance.id);
    await f.intake.confirmPending(ack);
    await f.intake.receive(EPOCH, envelope(f.body([message(), message('wamid.new')]), 2), ack);
    const saved = f.inbox.list(); expect(saved).toHaveLength(2);
    expect(saved[0].route.projectId).toBe(first.id); expect(saved[1].route.projectId).toBe(second.id);
    expect(saved.map((item) => item.relay!.sequence)).toEqual([1, 2]);
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: [`+${BOB}`] } }, f.instance.id);
    expect(f.inbox.claimNext()).toBeNull(); expect(f.inbox.list().every((item) => item.status === 'needs-review')).toBe(true);
    expect(gatewayInputAllowed({ ...f.instance, scope: { ...f.instance.scope, directMessages: false } }, saved[0].input)).toBe(false);
    for (const input of [{ ...saved[0].input, actor: { ...saved[0].input.actor, id: '6641234567' } }, { ...saved[0].input, directMessage: false }, { ...saved[0].input, conversationId: `+${BOB}` }, { ...saved[0].input, threadId: 'thread' }]) expect(gatewayInputAllowed(f.instance, input)).toBe(false);
    expect(() => f.inbox.accept(saved[0].input)).toThrow('verified relay');
  });

  it('writes neither a prefix nor an ACK when the batch journal write fails', async () => {
    const f = await fixture(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    const write = fs.writeFileSync.bind(fs); const fail = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).includes('inbox.json')) throw new Error('disk full');
      return write(file, ...args);
    });
    const acknowledge = vi.fn(ack);
    await expect(f.intake.receive(EPOCH, envelope(f.body([message(), message('two')])), acknowledge)).rejects.toThrow('disk full');
    fail.mockRestore(); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before); expect(acknowledge).not.toHaveBeenCalled();
    await f.intake.receive(EPOCH, envelope(f.body([message(), message('two')])), ack); expect(f.inbox.list()).toHaveLength(2);
  });

  it('keeps work gated when saving the confirmed ACK fails, then confirms the same receipt', async () => {
    const f = await fixture(); const write = fs.writeFileSync.bind(fs);
    await expect(f.intake.receive(EPOCH, envelope(f.body()), async (proof) => {
      vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
        if (String(file).includes('inbox.json')) throw new Error('confirmation disk full');
        return write(file, ...args);
      });
      return ack(proof);
    })).rejects.toThrow('confirmation disk full');
    vi.restoreAllMocks(); expect(f.inbox.claimNext()).toBeNull();
    expect(f.inbox.whatsAppRelayState()).toMatchObject({ cursor: 0, receipt: { confirmed: false } });
    await f.intake.confirmPending(ack); expect(f.inbox.claimNext()).not.toBeNull();
  });

  it('rechecks phone access before downloading a file accepted before revocation', async () => {
    const f = await fixture(); const download = vi.fn(async () => ({ source: Readable.from(['hello']), declaredBytes: 5 }));
    const processor = new GatewayFileProcessor(f.instance.id, f.inbox, download, new AbortController().signal);
    closers.push(() => processor.stop()); await processor.start();
    await f.intake.receive(EPOCH, envelope(f.body([message('file', { type: 'document', document: { id: 'media', mime_type: 'text/plain' } })])), async (proof) => {
      saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: [`+${BOB}`] } }, f.instance.id);
      return ack(proof);
    });
    await processor.wake(); expect(download).not.toHaveBeenCalled();
    expect(f.inbox.list()[0].status).toBe('needs-review'); expect(f.inbox.list()[0].fileBatch).toBeUndefined();
  });

  it('fails closed on inconsistent saved ACK flags', async () => {
    const f = await fixture(); await f.intake.receive(EPOCH, envelope(f.body()), ack);
    const journal = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as { events: { relay: { confirmed: boolean } }[] };
    journal.events[0].relay.confirmed = false; fs.writeFileSync(f.state.inboxFile(), JSON.stringify(journal));
    expect(() => f.inbox.list()).toThrow('relay receipts'); expect(() => gatewayInboxHistory(f.instance.id)).toThrow('unreadable');
  });
});
