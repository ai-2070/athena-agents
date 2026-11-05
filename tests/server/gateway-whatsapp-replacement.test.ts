import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayInboxJournal } from '../../shared/types.ts';
import { getGatewaySecrets } from '../../server/store.ts';
import { gatewayWhatsAppReplacement, GatewayInbox, gatewayRequestReview } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { getGatewayInstance, saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { finishWhatsAppPairing, replaceWhatsAppPairing, reviewWhatsAppPairing, whatsAppSetup } from '../../server/gateways/whatsapp-setup.ts';
import { WhatsAppRelayIntake } from '../../server/gateways/whatsapp-intake.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { gatewayConfig } from './gateway-fixtures.ts';

const BUSINESS = '9000000001'; const SECRET = 'PRIVATE_META_APP_SECRET'; const CODE = 'a'.repeat(64); const KEY = 'b'.repeat(64);
const EPOCH = '00000000-0000-4000-8000-000000000001'; const NEXT = '00000000-0000-4000-8000-000000000002';
const INSTALLATION = '00000000-0000-4000-8000-000000000003'; const ORIGIN = 'https://new-relay.example';
const limits = { bodyBytes: 1048576, queueBytes: 16777216, queueEvents: 1000, replayEntries: 10000, retentionMs: 259200000, replayMs: 604800000, pairingMs: 600000, leaseMs: 60000, batchBytes: 2097152, batchEvents: 20 };
const closes: (() => Promise<void>)[] = []; let account = 9700000000;
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });

async function fixture() {
  const config = { ...gatewayConfig(String(account++)), name: 'WhatsApp replacement', platform: 'whatsapp', enabled: true,
    senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436641234567'] }, scope: { directMessages: true, conversationIds: [], guildIds: [] } };
  const instance = saveGatewayInstance(config); saveGatewayCredentials(instance.id, { accessToken: 'PRIVATE_ACCESS', signingSecret: SECRET, relayKey: 'c'.repeat(64) });
  const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect()); const inbox = new GatewayInbox(state);
  inbox.bindWhatsAppRelayConnection({ origin: 'https://old-relay.example', installationId: INSTALLATION, businessAccountId: BUSINESS, phoneNumberId: instance.accountId, epoch: EPOCH }, 0);
  const intake = new WhatsAppRelayIntake(instance.id, inbox, BUSINESS, SECRET); let calls = 0;
  const status = { version: 1, installationId: crypto.randomUUID(), businessAccountId: BUSINESS, phoneNumberId: instance.accountId, epoch: NEXT, cursor: 0, gap: null, limits, queuedEvents: 0, queuedBytes: 0, token: KEY };
  async function receive(id: string, options: { confirmed?: boolean; phone?: boolean; at?: number; user?: string } = {}) {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: BUSINESS, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: instance.accountId }, messages: [{ id, ...(options.phone === false ? {} : { from: '436641234567' }),
        from_user_id: options.user ?? 'US.ALICE', timestamp: String(Math.floor((options.at ?? Date.now()) / 1000)), type: 'text', text: { body: id } }],
    } }] }] });
    const bodyBase64 = Buffer.from(raw).toString('base64'); const relay = inbox.whatsAppRelayState()!;
    return intake.receive(relay.epoch, { sequence: relay.cursor + 1, id: crypto.createHash('sha256').update(bodyBase64).digest('hex'), receivedAt: Date.now(), expiresAt: Date.now() + 60000,
      bodyBase64, signature: 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'), contentType: 'application/json' }, async (proof) => {
      if (options.confirmed === false) throw new Error('Lost ACK'); return { epoch: proof.epoch, cursor: proof.sequence };
    });
  }
  const pause = () => saveGatewayInstance({ ...config, enabled: false }, instance.id);
  const body = () => ({ revision: gatewayWhatsAppReplacement(instance.id).revision!, origin: ORIGIN, businessAccountId: BUSINESS, code: CODE, acknowledgePreviousStopped: true, acknowledgeLoss: true });
  const request = async (url: string, init: RequestInit) => { calls++; expect(url).toBe(`${ORIGIN}/v1/pair`); expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    expect(JSON.parse(String(init.body))).toEqual({ code: CODE }); expect(new Headers(init.headers).has('authorization')).toBe(false); expect(getGatewaySecrets(instance.id).whatsappPairing?.phase).toBe('requesting'); return Response.json(status); };
  const start = (value: unknown = body()) => replaceWhatsAppPairing(inbox, value, { request });
  const finish = () => finishWhatsAppPairing(inbox, { revision: whatsAppSetup(instance.id).pending!.revision, acknowledgeLoss: true });
  return { config, instance, state, inbox, status, intake, receive, pause, body, request, start, finish, calls: () => calls };
}

