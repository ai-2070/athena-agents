import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayInboxJournal } from '../../shared/types.ts';
import { getGatewaySecrets, setGatewaySecrets } from '../../server/store.ts';
import { GatewayInbox, gatewayRequestReview, gatewayWhatsAppSenders } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { getGatewayInstance, saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { WhatsAppRelayIntake } from '../../server/gateways/whatsapp-intake.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { gatewayConfig } from './gateway-fixtures.ts';

const PHONE = '+436641234567'; const OTHER = '+436649876543'; const BUSINESS = '9000000001'; const SECRET = 'PRIVATE_META_APP_SECRET';
const EPOCH = '00000000-0000-4000-8000-000000000001'; const OLD = 'US.PRIVATE_OLD'; const NEXT = 'US.PRIVATE_NEW';
const closes: (() => Promise<void>)[] = []; let accounts = 9900000000;
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });
async function fixture(options: { proof?: boolean; confirmed?: boolean } = {}) {
  const config = { ...gatewayConfig(String(accounts++)), name: 'WhatsApp senders', platform: 'whatsapp', enabled: true,
    senderPolicy: { platform: 'whatsapp', allowedPhones: [PHONE] }, scope: { directMessages: true, conversationIds: [], guildIds: [] } };
  const instance = saveGatewayInstance(config); saveGatewayCredentials(instance.id, { relayKey: 'a'.repeat(64), accessToken: 'PRIVATE_META_TOKEN', signingSecret: SECRET });
  const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect()); const inbox = new GatewayInbox(state);
  inbox.bindWhatsAppRelayConnection({ origin: 'https://private-relay.example', installationId: crypto.randomUUID(), businessAccountId: BUSINESS, phoneNumberId: instance.accountId, epoch: EPOCH }, 0);
  const intake = new WhatsAppRelayIntake(instance.id, inbox, BUSINESS, SECRET); const base = Math.floor(Date.now() / 1000) * 1000 - 10000;
  async function receive(messages: unknown[], at = base, update = false, confirmed = true) {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: BUSINESS, changes: [{ field: update ? 'user_id_update' : 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: instance.accountId }, [update ? 'user_id_update' : 'messages']: messages,
    } }] }] });
    const bodyBase64 = Buffer.from(raw).toString('base64'); const relay = inbox.whatsAppRelayState()!;
    return intake.receive(relay.epoch, { sequence: relay.cursor + 1, id: crypto.createHash('sha256').update(bodyBase64).digest('hex'), receivedAt: Math.max(Date.now(), at), expiresAt: Math.max(Date.now(), at) + 60000,
      bodyBase64, signature: 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'), contentType: 'application/json' }, async (proof) => {
      if (!confirmed) throw new Error('Lost ACK'); return { epoch: proof.epoch, cursor: proof.sequence };
    });
  }
  const message = (id: string, user = NEXT, at = Date.now(), phone = PHONE) => ({ id, from: phone.slice(1), from_user_id: user, timestamp: String(Math.floor(at / 1000)), type: 'text', text: { body: id } });
  await receive([message('old-request', OLD, base)]);
  const rotate = (previous = OLD, current = NEXT, at = base + 2000, phone: string | undefined = options.proof === false ? undefined : PHONE) => receive([{ timestamp: String(Math.floor(at / 1000)), user_id: { previous, current }, ...(phone ? { wa_id: phone.slice(1) } : {}) }], at, true, options.confirmed !== false);
  if (options.confirmed === false) await expect(rotate()).rejects.toThrow('Lost ACK'); else await rotate();
  const pause = () => saveGatewayInstance({ ...config, enabled: false }, instance.id);
  const preview = () => gatewayWhatsAppSenders(instance.id);
  const body = (phone = PHONE) => ({ phone, revision: preview().senders.find((item) => item.phone === phone)?.revision, acknowledgeNewConversation: true });
  return { config, instance, state, inbox, intake, base, message, receive, rotate, pause, preview, body, review: (value: unknown = body()) => inbox.reviewWhatsAppSender(value) };
}

