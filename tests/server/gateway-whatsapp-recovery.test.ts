import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayInboxJournal, GatewayWhatsAppRelayStatus } from '../../shared/types.ts';
import { getGatewaySecrets, setGatewaySecrets } from '../../server/store.ts';
import { saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayInbox, gatewayInboxHistory, gatewayWhatsAppRecovery } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { WhatsAppRelayIntake } from '../../server/gateways/whatsapp-intake.ts';
import { inspectWhatsAppRecovery, reviewWhatsAppRecovery } from '../../server/gateways/whatsapp-recovery.ts';
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
  return { config, instance, state, inbox, remote, calls, request, preview, body, accept, gap, reviewed, pause, inspect, review };
}

describe('explicit WhatsApp relay-gap recovery', () => {
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
    await expect(f.inspect()).rejects.toThrow('cannot clear'); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before); expect(f.preview()).toEqual({ reason, gap: null });
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