describe('explicit WhatsApp relay replacement', () => {
  it('saves the new key first, archives the original receipts on explicit finish and starts a fresh private conversation', async () => {
    const f = await fixture(); await f.receive('old'); const old = structuredClone(f.inbox.list()[0]); const saved = structuredClone(f.inbox.whatsAppRelayState()); f.pause();
    const preview = gatewayWhatsAppReplacement(f.instance.id); expect(preview.retired).toBe(0); expect(JSON.stringify(preview)).not.toContain('relay.example');
    expect(await f.start()).toMatchObject({ paired: true, pending: { phase: 'received', replacement: true } });
    expect(f.inbox.whatsAppRelayState()).toEqual(saved); expect(getGatewaySecrets(f.instance.id).relayKey).toBe(KEY); expect(f.calls()).toBe(1);
    expect(() => f.inbox.checkAccess(old)).toThrow('pending'); await f.state.disconnect(); await f.state.connect();
    expect(f.finish().pending).toBeNull(); expect(getGatewayInstance(f.instance.id).enabled).toBe(false);
    const journal = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal;
    expect(journal.whatsappRetired).toEqual([{ at: expect.any(Number), attemptId: expect.any(String), revision: preview.revision, state: saved }]);
    expect(journal.events[0]).toMatchObject({ id: old.id, bindingId: old.bindingId, relay: old.relay, status: 'needs-review' });
    expect(journal.whatsappRelay).toMatchObject({ epoch: NEXT, cursor: 0, startedAt: expect.any(Number), identities: { users: [{ id: 'US.ALICE', phone: null, retired: false }] } });
    saveGatewayInstance(f.config, f.instance.id); expect(() => f.inbox.checkAccess(old)).toThrow('replaced relay');
    const at = journal.whatsappRelay!.startedAt! + 2000;
    expect(await f.receive('hidden', { phone: false, at })).toMatchObject({ accepted: 0, unmatchedSenders: 1 });
    expect(await f.receive('old', { at })).toMatchObject({ accepted: 0, ignored: 1 });
    expect(await f.receive('fresh', { at })).toMatchObject({ accepted: 1 }); const fresh = f.inbox.claimNext()!;
    expect(fresh.input.sourceMessageId).toBe('fresh'); expect(fresh.bindingId).not.toBe(old.bindingId); expect(fresh.route).toEqual(old.route); expect(f.inbox.list()).toHaveLength(2);
    const disk = fs.readFileSync(f.state.inboxFile(), 'utf8'); for (const value of [CODE, KEY, SECRET, 'PRIVATE_ACCESS', 'bodyBase64']) expect(disk).not.toContain(value);
  });

  it('preserves a lost ACK as unconfirmed, permits explicit dismissal, and never confirms it from new receipt sequences', async () => {
    const f = await fixture(); await expect(f.receive('unconfirmed', { confirmed: false })).rejects.toThrow('Lost ACK'); f.pause(); await f.start(); f.finish();
    const old = f.inbox.list()[0]; expect(old.relay!.confirmed).toBe(false); expect(f.inbox.whatsAppRelayState()!.receipt).toBeUndefined();
    const preview = gatewayRequestReview(f.instance.id, old.id); expect(preview.canDismiss).toBe(true); f.inbox.dismissRequest(old.id, { revision: preview.revision, acknowledgeDismiss: true });
    saveGatewayInstance(f.config, f.instance.id); await f.receive('fresh', { at: f.inbox.whatsAppRelayState()!.startedAt! + 2000 });
    expect(f.inbox.list()[0].relay!.confirmed).toBe(false); expect(f.inbox.claimNext()!.input.sourceMessageId).toBe('fresh');
    await f.state.disconnect(); await f.state.connect(); expect(f.inbox.list()[0].relay!.confirmed).toBe(false);
  });

  it('rejects pre-replacement timestamps without learning aliases and keeps retired aliases retired', async () => {
    const f = await fixture(); await f.receive('old'); const journal = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal;
    journal.whatsappRelay!.identities!.users.push({ id: 'US.RETIRED', phone: null, at: Date.now(), retired: true }); fs.writeFileSync(f.state.inboxFile(), JSON.stringify(journal));
    f.pause(); await f.start(); f.finish(); saveGatewayInstance(f.config, f.instance.id); const at = f.inbox.whatsAppRelayState()!.startedAt!;
    expect(await f.receive('delayed', { user: 'US.DELAYED', at })).toMatchObject({ accepted: 0, ignored: 1 }); expect(f.inbox.whatsAppRelayState()!.identities!.users.some((user) => user.id === 'US.DELAYED')).toBe(false);
    expect(await f.receive('retired', { user: 'US.RETIRED', at: at + 2000 })).toMatchObject({ accepted: 0, unmatchedSenders: 1 });
  });

  it('preserves native operation IDs and sent/uncertain reply prefixes while forbidding old-source delivery', async () => {
    const f = await fixture(); await f.receive('reply'); const event = f.inbox.claimNext()!; f.inbox.beginDispatch(event.id, event.operationId!, await gatewayConversation(event, new AbortController().signal));
    f.inbox.finishDispatch(event.id, event.operationId!, 'x'.repeat(6500)); f.inbox.claimReply(); f.inbox.settleReply(event.id, 0, { remoteId: 'sent-prefix' }); f.inbox.claimReply(); f.inbox.recover();
    f.pause(); await f.start(); f.finish(); const held = f.inbox.list()[0]; expect(held.operationId).toBe(event.operationId); expect(held.reply!.parts.map((part) => part.status)).toEqual(['sent', 'uncertain', 'failed']);
    saveGatewayInstance(f.config, f.instance.id); expect(() => f.inbox.retryReply(event.id)).toThrow('replaced relay'); expect(f.inbox.claimReply()).toBeNull();
  });

  it('requires both acknowledgements, the current revision and a paused instance before exchange', async () => {
    const f = await fixture(); await expect(f.start()).rejects.toThrow('Pause'); f.pause(); const body = f.body();
    for (const value of [{ ...body, acknowledgeLoss: false }, { ...body, acknowledgePreviousStopped: false }, { ...body, revision: '0'.repeat(64) }, { ...body, businessAccountId: '999' }, { ...body, extra: true }]) await expect(f.start(value)).rejects.toThrow();
    saveGatewayInstance({ ...f.config, enabled: false, name: 'Renamed' }, f.instance.id); await expect(f.start(body)).rejects.toThrow('changed'); expect(f.calls()).toBe(0);
  });

  it.each(['phoneNumberId', 'businessAccountId', 'epoch', 'token'] as const)('holds an unknown exchange when the replacement %s is invalid', async (field) => {
    const f = await fixture(); f.pause(); Object.assign(f.status, { [field]: field === 'epoch' ? EPOCH : field === 'token' ? 'PRIVATE_BAD' : '999' });
    await expect(f.start()).rejects.toThrow(); expect(whatsAppSetup(f.instance.id).pending).toMatchObject({ phase: 'requesting', replacement: true }); expect(f.inbox.whatsAppRelayState()!.epoch).toBe(EPOCH);
  });

  it('requires revoking an unknown new pairing before retrying and keeps old history intact', async () => {
    const f = await fixture(); await f.receive('old'); f.pause(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    await expect(replaceWhatsAppPairing(f.inbox, f.body(), { request: async () => { throw new Error('PRIVATE_NETWORK'); } })).rejects.toThrow('unknown');
    await expect(f.start()).rejects.toThrow('changed'); expect(f.calls()).toBe(0);
    const pending = whatsAppSetup(f.instance.id).pending!;
    expect(() => reviewWhatsAppPairing(f.inbox, { revision: pending.revision })).toThrow();
    reviewWhatsAppPairing(f.inbox, { revision: pending.revision, acknowledgeRemoteRevoked: true }); expect(getGatewaySecrets(f.instance.id).relayKey).toBeUndefined();
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before); await f.start(); expect(f.calls()).toBe(1);
  });

  it('requires a fresh finish confirmation after settings or work change and never exchanges the code again', async () => {
    const f = await fixture(); await f.receive('old'); f.pause(); await f.start(); const revision = whatsAppSetup(f.instance.id).pending!.revision;
    expect(() => finishWhatsAppPairing(f.inbox, { revision })).toThrow('changed'); f.inbox.review(f.inbox.list()[0].id, 'Changed while pairing');
    expect(() => finishWhatsAppPairing(f.inbox, { revision, acknowledgeLoss: true })).toThrow('changed');
    f.finish(); expect(f.calls()).toBe(1);
  });

  it.each(['inbox', 'secrets'])('resumes a saved received replacement after the %s finish write fails', async (kind) => {
    const f = await fixture(); await f.receive('old'); f.pause(); await f.start(); const write = fs.writeFileSync.bind(fs);
    const fault = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => { if (String(file).includes(kind === 'inbox' ? 'inbox.json' : 'gateway-secrets.json')) throw new Error('PRIVATE_DISK'); return write(file, ...args); });
    expect(() => f.finish()).toThrow(); fault.mockRestore(); expect(whatsAppSetup(f.instance.id).pending!.phase).toBe('received'); await f.state.disconnect(); await f.state.connect();
    f.finish(); const journal = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal; expect(journal.whatsappRetired).toHaveLength(1); expect(journal.events).toHaveLength(1); expect(f.calls()).toBe(1);
  });

  it('sends no code when its attempt cannot save, and never retries a response whose key could not save', async () => {
    const f = await fixture(); f.pause(); const write = fs.writeFileSync.bind(fs); let writes = 0;
    let fault = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => { if (String(file).includes('gateway-secrets.json')) throw new Error('PRIVATE_DISK'); return write(file, ...args); });
    await expect(f.start()).rejects.toThrow('local storage'); fault.mockRestore(); expect(f.calls()).toBe(0); expect(whatsAppSetup(f.instance.id).pending).toBeNull();
    fault = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => { if (String(file).includes('gateway-secrets.json') && ++writes > 1) throw new Error('PRIVATE_DISK'); return write(file, ...args); });
    await expect(f.start()).rejects.toThrow('local storage'); fault.mockRestore(); expect(f.calls()).toBe(1); expect(whatsAppSetup(f.instance.id).pending!.phase).toBe('requesting');
    await expect(f.start()).rejects.toThrow('changed'); expect(f.calls()).toBe(1);
  });

  it('keeps a replacement gap held and preserves its received key when another tab enables the instance', async () => {
    const f = await fixture(); f.pause();
    await replaceWhatsAppPairing(f.inbox, f.body(), { request: async (url, init) => { const response = await f.request(url, init); saveGatewayInstance(f.config, f.instance.id); return response; } });
    expect(whatsAppSetup(f.instance.id).pending!.phase).toBe('received'); expect(() => f.finish()).toThrow('Pause'); f.pause(); f.finish();
    const next = await fixture(); next.pause(); Object.assign(next.status, { gap: { at: Date.now(), through: 2 } }); await next.start(); next.finish();
    expect(next.inbox.whatsAppRelayState()!.recovery!.reason).toBe('gap'); expect(getGatewayInstance(next.instance.id).enabled).toBe(false);
  });

  it('requires exclusive supervisor ownership and retains partial setup gates', async () => {
    const f = await fixture(); f.pause(); const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop());
    await expect(supervisor.replaceWhatsAppPairing(f.instance.id, f.body())).rejects.toThrow('claim'); await f.start();
    expect(() => saveGatewayCredentials(f.instance.id, { accessToken: 'replacement' })).toThrow('pending'); expect(() => reviewWhatsAppPairing(f.inbox, { revision: whatsAppSetup(f.instance.id).pending!.revision, acknowledgeRemoteRevoked: true })).toThrow('unknown');
  });

  it('does not accept a previously archived epoch or discard the bounded replacement history', async () => {
    const f = await fixture(); f.pause(); await f.start(); f.finish(); f.status.epoch = EPOCH; await expect(f.start()).rejects.toThrow('not new');
    const pending = whatsAppSetup(f.instance.id).pending!; reviewWhatsAppPairing(f.inbox, { revision: pending.revision, acknowledgeRemoteRevoked: true });
    const journal = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal; const archive = journal.whatsappRetired![0];
    journal.whatsappRetired = Array.from({ length: 100 }, () => ({ ...archive, attemptId: crypto.randomUUID(), state: { ...archive.state, epoch: crypto.randomUUID(), connection: undefined } }));
    fs.writeFileSync(f.state.inboxFile(), JSON.stringify(journal)); expect(gatewayWhatsAppReplacement(f.instance.id).revision).toBeNull(); await expect(f.start({ ...f.body(), revision: 'a'.repeat(64) })).rejects.toThrow();
    expect((JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal).whatsappRetired).toHaveLength(100);
  });

  it('refuses tampering with archived confirmation or epoch ownership', async () => {
    const f = await fixture(); await expect(f.receive('pending', { confirmed: false })).rejects.toThrow(); f.pause(); await f.start(); f.finish();
    const file = f.state.inboxFile(); const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as GatewayInboxJournal;
    journal.events[0].relay!.confirmed = true; fs.writeFileSync(file, JSON.stringify(journal)); expect(() => f.inbox.list()).toThrow('relay receipts');
  });
});