describe('explicit WhatsApp sender identity review', () => {
  it('shows safe local status and starts only fresh work in a separate conversation after review', async () => {
    const f = await fixture(); f.pause(); const old = structuredClone(f.inbox.list()[0]); const identities = structuredClone(f.inbox.whatsAppRelayState()!.identities); const receipt = structuredClone(f.inbox.whatsAppRelayState()!.receipt);
    const text = JSON.stringify(f.preview()); for (const value of [OLD, NEXT, BUSINESS, SECRET, EPOCH, 'private-relay', 'PRIVATE_META_TOKEN', 'a'.repeat(64)]) expect(text).not.toContain(value);
    expect(f.preview()).toMatchObject({ reason: '', retired: 1, waiting: 0, unallowed: 0, senders: [{ phone: PHONE, status: 'needs-review', requests: 1 }] });
    const body = f.body(); await f.state.disconnect(); await f.state.connect(); expect(f.body()).toEqual(body);
    const result = f.review(body); expect(result.senders[0]).toMatchObject({ status: 'reviewed', revision: null });
    expect(f.inbox.whatsAppRelayState()).toMatchObject({ cursor: 2, identities, receipt, senderReviews: [{ at: expect.any(Number), throughSequence: 1, phone: PHONE, revision: body.revision, identityKey: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    expect(f.inbox.list()[0]).toMatchObject({ id: old.id, route: old.route, bindingId: old.bindingId, relay: old.relay, status: 'needs-review' }); expect(getGatewayInstance(f.instance.id).enabled).toBe(false);
    saveGatewayInstance(f.config, f.instance.id); expect(() => f.inbox.checkAccess(old)).toThrow('predates'); const at = f.inbox.whatsAppRelayState()!.senderReviews![0].at;
    expect(await f.receive([f.message('delayed', NEXT, at)])).toMatchObject({ accepted: 0 });
    await f.receive([f.message('fresh', NEXT, at + 2000)]); const fresh = f.inbox.claimNext()!; expect(fresh.input.sourceMessageId).toBe('fresh'); expect(fresh.bindingId).not.toBe(old.bindingId); expect(fresh.route).toEqual(old.route);
    expect(f.preview().senders[0].status).toBe('reviewed'); expect(f.inbox.list()).toHaveLength(2);
  });

  it('never revives a retired alias or accepts a phone typed into the review', async () => {
    const f = await fixture({ proof: false }); f.pause(); expect(f.preview()).toMatchObject({ waiting: 1, retired: 1, senders: [{ status: 'needs-proof', revision: null }] });
    expect(() => f.review({ phone: PHONE, revision: '0'.repeat(64), acknowledgeNewConversation: true, userId: OLD })).toThrow('changed');
    saveGatewayInstance(f.config, f.instance.id); expect(await f.receive([f.message('retired', OLD)])).toMatchObject({ accepted: 0 });
    await f.receive([f.message('verified', NEXT)]); f.pause(); f.review(); expect(f.inbox.whatsAppRelayState()!.identities!.users.find((user) => user.id === OLD)!.retired).toBe(true);
  });

  it('requires exact ACK confirmation, pairing and relay recovery before offering a review', async () => {
    const f = await fixture({ confirmed: false }); f.pause(); expect(f.preview().reason).toContain('acknowledgement'); expect(f.preview().senders[0].revision).toBeNull();
    expect(() => f.review({ phone: PHONE, revision: 'a'.repeat(64), acknowledgeNewConversation: true })).toThrow('changed');
    const receipt = f.inbox.whatsAppRelayState()!.receipt!; await f.intake.confirmPending(async (proof) => ({ epoch: proof.epoch, cursor: proof.sequence })); expect(f.inbox.whatsAppRelayState()!.receipt!.id).toBe(receipt.id);
    f.inbox.holdWhatsAppRelay('installation'); expect(f.preview().reason).toContain('recovery');
    const ready = await fixture(); ready.pause(); setGatewaySecrets(ready.instance.id, { ...getGatewaySecrets(ready.instance.id), whatsappPairing: { phase: 'requesting', attemptId: crypto.randomUUID(), origin: 'https://private-relay.example', businessAccountId: BUSINESS, phoneNumberId: ready.instance.accountId } });
    expect(ready.preview().reason).toContain('pending pairing'); expect(ready.preview().senders[0].revision).toBeNull();
    setGatewaySecrets(ready.instance.id, { accessToken: 'PRIVATE_TOKEN', signingSecret: SECRET }); expect(ready.preview().reason).toContain('pull key');
  });

  it('requires pause, allowlisted phone, the current revision and explicit acknowledgement', async () => {
    const f = await fixture(); expect(f.preview().reason).toContain('Pause'); expect(f.preview().senders[0].revision).toBeNull(); f.pause(); const body = f.body();
    for (const value of [{}, { ...body, acknowledgeNewConversation: false }, { ...body, phone: OTHER }, { ...body, revision: '0'.repeat(64) }, { ...body, userId: NEXT }]) expect(() => f.review(value)).toThrow('changed');
    saveGatewayInstance({ ...f.config, enabled: false, senderPolicy: { platform: 'whatsapp', allowedPhones: [] } }, f.instance.id); expect(() => f.review(body)).toThrow('changed'); expect(f.preview().senders).toEqual([]);
  });

  it('rejects stale work or identity proof, double submissions and replayed confirmations', async () => {
    const f = await fixture(); f.pause(); const body = f.body(); f.inbox.review(f.inbox.list()[0].id, 'Changed work'); expect(() => f.review(body)).toThrow('changed');
    const current = f.body(); f.review(current); expect(() => f.review(current)).toThrow('changed'); expect(f.inbox.whatsAppRelayState()!.senderReviews).toHaveLength(1);
    saveGatewayInstance(f.config, f.instance.id); await f.rotate(NEXT, 'US.LATER', Date.now(), PHONE); f.pause(); expect(f.preview().senders[0].status).toBe('needs-review'); expect(() => f.review(current)).toThrow('changed');
  });

  it('keeps native operations and uncertain delivery prefixes held, including input dated ahead of the local clock', async () => {
    const f = await fixture(); await f.receive([f.message('future-request', NEXT, Date.now() + 60000)]); const event = f.inbox.list()[1];
    f.inbox.review(f.inbox.list()[0].id); f.pause(); const oldReview = f.inbox.list()[0]; const { revision } = gatewayRequestReview(f.instance.id, oldReview.id);
    f.inbox.dismissRequest(oldReview.id, { revision, acknowledgeDismiss: true }); saveGatewayInstance(f.config, f.instance.id);
    const claimed = f.inbox.claimNext()!; expect(claimed.id).toBe(event.id); f.inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, new AbortController().signal));
    f.inbox.finishDispatch(claimed.id, claimed.operationId!, 'x'.repeat(6500)); f.inbox.claimReply(); f.inbox.settleReply(claimed.id, 0, { remoteId: 'sent-prefix' }); f.inbox.claimReply(); f.inbox.recover();
    f.pause(); f.review(); const held = f.inbox.list()[1]; expect(held.operationId).toBe(claimed.operationId); expect(held.reply!.parts.map((part) => part.status)).toEqual(['sent', 'uncertain', 'failed']);
    saveGatewayInstance(f.config, f.instance.id); expect(() => f.inbox.retryReply(held.id)).toThrow('predates'); expect(f.inbox.claimReply()).toBeNull();
  });

  it('does not carry sender permission to a new number and reports numbers outside the guard without disclosing them', async () => {
    const f = await fixture(); await f.rotate(NEXT, 'US.OTHER', Date.now(), OTHER); f.pause(); const preview = f.preview();
    expect(preview.unallowed).toBe(1); expect(JSON.stringify(preview)).not.toContain(OTHER); expect(preview.senders[0].status).toBe('needs-proof');
    saveGatewayInstance({ ...f.config, enabled: false, senderPolicy: { platform: 'whatsapp', allowedPhones: [PHONE, OTHER] } }, f.instance.id);
    expect(f.preview().senders[1]).toMatchObject({ phone: OTHER, status: 'verified', revision: null });
  });

  it('keeps other allowed phones in their existing conversations', async () => {
    const f = await fixture(); saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: [PHONE, OTHER] } }, f.instance.id);
    await f.receive([f.message('other-person', 'US.BOB', Date.now(), OTHER)]); const other = structuredClone(f.inbox.list()[1]);
    saveGatewayInstance({ ...f.config, enabled: false, senderPolicy: { platform: 'whatsapp', allowedPhones: [PHONE, OTHER] } }, f.instance.id); f.review();
    expect(f.inbox.list()[1]).toEqual(other); saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: [PHONE, OTHER] } }, f.instance.id);
    expect(f.inbox.claimNext()!.id).toBe(other.id); expect(f.preview().senders[1].status).toBe('verified');
  });

  it('fails atomically when the review cannot save and takes exclusive state/account ownership', async () => {
    const f = await fixture(); f.pause(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); const write = fs.writeFileSync.bind(fs);
    const fault = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => { if (String(file).includes('inbox.json')) throw new Error('PRIVATE_DISK'); return write(file, ...args); });
    expect(() => f.review()).toThrow(); fault.mockRestore(); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
    const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop()); await expect(supervisor.reviewWhatsAppSender(f.instance.id, f.body())).rejects.toThrow('claim');
  });

  it('retains the bounded audit rather than evicting prior sender reviews', async () => {
    const f = await fixture(); f.pause(); const journal = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal;
    journal.whatsappRelay!.senderReviews = Array.from({ length: 1000 }, (_, i) => ({ at: 1, throughSequence: 0, phone: PHONE, identityKey: 'b'.repeat(64), revision: crypto.createHash('sha256').update(String(i)).digest('hex') }));
    fs.writeFileSync(f.state.inboxFile(), JSON.stringify(journal)); expect(f.preview().reason).toContain('history is full'); const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    expect(() => f.review({ phone: PHONE, revision: 'a'.repeat(64), acknowledgeNewConversation: true })).toThrow('changed'); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
  });
});
