import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayInboxJournal, GatewayOutboxJournal } from '../../shared/types.ts';
import { activeProject, outbox, withProject } from '../../server/store.ts';
import { createProject } from '../../server/projects.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { getGatewayInstance, saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayOutboxLedger, gatewayOutboxDeliveryReview, gatewayOutboxProtectedBindings } from '../../server/gateways/outbox.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { GatewayReplies } from '../../server/gateways/replies.ts';
import { projectGatewayPost, readGatewayPostDelivery } from '../../server/gateways/outbox-posts.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

const closes: (() => Promise<void>)[] = []; let accounts = 9558000000;
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const close of closes.splice(0).reverse()) await close(); });
async function fixture(platform: 'telegram' | 'discord' = 'telegram', outcome: 'uncertain' | 'failed' | 'sending' = 'uncertain') {
  const project = activeProject(); const config = { ...gatewayConfig(String(accounts++)), projectId: project.id, platform,
    senderPolicy: { platform, allowedUserIds: ['123'] }, scope: { directMessages: true, conversationIds: [], guildIds: [] } };
  const instance = saveGatewayInstance(config); saveGatewayCredentials(instance.id, { botToken: 'PRIVATE_BOT_TOKEN' });
  const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect()); const inbox = new GatewayInbox(state);
  const input = { ...gatewayInput(), accountId: instance.accountId, platform }; const event = inbox.accept(input)!; const native = inbox.claimNext()!;
  inbox.beginDispatch(event.id, native.operationId!, await gatewayConversation(native, new AbortController().signal)); inbox.finishDispatch(event.id, native.operationId!, 'Private native answer'); inbox.claimReply(); inbox.settleReply(event.id, 0, { remoteId: 'native-reply' });
  const ledger = new GatewayOutboxLedger(state, inbox); const postId = 'approved-post'; const parts = ['Confirmed prefix', 'Uncertain part', 'Queued tail'];
  ledger.approve(ledger.prepare({ instanceId: instance.id, projectId: project.id, eventId: event.id, postId, parts }).approval);
  let claim = ledger.claim()!; ledger.settle(claim, { remoteId: 'confirmed-prefix' }); claim = ledger.claim()!; if (outcome !== 'sending') ledger.settle(claim, { status: outcome });
  const pause = () => saveGatewayInstance({ ...config, enabled: false }, instance.id); pause();
  const view = () => gatewayOutboxDeliveryReview(getGatewayInstance(instance.id), ledger.list()[0]);
  const confirm = (index = 1, remoteId = 'checked-in-app') => ({ action: 'confirm', revision: view().revision, index, remoteId, acknowledgeChecked: true });
  const retry = () => ({ action: 'retry', revision: view().revision, index: view().nextIndex, acknowledgeRemaining: true, acknowledgePossibleDuplicate: true });
  const review = (body: unknown) => ledger.review(project.id, postId, body);
  const mutate = (change: (journal: GatewayOutboxJournal) => void) => { const value = JSON.parse(fs.readFileSync(state.outboxFile(), 'utf8')) as GatewayOutboxJournal; change(value); fs.writeFileSync(state.outboxFile(), JSON.stringify(value)); };
  return { config, instance, project, state, inbox, ledger, input, event, postId, parts, claim, pause, view, confirm, retry, review, mutate };
}

