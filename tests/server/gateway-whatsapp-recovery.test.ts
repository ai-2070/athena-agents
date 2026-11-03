import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayInboxJournal, GatewayWhatsAppRelayStatus } from '../../shared/types.ts';
import { getGatewaySecrets, setGatewaySecrets } from '../../server/store.ts';
import { getGatewayInstance, saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayInbox, gatewayInboxHistory, gatewayRequestReview, gatewayWhatsAppRecovery } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { WhatsAppRelayIntake } from '../../server/gateways/whatsapp-intake.ts';
import { WhatsAppIdentities } from '../../server/gateways/whatsapp-identities.ts';
import { inspectWhatsAppRecovery, restoreWhatsAppRecovery, reviewWhatsAppRecovery } from '../../server/gateways/whatsapp-recovery.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { gatewayConfig } from './gateway-fixtures.ts';

const ORIGIN = 'https://private-relay.example'; const BUSINESS = '9000000001'; const TOKEN = 'a'.repeat(64); const SECRET = 'PRIVATE_META_APP_SECRET';
const EPOCH = '00000000-0000-4000-8000-000000000001'; const INSTALLATION = '00000000-0000-4000-8000-000000000002';
const limits = { bodyBytes: 1048576, queueBytes: 16777216, queueEvents: 1000, replayEntries: 10000, retentionMs: 259200000, replayMs: 604800000, pairingMs: 600000, leaseMs: 60000, batchBytes: 2097152, batchEvents: 20 };
const closes: (() => Promise<void>)[] = []; let accounts = 9600000000;
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });
async function fixture() {
  const config = { ...gatewayConfig(String(accounts++)), name: 'WhatsApp recovery', platform: 'whatsapp',
    senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436641234567', '+436649876543'] }, scope: { directMessages: true, conversationIds: [], guildIds: [] } };
  const instance = saveGatewayInstance(config); saveGatewayCredentials(instance.id, { relayKey: TOKEN, signingSecret: SECRET });
  const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect()); const inbox = new GatewayInbox(state);
  const connection = { origin: ORIGIN, installationId: INSTALLATION, businessAccountId: BUSINESS, phoneNumberId: instance.accountId, epoch: EPOCH };
  inbox.bindWhatsAppRelayConnection(connection, 0); const intake = new WhatsAppRelayIntake(instance.id, inbox, BUSINESS, SECRET);
  const remote: GatewayWhatsAppRelayStatus = { version: 1, installationId: INSTALLATION, businessAccountId: BUSINESS, phoneNumberId: instance.accountId, epoch: EPOCH, cursor: 0, gap: null, limits, queuedBytes: 0, queuedEvents: 0 };
  const calls: string[] = [];
  const request = async (url: string, init: RequestInit) => {
    calls.push(url); expect(url).toBe(`${ORIGIN}/v1/status`); expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`); expect(init.body).toBeUndefined(); return Response.json(remote);
  };
  const preview = () => gatewayWhatsAppRecovery(instance.id);
  const body = () => ({ revision: preview().gap!.revision, acknowledgeGap: true });
  async function accept(id: string, confirmed = true, actor = '436641234567') {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: BUSINESS, changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { phone_number_id: instance.accountId }, messages: [{ id, from: actor, from_user_id: actor === '436641234567' ? 'US.ALICE' : 'US.BOB', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: id } }],
    } }] }] });
    const bodyBase64 = Buffer.from(raw).toString('base64'); const sequence = inbox.whatsAppRelayState()!.cursor + 1;
    return intake.receive(EPOCH, { sequence, id: crypto.createHash('sha256').update(bodyBase64).digest('hex'), receivedAt: Date.now(), expiresAt: Date.now() + 60000, bodyBase64,
      signature: 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex'), contentType: 'application/json' }, async (proof) => {
      if (!confirmed) throw new Error('Lost ACK'); remote.cursor = proof.sequence; return { epoch: EPOCH, cursor: proof.sequence };
    });
  }
  function gap(through = inbox.whatsAppRelayState()!.cursor + 2) { remote.gap = { at: Date.now(), through }; }
  function reviewed() { remote.cursor = remote.gap!.through; remote.gap = null; }
  const pause = () => saveGatewayInstance({ ...config, enabled: false }, instance.id);
  const inspect = () => inspectWhatsAppRecovery(inbox, { request });
  const review = (value: unknown = body()) => reviewWhatsAppRecovery(inbox, value, { request });
  const restoreBody = () => ({ revision: preview().restoration!.revision, acknowledgeRestore: true });
  const restore = (value: unknown = restoreBody()) => restoreWhatsAppRecovery(inbox, value, { request });
  return { config, instance, state, inbox, remote, calls, request, preview, body, accept, gap, reviewed, pause, inspect, review, restoreBody, restore };
}

describe('explicit WhatsApp relay-gap recovery', () => {
  it('allows explicit dismissal of abandoned unstarted requests only after gap review, then admits fresh work in that conversation', async () => {
    const f = await fixture(); await expect(f.accept('wamid.pending', false)).rejects.toThrow(); f.pause();
    const event = f.inbox.list()[0]; f.inbox.review(event.id); expect(gatewayRequestReview(f.instance.id, event.id).canDismiss).toBe(false);
    f.gap(2); await f.inspect(); expect(gatewayRequestReview(f.instance.id, event.id).canDismiss).toBe(false); f.reviewed(); await f.review();
    const preview = gatewayRequestReview(f.instance.id, event.id); expect(preview.canDismiss).toBe(true); f.inbox.dismissRequest(event.id, { revision: preview.revision, acknowledgeDismiss: true });
    expect(f.inbox.list()[0].relay!.confirmed).toBe(false); saveGatewayInstance(f.config, f.instance.id); await f.accept('wamid.fresh');
    expect(f.inbox.claimNext()!.input.sourceMessageId).toBe('wamid.fresh'); expect(f.inbox.list()[0].operationId).toBeUndefined();
  });
  it('observes a gap, requires the exact remote review, preserves work and mappings, and resumes only fresh intake', async () => {
    const f = await fixture(); await f.accept('wamid.old'); f.pause(); f.gap();
    expect(f.preview()).toEqual({ reason: null, gap: null }); const seen = await f.inspect();
    expect(seen).toMatchObject({ reason: 'gap', gap: { at: f.remote.gap!.at, revision: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(JSON.stringify(seen)).not.toContain(ORIGIN); expect(JSON.stringify(seen)).not.toContain(TOKEN); expect(JSON.stringify(seen)).not.toContain('cursor');
    const work = structuredClone(f.inbox.list()); const identities = structuredClone(f.inbox.whatsAppRelayState()!.identities);
    await expect(f.review()).rejects.toThrow('relay first'); expect(f.inbox.whatsAppRelayState()!.cursor).toBe(1);
    f.reviewed(); const body = f.body(); await f.state.disconnect(); await f.state.connect(); expect(f.preview().gap!.revision).toBe(body.revision);
    expect(await f.review(body)).toEqual({ reason: null, gap: null }); expect(f.inbox.list()).toEqual(work); expect(f.inbox.whatsAppRelayState()!.identities).toEqual(identities);
    expect(f.inbox.whatsAppRelayState()!.reviewedGaps).toEqual([expect.objectContaining({ from: 1, through: 3, revision: body.revision, receipt: { ...work[0].relay, accepted: 1, ignored: 0, unmatchedSenders: 0 } })]);
    expect(f.inbox.whatsAppRelayState()!.cursor).toBe(3); expect(f.inbox.whatsAppRelayState()!.receipt).toBeUndefined();
    saveGatewayInstance(f.config, f.instance.id); expect(f.inbox.claimNext()).toBeNull(); await f.accept('wamid.fresh');
    expect(f.inbox.list()[1]).toMatchObject({ status: 'queued', relay: { confirmed: true } }); expect(f.inbox.claimNext()).toBeNull();
    await f.accept('wamid.other', true, '436649876543'); expect(f.inbox.claimNext()!.input.sourceMessageId).toBe('wamid.other'); expect(f.inbox.claimNext()).toBeNull();
    expect(f.calls.every((url) => url === `${ORIGIN}/v1/status`)).toBe(true);
  });

  it.each([false, true])('retains an unconfirmed envelope when its remote ACK had committed: %s', async (committed) => {
    const f = await fixture(); await f.accept('wamid.confirmed'); await expect(f.accept('wamid.pending', false)).rejects.toThrow('Lost ACK');
    if (committed) f.remote.cursor = 2; f.pause(); f.gap(4); await f.inspect(); f.reviewed(); await f.review();
    const pending = f.inbox.list()[1]; expect(pending.status).toBe('needs-review'); expect(pending.relay!.confirmed).toBe(false);
    expect(f.inbox.whatsAppRelayState()!.reviewedGaps![0].receipt).toMatchObject({ sequence: 2, confirmed: false });
    saveGatewayInstance(f.config, f.instance.id); expect(() => f.inbox.checkAccess(pending)).toThrow('acknowledgement'); await f.accept('wamid.fresh');
    expect(f.inbox.list()[2]).toMatchObject({ status: 'queued', relay: { confirmed: true } }); expect(f.inbox.claimNext()).toBeNull(); expect(f.inbox.list()[1].relay!.confirmed).toBe(false);
    await f.state.disconnect(); await f.state.connect(); expect(gatewayInboxHistory(f.instance.id)[1].relay!.confirmed).toBe(false);
  });

  it('cannot forge confirmation of an abandoned receipt after a later valid message', async () => {
    const f = await fixture(); await expect(f.accept('wamid.pending', false)).rejects.toThrow(); f.pause(); f.gap(2); await f.inspect(); f.reviewed(); await f.review();
    saveGatewayInstance(f.config, f.instance.id); await f.accept('wamid.fresh'); const file = f.state.inboxFile(); const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as GatewayInboxJournal;
    journal.events[0].relay!.confirmed = true; fs.writeFileSync(file, JSON.stringify(journal)); expect(() => f.inbox.list()).toThrow('relay receipts'); expect(() => gatewayInboxHistory(f.instance.id)).toThrow('unreadable');
  });

  it('keeps a sent reply prefix and turns interrupted sends uncertain before recording the gap', async () => {
    const f = await fixture(); await f.accept('wamid.work'); const claimed = f.inbox.claimNext()!;
    f.inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, new AbortController().signal)); f.inbox.finishDispatch(claimed.id, claimed.operationId!, 'x'.repeat(6500));
    f.inbox.claimReply(); f.inbox.settleReply(claimed.id, 0, { remoteId: 'confirmed-prefix' }); f.inbox.claimReply(); f.pause(); f.gap(); await f.inspect();
    const before = structuredClone(f.inbox.list()); expect(before[0].reply!.parts.map((part) => part.status)).toEqual(['sent', 'uncertain', 'failed']);
    f.reviewed(); await f.review(); expect(f.inbox.list()).toEqual(before);
  });

  it('rejects stale revisions, missing acknowledgements and replayed submissions without a remote request', async () => {
    const f = await fixture(); f.pause(); f.gap(); await f.inspect(); const body = f.body(); const count = f.calls.length;
    for (const value of [{}, { revision: body.revision }, { ...body, acknowledgeGap: false }, { ...body, revision: '0'.repeat(64) }, { ...body, extra: 'invented' }]) await expect(f.review(value)).rejects.toThrow('changed');
    expect(f.calls).toHaveLength(count); saveGatewayInstance({ ...f.config, enabled: false, name: 'Renamed' }, f.instance.id);
    await expect(f.review(body)).rejects.toThrow('changed'); f.reviewed(); const current = f.body(); await f.review(current); await expect(f.review(current)).rejects.toThrow('changed');
  });

  it.each(['installationId', 'phoneNumberId', 'businessAccountId', 'epoch'])('refuses changed %s without clearing a hold or rebinding', async (field) => {
    const f = await fixture(); f.pause(); f.gap(); await f.inspect(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); f.reviewed();
    Object.assign(f.remote, { [field]: field === 'epoch' || field === 'installationId' ? crypto.randomUUID() : '999' });
    await expect(f.review()).rejects.toThrow('identity'); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
  });

  it.each(['cursor', 'envelope', 'epoch', 'installation'] as const)('cannot clear a %s hold through a gap acknowledgement', async (reason) => {
    const f = await fixture(); f.inbox.holdWhatsAppRelay(reason); f.pause(); f.gap(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    await expect(f.inspect()).rejects.toThrow('cannot clear'); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before); expect(f.preview()).toMatchObject({ reason, gap: null, restoration: { revision: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  });

  it('refuses an already skipped cursor without a saved gap observation and never guesses a gap range', async () => {
    const f = await fixture(); f.pause(); f.inbox.holdWhatsAppRelay('gap'); f.remote.cursor = 4;
    await expect(f.inspect()).rejects.toThrow('No matching saved gap'); f.gap(5); await expect(f.inspect()).rejects.toThrow('cursor does not match'); expect(f.preview().gap).toBeNull();
  });

  it('refuses a different cleared cursor or a new gap until a new observation is reviewed', async () => {
    const f = await fixture(); f.pause(); f.gap(3); await f.inspect(); f.reviewed(); f.remote.cursor = 4;
    await expect(f.review()).rejects.toThrow('exact gap'); f.remote.cursor = 0; f.gap(5); await expect(f.review()).rejects.toThrow('exact gap');
    const old = f.body(); await f.inspect(); await expect(f.review(old)).rejects.toThrow('changed'); f.reviewed(); await f.review(); expect(f.inbox.whatsAppRelayState()!.cursor).toBe(5);
  });

  it('retains consecutive gap reviews when there are no intervening messages', async () => {
    const f = await fixture(); f.pause(); f.gap(2); await f.inspect(); f.reviewed(); await f.review(); f.gap(4); await f.inspect(); f.reviewed(); await f.review();
    expect(f.inbox.whatsAppRelayState()!.reviewedGaps!.map((review) => [review.from, review.through])).toEqual([[0, 2], [2, 4]]);
    await f.state.disconnect(); await f.state.connect(); expect(f.inbox.whatsAppRelayState()!.cursor).toBe(4);
  });

  it('retains all review history and refuses another gap when the bounded history is full', async () => {
    const f = await fixture(); const journal = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal;
    journal.whatsappRelay!.cursor = 1000; journal.whatsappRelay!.reviewedGaps = Array.from({ length: 1000 }, (_, index) => ({ at: index, gapAt: index, from: index, through: index + 1, revision: crypto.createHash('sha256').update(String(index)).digest('hex') }));
    fs.writeFileSync(f.state.inboxFile(), JSON.stringify(journal)); f.pause(); f.remote.cursor = 1000; f.gap(1002);
    await expect(f.inspect()).rejects.toThrow('need attention'); expect(f.inbox.whatsAppRelayState()!.reviewedGaps).toHaveLength(1000);
  });

  it('does not mutate the cursor or audit when the final local save fails', async () => {
    const f = await fixture(); f.pause(); f.gap(); await f.inspect(); f.reviewed(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); const write = fs.writeFileSync.bind(fs);
    const fault = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => { if (String(file).includes('inbox.json')) throw new Error('PRIVATE_DISK'); return write(file, ...args); });
    await expect(f.review()).rejects.toThrow('local storage'); fault.mockRestore(); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before); await f.review();
  });

  it.each(['401', '429', '503', '202', 'redirect', 'length', 'bytes', 'json', 'utf8'])('keeps the held gap when the status response is %s', async (kind) => {
    const f = await fixture(); f.pause(); f.gap(); await f.inspect(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    await expect(reviewWhatsAppRecovery(f.inbox, f.body(), { request: async () => {
      if (/^\d+$/.test(kind)) return Response.json({ error: 'PRIVATE_PROVIDER' }, { status: Number(kind) });
      if (kind === 'redirect') return Response.redirect('https://steal.example/PRIVATE');
      return new Response(kind === 'utf8' ? Buffer.from([255]) : kind === 'bytes' ? 'x'.repeat(65537) : 'PRIVATE_JSON', { headers: { 'content-type': 'application/json', ...(kind === 'length' ? { 'content-length': '65537' } : {}) } });
    } })).rejects.toThrow('could not be verified'); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
  });

  it('rejects enabled or partly paired instances before I/O and rechecks pause after the response', async () => {
    const f = await fixture(); f.gap(); await expect(f.inspect()).rejects.toThrow('Pause'); expect(f.calls).toEqual([]); f.pause();
    const secrets = getGatewaySecrets(f.instance.id); setGatewaySecrets(f.instance.id, { ...secrets, whatsappPairing: { phase: 'received', attemptId: crypto.randomUUID(), connection: f.inbox.whatsAppRelayState()!.connection!, cursor: 0, gap: false } });
    await expect(f.inspect()).rejects.toThrow('fully paired'); setGatewaySecrets(f.instance.id, secrets);
    await expect(inspectWhatsAppRecovery(f.inbox, { request: async () => { saveGatewayInstance(f.config, f.instance.id); return Response.json(f.remote); } })).rejects.toThrow('Pause'); expect(f.preview().gap).toBeNull();
  });

  it('bounds stalled requests and body reads without changing the held gap', async () => {
    for (const stream of [false, true]) {
      const f = await fixture(); f.pause(); f.gap(); await f.inspect(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); let cancelled = false;
      await expect(reviewWhatsAppRecovery(f.inbox, f.body(), { timeoutMs: 10, request: async () => stream ? new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('{')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) : new Promise<Response>(() => {}) })).rejects.toThrow('could not be verified');
      expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before); if (stream) expect(cancelled).toBe(true);
    }
  });

  it('requires supervisor ownership and stays paused without making requests when another owner exists', async () => {
    const f = await fixture(); f.pause(); const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop());
    await expect(supervisor.inspectWhatsAppRecovery(f.instance.id)).rejects.toThrow('claim'); expect(f.calls).toEqual([]);
  });
});

describe('explicit restoration of the original WhatsApp relay', () => {
  it.each(['cursor', 'epoch', 'installation', 'envelope'] as const)('clears only the %s connection hold after the original binding and cursor match', async (reason) => {
    const f = await fixture(); await f.accept('wamid.held'); f.inbox.holdWhatsAppRelay(reason); f.pause();
    const events = structuredClone(f.inbox.list()); const saved = structuredClone(f.inbox.whatsAppRelayState()!); const secrets = getGatewaySecrets(f.instance.id); const body = f.restoreBody();
    const safe = JSON.stringify(f.preview()); for (const value of [ORIGIN, TOKEN, BUSINESS, EPOCH, INSTALLATION, 'cursor']) if (value !== reason) expect(safe).not.toContain(value);
    await f.state.disconnect(); await f.state.connect(); expect(f.restoreBody()).toEqual(body);
    expect(await f.restore(body)).toEqual({ reason: null, gap: null }); expect(f.inbox.list()).toEqual(events); expect(getGatewaySecrets(f.instance.id)).toEqual(secrets);
    const restored = f.inbox.whatsAppRelayState()!;
    expect(restored).toEqual({ ...saved, recovery: undefined, restorations: [{ at: expect.any(Number), heldAt: saved.recovery!.at, reason, revision: body.revision, remoteCursor: 1 }] });
    expect(f.calls).toEqual([`${ORIGIN}/v1/status`]); expect(f.inbox.claimNext()).toBeNull(); expect(getGatewayInstance(f.instance.id).enabled).toBe(false);
    await expect(f.restore(body)).rejects.toThrow('changed'); expect(f.calls).toHaveLength(1);
  });

  it.each([0, 1])('never confirms or advances a pending ACK when the restored cursor is %s', async (cursor) => {
    const f = await fixture(); await expect(f.accept('wamid.pending', false)).rejects.toThrow('Lost ACK'); f.inbox.holdWhatsAppRelay('cursor'); f.pause(); f.remote.cursor = cursor;
    const before = structuredClone(f.inbox.whatsAppRelayState()!); await f.restore();
    expect(f.inbox.whatsAppRelayState()).toMatchObject({ cursor: 0, receipt: before.receipt, identities: before.identities });
    expect(f.inbox.list()[0]).toMatchObject({ status: 'needs-review', relay: { confirmed: false } }); expect(f.inbox.claimNext()).toBeNull();
  });

  it.each(['installationId', 'businessAccountId', 'phoneNumberId', 'epoch', 'cursor', 'gap'] as const)('refuses a still-changed %s and leaves saved data untouched', async (field) => {
    const f = await fixture(); await f.accept('wamid.old'); f.inbox.holdWhatsAppRelay('installation'); f.pause();
    Object.assign(f.remote, { [field]: field === 'gap' ? { at: Date.now(), through: 4 } : field === 'cursor' ? 9 : field === 'epoch' || field === 'installationId' ? crypto.randomUUID() : '999' });
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); await expect(f.restore()).rejects.toThrow(); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
  });

  it('preserves sent prefixes and uncertain deliveries instead of retrying them', async () => {
    const f = await fixture(); await f.accept('wamid.reply'); const event = f.inbox.claimNext()!;
    f.inbox.beginDispatch(event.id, event.operationId!, await gatewayConversation(event, new AbortController().signal)); f.inbox.finishDispatch(event.id, event.operationId!, 'x'.repeat(6500));
    f.inbox.claimReply(); f.inbox.settleReply(event.id, 0, { remoteId: 'sent-prefix' }); f.inbox.claimReply(); f.inbox.recover();
    f.inbox.holdWhatsAppRelay('epoch'); f.pause(); const before = structuredClone(f.inbox.list()); await f.restore();
    expect(f.inbox.list()).toEqual(before); expect(f.inbox.list()[0].reply!.parts.map((part) => part.status)).toEqual(['sent', 'uncertain', 'failed']);
  });

  it('never restores a retired sender alias or its earlier work when the relay returns', async () => {
    const f = await fixture(); await f.accept('wamid.retired');
    const identities = new WhatsAppIdentities(BUSINESS, f.inbox.whatsAppRelayState()!.identities); identities.rotate('US.ALICE', 'US.NEW', null, Date.now());
    const receipt = { epoch: EPOCH, sequence: 2, id: 'c'.repeat(64) }; f.inbox.acceptWhatsAppRelay(receipt, [], 1, 0, identities.state); f.inbox.confirmWhatsAppRelay(receipt); f.remote.cursor = 2;
    f.inbox.holdWhatsAppRelay('installation'); f.pause(); const saved = structuredClone(f.inbox.whatsAppRelayState()!.identities); await f.restore();
    expect(f.inbox.whatsAppRelayState()!.identities).toEqual(saved); saveGatewayInstance(f.config, f.instance.id);
    expect(() => f.inbox.checkAccess(f.inbox.list()[0])).toThrow('identity changed');
    expect(await f.accept('wamid.old-alias-again')).toMatchObject({ accepted: 0, ignored: 1, unmatchedSenders: 1 }); expect(f.inbox.list()).toHaveLength(1); expect(f.inbox.claimNext()).toBeNull();
  });

  it('rejects missing acknowledgement, stale work or settings, and replayed submissions before I/O', async () => {
    const f = await fixture(); await f.accept('wamid.held'); f.inbox.holdWhatsAppRelay('envelope'); f.pause(); const body = f.restoreBody();
    for (const value of [{}, { revision: body.revision }, { ...body, acknowledgeRestore: false }, { ...body, revision: '0'.repeat(64) }, { ...body, reset: true }]) await expect(f.restore(value)).rejects.toThrow('changed');
    f.inbox.review(f.inbox.list()[0].id, 'Review changed work'); await expect(f.restore(body)).rejects.toThrow('changed'); const current = f.restoreBody();
    saveGatewayInstance({ ...f.config, enabled: false, name: 'Changed name' }, f.instance.id); await expect(f.restore(current)).rejects.toThrow('changed'); expect(f.calls).toEqual([]);
  });

  it.each(['settings', 'credentials', 'receipt', 'work'] as const)('refuses a %s change while checking the restored relay', async (kind) => {
    const f = await fixture(); await f.accept('wamid.held'); f.inbox.holdWhatsAppRelay('cursor'); f.pause(); const body = f.restoreBody();
    await expect(restoreWhatsAppRecovery(f.inbox, body, { request: async () => {
      if (kind === 'settings') saveGatewayInstance({ ...f.config, enabled: false, name: 'Changed' }, f.instance.id);
      else if (kind === 'credentials') setGatewaySecrets(f.instance.id, { relayKey: 'b'.repeat(64), signingSecret: SECRET });
      else if (kind === 'receipt') { const journal = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal; journal.whatsappRelay!.restorations = [{ at: 1, heldAt: 1, reason: 'cursor', revision: 'a'.repeat(64), remoteCursor: 0 }]; fs.writeFileSync(f.state.inboxFile(), JSON.stringify(journal)); }
      else f.inbox.review(f.inbox.list()[0].id, 'Updated work review');
      return Response.json(f.remote);
    } })).rejects.toThrow(); expect(f.preview().reason).toBe('cursor');
  });

  it('keeps gap recovery and unheld instances out of restoration before I/O', async () => {
    const f = await fixture(); f.pause(); await expect(f.restore({ revision: 'a'.repeat(64), acknowledgeRestore: true })).rejects.toThrow('changed');
    f.inbox.holdWhatsAppRelay('gap'); await expect(f.restore({ revision: 'a'.repeat(64), acknowledgeRestore: true })).rejects.toThrow('changed'); expect(f.calls).toEqual([]);
  });

  it('refuses enabled and partly saved setup, and requires exclusive ownership', async () => {
    const f = await fixture(); f.inbox.holdWhatsAppRelay('installation'); await expect(f.restore()).rejects.toThrow('Pause'); f.pause();
    setGatewaySecrets(f.instance.id, { ...getGatewaySecrets(f.instance.id), whatsappPairing: { phase: 'requesting', attemptId: crypto.randomUUID(), origin: ORIGIN, businessAccountId: BUSINESS, phoneNumberId: f.instance.accountId } });
    await expect(f.restore()).rejects.toThrow('fully paired'); expect(f.calls).toEqual([]);
    const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop()); await expect(supervisor.restoreWhatsAppRecovery(f.instance.id, f.restoreBody())).rejects.toThrow('claim');
  });

  it('keeps the hold when its atomic save fails', async () => {
    const f = await fixture(); f.inbox.holdWhatsAppRelay('envelope'); f.pause(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); const write = fs.writeFileSync.bind(fs);
    const fault = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => { if (String(file).includes('inbox.json')) throw new Error('PRIVATE_DISK'); return write(file, ...args); });
    await expect(f.restore()).rejects.toThrow('local storage'); fault.mockRestore(); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before); await f.restore();
  });

  it('keeps its bounded restoration audit instead of evicting older reviews', async () => {
    const f = await fixture(); f.inbox.holdWhatsAppRelay('envelope'); f.pause(); const journal = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal;
    journal.whatsappRelay!.restorations = Array.from({ length: 1000 }, (_, index) => ({ at: index, heldAt: index, reason: 'envelope', revision: crypto.createHash('sha256').update(String(index)).digest('hex'), remoteCursor: 0 }));
    fs.writeFileSync(f.state.inboxFile(), JSON.stringify(journal)); const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    await expect(f.restore()).rejects.toThrow('history needs attention'); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
  });
});