describe('paused Outbox delivery confirmation and retry', () => {
  it.each(['telegram', 'discord'] as const)('records a %s part locally and holds its tail until explicit continuation', async (platform) => {
    const f = await fixture(platform); const native = fs.readFileSync(f.state.inboxFile(), 'utf8'); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const before = f.ledger.list()[0]; const body = f.confirm(); f.review(body);
    expect(f.ledger.list()[0]).toMatchObject({ ...before, receipts: [before.receipts[0], { ...before.receipts[1], status: 'sent', remoteId: 'checked-in-app' }, before.receipts[2]], reviewHeld: true,
      reviews: [{ action: 'confirmed', index: 1, attempt: 1, remoteId: 'checked-in-app', revision: body.revision, at: expect.any(Number) }] });
    expect(f.view()).toMatchObject({ nextIndex: 2, reviewHeld: true, canRetry: true, parts: [{ canConfirm: false }, { confirmedAt: expect.any(Number), canConfirm: false }, { canConfirm: false }] });
    saveGatewayInstance(f.config, f.instance.id); expect(f.ledger.claim()).toBeNull(); f.pause(); f.review(f.retry()); expect(f.ledger.list()[0].reviewHeld).toBeUndefined();
    saveGatewayInstance(f.config, f.instance.id); const next = f.ledger.claim()!; expect(next).toMatchObject({ index: 2, attempt: 1, text: 'Queued tail' }); f.ledger.settle(next, { remoteId: 'tail-delivered' });
    expect(f.ledger.claim()).toBeNull(); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(native); expect(fetch).not.toHaveBeenCalled();
    expect(gatewayOutboxProtectedBindings(f.instance.id).size).toBe(0); expect(() => f.ledger.settle(f.claim, { remoteId: 'late' })).toThrow('no longer owns');
  });

  it.each(['uncertain', 'failed'] as const)('queues an explicit %s retry without resending confirmed parts', async (status) => {
    const f = await fixture('telegram', status); const before = structuredClone(f.ledger.list()[0]); const body = f.retry();
    expect(() => f.review({ ...body, acknowledgePossibleDuplicate: false })).toThrow('duplicate'); f.review(body);
    expect(f.ledger.list()[0].receipts[1]).toMatchObject({ status: 'pending', attempts: 1 }); expect(f.ledger.list()[0].reviews?.[0]).toMatchObject({ action: 'retry', index: 1, attempt: 1, from: status, revision: body.revision });
    expect(f.ledger.claim()).toBeNull(); saveGatewayInstance(f.config, f.instance.id);
    const sent: string[] = []; const nonces: string[] = [];
    const replies = new GatewayReplies(f.inbox, async (event, text, _signal, approved) => { nonces.push(approved!.authorize(event, text)); sent.push(text); return `confirmed-${sent.length}`; }, new AbortController().signal, () => true, undefined, f.ledger);
    closes.push(() => replies.stop()); await replies.wake(); await replies.wake();
    expect(sent).toEqual(['Uncertain part', 'Queued tail']); expect(new Set(nonces).size).toBe(2); expect(f.ledger.list()[0].receipts[0]).toEqual(before.receipts[0]); expect(f.ledger.list()[0].receipts[1].attempts).toBe(2);
  });

  it('requires paused current receipts, explicit acknowledgement and a specifically attempted uncertain part', async () => {
    const f = await fixture(); const before = fs.readFileSync(f.state.outboxFile(), 'utf8'); const body = f.confirm();
    for (const value of [{}, { ...body, acknowledgeChecked: false }, { ...body, extra: true }, { ...body, index: 0 }, { ...body, index: 2 }, { ...body, remoteId: 'confirmed-prefix' }, ...['', 'two ids', 'x'.repeat(501)].map((remoteId) => ({ ...body, remoteId })), { ...f.retry(), index: 0 }, { ...f.retry(), acknowledgeRemaining: false }]) expect(() => f.review(value)).toThrow();
    expect(fs.readFileSync(f.state.outboxFile(), 'utf8')).toBe(before); saveGatewayInstance(f.config, f.instance.id); expect(() => f.review(body)).toThrow('Pause'); f.pause(); f.review(body); expect(() => f.review(body)).toThrow('changed');
    expect(() => f.review(f.confirm(2))).toThrow('uncertain');
  });

  it.each(['credentials', 'scope', 'name', 'route', 'edit'] as const)('refuses a retry after %s changes while still allowing a local receipt confirmation', async (change) => {
    const f = await fixture();
    if (change === 'credentials') saveGatewayCredentials(f.instance.id, { botToken: 'REPLACEMENT_PRIVATE_TOKEN' });
    if (change === 'scope') saveGatewayInstance({ ...f.config, enabled: false, senderPolicy: { platform: 'telegram', allowedUserIds: ['456'] } }, f.instance.id);
    if (change === 'name') saveGatewayInstance({ ...f.config, enabled: false, name: 'Renamed instance' }, f.instance.id);
    if (change === 'route') { const other = await createProject({ name: 'New destination' }); saveGatewayInstance({ ...f.config, enabled: false, projectId: other.id }, f.instance.id); }
    if (change === 'edit') { const journal = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal; const source = structuredClone(journal.events[0]); source.id = 'e'.repeat(64); source.sequence = journal.nextSequence++; source.input.kind = 'edit'; source.input.sourceEventId = 'edit'; source.status = 'needs-review'; delete source.reply; delete source.dispatch; delete source.operationId; journal.events.push(source); fs.writeFileSync(f.state.inboxFile(), JSON.stringify(journal)); }
    const before = fs.readFileSync(f.state.outboxFile(), 'utf8'); expect(() => f.review(f.retry())).toThrow('changed'); expect(fs.readFileSync(f.state.outboxFile(), 'utf8')).toBe(before); f.review(f.confirm()); expect(f.view().parts[1].status).toBe('sent'); expect(() => f.review(f.retry())).toThrow('changed');
  });

  it('keeps a prior destination-change hold and permanent closure even after confirmation', async () => {
    const f = await fixture(); f.mutate((journal) => { journal.deliveries[0].held = 'destination-changed'; }); f.review(f.confirm()); expect(f.view().canRetry).toBe(false); expect(() => f.review(f.retry())).toThrow();
    const before = f.ledger.list()[0]; f.ledger.finishLocal(f.project.id, f.postId, { revision: f.view().revision, acknowledgeNoSend: true });
    expect(f.ledger.list()[0]).toMatchObject({ ...before, closed: { at: expect.any(Number) } }); expect(f.view().canFinish).toBe(false); expect(() => f.review(f.confirm())).toThrow('cannot be reopened');
    saveGatewayInstance(f.config, f.instance.id); expect(f.ledger.claim()).toBeNull();
  });

  it('leaves GET read-only and recovers interrupted receipts only through paused exclusive preparation', async () => {
    const f = await fixture('telegram', 'sending'); outbox.save({ id: f.postId, platform: 'telegram', status: 'posting', parts: f.parts, gateway: { instanceId: f.instance.id, eventId: f.event.id } });
    const before = fs.readFileSync(f.state.outboxFile(), 'utf8'); expect(readGatewayPostDelivery(f.postId)).toMatchObject({ needsPrepare: true, canRetry: false }); expect(fs.readFileSync(f.state.outboxFile(), 'utf8')).toBe(before); expect(() => f.review(f.retry())).toThrow('Recover');
    const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop()); await expect(supervisor.prepareOutboxReview(f.instance.id, f.project.id, f.postId)).rejects.toMatchObject({ status: 503 }); await f.state.disconnect();
    await supervisor.prepareOutboxReview(f.instance.id, f.project.id, f.postId); await f.state.connect(); expect(f.view()).toMatchObject({ needsPrepare: false, canRetry: true, parts: [{ status: 'sent' }, { status: 'uncertain', attempts: 1 }, { status: 'pending' }] });
    const other = await createProject({ name: 'Unrelated project' }); expect(() => withProject(other, () => readGatewayPostDelivery(f.postId))).toThrow('Choose');
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await f.state.disconnect(); const value = withProject(f.project, () => readGatewayPostDelivery(f.postId));
    await supervisor.reviewOutbox(f.instance.id, f.project.id, f.postId, { action: 'confirm', revision: value.revision, index: 1, remoteId: 'operator-checked', acknowledgeChecked: true }); expect(fetch).not.toHaveBeenCalled();
    const dto = withProject(f.project, () => readGatewayPostDelivery(f.postId)); expect(JSON.stringify(dto)).not.toMatch(/PRIVATE_|configHash|sourceHash|Private native answer/); expect(dto.reviewHeld).toBe(true);
  });

  it('rejects contradictory review history without resetting evidence', async () => {
    const f = await fixture(); f.review(f.confirm()); const bytes = fs.readFileSync(f.state.outboxFile(), 'utf8');
    const changes: ((journal: GatewayOutboxJournal) => void)[] = [
      (journal) => { delete journal.deliveries[0].reviewHeld; },
      (journal) => { journal.deliveries[0].reviews!.push(structuredClone(journal.deliveries[0].reviews![0])); },
      (journal) => { journal.deliveries[0].reviews![0].index = 2; },
      (journal) => { journal.deliveries[0].reviews![0].attempt = 0; },
      (journal) => { const review = journal.deliveries[0].reviews![0]; if (review.action === 'confirmed') review.remoteId = 'wrong'; },
    ];
    for (const change of changes) { const value = JSON.parse(bytes) as GatewayOutboxJournal; change(value); const invalid = JSON.stringify(value); fs.writeFileSync(f.state.outboxFile(), invalid); expect(() => f.ledger.list()).toThrow('unreadable'); expect(fs.readFileSync(f.state.outboxFile(), 'utf8')).toBe(invalid); }
  });

  it('rechecks pause after asynchronous ownership acquisition before recovering receipts', async () => {
    const f = await fixture('telegram', 'sending'); const file = f.state.outboxFile(); const before = fs.readFileSync(file, 'utf8'); await f.state.disconnect();
    const connect = GatewayStateAdapter.prototype.connect;
    vi.spyOn(GatewayStateAdapter.prototype, 'connect').mockImplementation(async function(this: GatewayStateAdapter) { await connect.call(this); saveGatewayInstance(f.config, f.instance.id); });
    const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop());
    await expect(supervisor.prepareOutboxReview(f.instance.id, f.project.id, f.postId)).rejects.toMatchObject({ status: 400 }); expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('keeps locally finished confirmed-tail history closed without a continuation error', async () => {
    const f = await fixture(); f.review(f.confirm()); outbox.save({ id: f.postId, platform: 'telegram', status: 'posting', parts: f.parts, gateway: { instanceId: f.instance.id, eventId: f.event.id } });
    f.ledger.finishLocal(f.project.id, f.postId, { revision: f.view().revision, acknowledgeNoSend: true });
    const projected = projectGatewayPost(outbox.get(f.postId)!); expect(projected).toMatchObject({ status: 'rejected', error: null, gatewayProgress: { state: 'closed', parts: [{ remoteId: 'confirmed-prefix' }, { remoteId: 'checked-in-app' }, { status: 'pending' }] } });
    expect(readGatewayPostDelivery(f.postId)).toMatchObject({ canRetry: false, canFinish: false, reason: 'Delivery was finished locally and cannot be reopened.' });
  });

  it('does not queue or clear holds when the review write fails', async () => {
    const f = await fixture(); f.review(f.confirm()); const before = fs.readFileSync(f.state.outboxFile(), 'utf8'); const body = f.retry(); const write = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => { if (String(file).includes('outbox.json')) throw new Error('PRIVATE_DISK_PATH'); return write(file, ...args); });
    expect(() => f.review(body)).toThrow('could not be saved'); expect(fs.readFileSync(f.state.outboxFile(), 'utf8')).toBe(before);
  });
});
