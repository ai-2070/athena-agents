import fs from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayInbound, GatewayInboxJournal, GatewayRunInput } from '../../shared/types.ts';
import { gatewayAlbumCandidates, gatewayCleanupCandidates } from '../../shared/gateways.ts';
import { saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayOutboxLedger, gatewayOutboxDeliveryReview } from '../../server/gateways/outbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox, gatewayInboxHistory, gatewayWorkReview } from '../../server/gateways/inbox.ts';
import { GatewayFileProcessor } from '../../server/gateways/files.ts';
import { GatewayDispatcher } from '../../server/gateways/dispatch.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import type { GatewayCompletion, GatewayExecutionServices } from '../../server/gateways/execution.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';
import { newAgent } from '../../server/library.ts';

let account = 92000;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function fixture(limits = { perFileBytes: 1024, perMessageBytes: 4096, filesPerMessage: 10, dailyBytes: 8192 }) {
  const config = { ...gatewayConfig(String(account++)), fileLimits: limits, senderPolicy: { platform: 'telegram', allowedUserIds: ['123', '456'] } };
  const instance = saveGatewayInstance(config); const state = new GatewayStateAdapter(instance.id); await state.connect();
  const inbox = new GatewayInbox(state); const abort = new AbortController(); let downloads = 0;
  const files = new GatewayFileProcessor(instance.id, inbox, async () => { downloads++; return { source: Readable.from([Buffer.from('hello')]), declaredBytes: 5 }; }, abort.signal);
  const submitted: { id: string; input?: GatewayRunInput }[] = [];
  let outcome: GatewayCompletion = { state: 'pending' };
  const services: GatewayExecutionServices = {
    submit: async (event, _signal, proceed, input) => { expect(proceed()).toBe(true); submitted.push({ id: event.id, input }); return {}; },
    poll: () => outcome,
  };
  const dispatcher = new GatewayDispatcher(inbox, abort.signal, services);
  closers.push(() => state.disconnect(), () => files.stop(), () => dispatcher.stop());
  const accept = (id = '1', changes: Partial<GatewayInbound> = {}) => inbox.accept({ ...gatewayInput(id), accountId: instance.accountId, mediaGroupId: 'album-1', media: [{ kind: 'file', fileId: id }], ...changes })!;
  const saved = async () => { const one = accept(); const two = accept('2'); await files.start(); return [one, two]; };
  const seal = (ids: string[]) => inbox.groupAlbum(ids[0], { eventIds: ids });
  const finish = async () => { outcome = { state: 'completed', answer: 'Album answer' }; await dispatcher.wake(); };
  return { config, instance, state, inbox, files, abort, dispatcher, services, submitted, accept, saved, seal, finish, downloads: () => downloads };
}

describe('explicit Telegram album grouping', () => {
  it('rechecks every grouped source for a paused approved Outbox retry without enabling native work', async () => {
    const f = await fixture(); saveGatewayCredentials(f.instance.id, { botToken: 'PRIVATE_BOT_TOKEN' }); const originals = await f.saved(); f.seal(originals.map((event) => event.id));
    const work = f.inbox.claimNext()!; f.inbox.beginDispatch(work.id, work.operationId!, await gatewayConversation(work, f.abort.signal, f.inbox.dispatchSources(work.id))); f.inbox.finishDispatch(work.id, work.operationId!, 'Saved album answer'); f.inbox.claimReply(); f.inbox.settleReply(work.id, 0, { remoteId: 'native-reply' });
    const ledger = new GatewayOutboxLedger(f.state, f.inbox); ledger.approve(ledger.prepare({ instanceId: f.instance.id, projectId: f.instance.projectId, postId: 'album-follow-up', eventId: work.id, parts: ['Approved follow-up'] }).approval);
    const claim = ledger.claim()!; ledger.settle(claim, { status: 'uncertain' }); const paused = saveGatewayInstance({ ...f.config, enabled: false }, f.instance.id); const before = structuredClone(f.inbox.list());
    ledger.review(f.instance.projectId, 'album-follow-up', { action: 'retry', index: 0, revision: gatewayOutboxDeliveryReview(paused, ledger.list()[0]).revision, acknowledgeRemaining: true, acknowledgePossibleDuplicate: true });
    expect(f.inbox.list()).toEqual(before); expect(f.submitted).toHaveLength(0); expect(ledger.claim()).toBeNull(); saveGatewayInstance(f.config, f.instance.id); expect(ledger.claim()).toMatchObject({ index: 0, attempt: 2 });
  });
  it('keeps only the started album leader locally and holds late parts in its original conversation', async () => {
    const f = await fixture(); const originals = await f.saved(); f.seal(originals.map((event) => event.id)); const leader = f.inbox.claimNext()!;
    f.inbox.beginDispatch(leader.id, leader.operationId!, await gatewayConversation(leader, f.abort.signal, f.inbox.dispatchSources(leader.id)));
    saveGatewayInstance({ ...f.config, enabled: false }, f.instance.id); const before = structuredClone(f.inbox.list());
    expect(gatewayWorkReview(f.instance.id, originals[1].id).canKeep).toBe(false); const preview = gatewayWorkReview(f.instance.id, leader.id);
    f.inbox.keepWork(leader.id, { revision: preview.revision, acknowledgeMayStillRun: true, acknowledgeFreshConversation: true, acknowledgeNoReply: true });
    const kept = structuredClone(f.inbox.list()[0]); expect(kept.dispatch).toEqual(before[0].dispatch); expect(kept.files).toEqual(before[0].files); expect(f.inbox.list()[1]).toEqual(before[1]);
    saveGatewayInstance(f.config, f.instance.id); const late = f.accept('3'); expect(late.bindingId).toBe(leader.bindingId); expect(late.status).toBe('needs-review');
    const fresh = f.inbox.accept({ ...gatewayInput('fresh'), accountId: f.instance.accountId })!; expect(fresh.bindingId).not.toBe(leader.bindingId); expect(f.inbox.claimNext()!.id).toBe(fresh.id);
    expect(f.inbox.list()[0]).toEqual(kept); expect(gatewayCleanupCandidates(f.inbox.list(), Date.now() + 1000)).toEqual([]);
  });

  it('dispatches all original IDs, captions and verified file batches once under one operation', async () => {
    const f = await fixture(); const originals = await f.saved();
    expect(f.inbox.claimNext()).toBeNull(); expect(f.submitted).toHaveLength(0);
    const before = f.inbox.list(); const ids = originals.map((item) => item.id);
    expect(gatewayAlbumCandidates(before, before[0]).map((item) => item.id)).toEqual(ids);
    expect(f.seal(ids)).toEqual({ leaderId: ids[0] }); expect(() => f.seal(ids)).toThrow();
    await f.dispatcher.wake(); await expect.poll(() => f.submitted.length).toBe(1);
    const events = f.inbox.list(); const leader = events[0];
    expect(events[1].status).toBe('done'); expect(events[1].operationId).toBeUndefined();
    expect(leader.album?.memberIds).toEqual(ids); expect(events[1].album).toEqual({ leaderId: ids[0] });
    expect(events.map((item) => item.fileBatch)).toEqual(before.map((item) => item.fileBatch));
    expect(f.submitted[0].input?.text).toContain('Message 1\nMessage 1'); expect(f.submitted[0].input?.text).toContain('Message 2\nMessage 2');
    expect(f.submitted[0].input?.attachments).toEqual(before.flatMap((item) => item.files!.map((file) => file.file!.path)));
    await f.finish(); expect(f.inbox.list()[0].reply?.parts[0].text).toBe('Album answer');
    expect(f.accept().id).toBe(ids[0]); expect(f.submitted).toHaveLength(1);
    await f.state.disconnect(); await f.state.connect(); f.inbox.recover(); await f.dispatcher.wake();
    expect(f.submitted).toHaveLength(1); expect(f.inbox.list()[0].operationId).toBe(leader.operationId);
  });

  it('rejects stale or incomplete selections without changing any source receipt', async () => {
    const f = await fixture(); const sources = await f.saved(); f.accept('3'); await f.files.wake();
    expect(() => f.seal(sources.map((item) => item.id))).toThrow('changed');
    const events = f.inbox.list(); expect(events.every((item) => item.status === 'needs-review' && !item.album)).toBe(true);
    expect(() => f.seal([events[0].id, events[0].id])).toThrow();
    expect(() => f.seal([events[0].id])).toThrow(); expect(f.inbox.claimNext()).toBeNull();
  });

  it.each(['actor', 'route', 'edit', 'access'])('does not group messages with a changed %s', async (kind) => {
    const f = await fixture(); const first = f.accept();
    if (kind === 'route') saveGatewayInstance({ ...f.config, target: { kind: 'agent', id: newAgent({ name: 'Changed album target' }).id } }, f.instance.id);
    if (kind === 'actor') f.accept('2', { actor: { id: '456', label: 'Bob', kind: 'user' } });
    else f.accept('2');
    await f.files.start();
    if (kind === 'edit') f.accept('1', { kind: 'edit', sourceEventId: 'edit-1', mediaGroupId: undefined });
    if (kind === 'access') saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'telegram', allowedUserIds: ['456'] } }, f.instance.id);
    expect(() => f.seal(f.inbox.list().filter((item) => item.input.kind === 'message').map((item) => item.id))).toThrow();
    expect(f.inbox.list().find((item) => item.id === first.id)?.album).toBeUndefined();
  });

  it('verifies every member in its own batch before admission', async () => {
    const f = await fixture(); const sources = await f.saved(); f.seal(sources.map((item) => item.id));
    const follower = f.inbox.list()[1]; fs.writeFileSync(follower.files![0].file!.path, 'other');
    await f.dispatcher.wake(); expect(f.submitted).toHaveLength(0); expect(f.inbox.list()[0].status).toBe('needs-review');
  });

  it('holds late parts and the queued assignment without downloading or starting another run', async () => {
    const f = await fixture(); const sources = await f.saved(); f.seal(sources.map((item) => item.id));
    const late = f.accept('3'); await f.files.wake(); await f.dispatcher.wake();
    expect(late.albumBlocked).toBe(true); expect(late.status).toBe('needs-review'); expect(f.downloads()).toBe(2);
    expect(f.inbox.list()[0].status).toBe('needs-review'); expect(f.submitted).toHaveLength(0);
    expect(() => f.seal(f.inbox.list().map((item) => item.id))).toThrow();
  });

  it('holds edits of a follower without invalidating its original grouped receipt', async () => {
    const f = await fixture(); const sources = await f.saved(); f.seal(sources.map((item) => item.id));
    await f.dispatcher.wake(); await expect.poll(() => f.inbox.list()[0].dispatch?.state).toBe('running');
    f.accept('2', { kind: 'edit', sourceEventId: 'changed', mediaGroupId: undefined });
    await f.finish(); const events = f.inbox.list();
    expect(events[0].status).toBe('needs-review'); expect(events[0].reply).toBeUndefined(); expect(events[1].status).toBe('done');
    expect(() => f.dispatcher.reconcile(events[0].id)).toThrow(); expect(f.submitted).toHaveLength(1);
  });

  it('stops admission if an album changes during asynchronous file verification', async () => {
    const f = await fixture(); const sources = await f.saved(); f.seal(sources.map((item) => item.id));
    const wake = f.dispatcher.wake();
    await Promise.resolve(); f.accept('3'); await wake;
    expect(f.submitted).toHaveLength(0); expect(f.inbox.list()[0].status).toBe('needs-review');
  });

  it('holds unsent reply parts when a late part arrives, including a rate-limited send already in progress', async () => {
    const f = await fixture(); const sources = await f.saved(); f.seal(sources.map((item) => item.id));
    await f.dispatcher.wake(); await expect.poll(() => f.inbox.list()[0].dispatch?.state).toBe('running'); await f.finish();
    const claimed = f.inbox.claimReply()!; expect(claimed).not.toBeNull(); f.accept('3');
    f.inbox.settleReply(claimed.event.id, claimed.index, { status: 'pending', retryAt: Date.now() });
    expect(f.inbox.list()[0].reply?.parts[0].status).toBe('failed'); expect(f.inbox.claimReply()).toBeNull();
    expect(f.submitted).toHaveLength(1);
  });

  it('reconciles only the original grouped operation after a restart', async () => {
    const f = await fixture(); const sources = await f.saved(); f.seal(sources.map((item) => item.id));
    const claimed = f.inbox.claimNext()!;
    f.inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, f.abort.signal, f.inbox.dispatchSources(claimed.id)));
    f.inbox.review(claimed.id); await f.state.disconnect(); await f.state.connect(); f.inbox.recover();
    f.services.reconcile = () => ({ state: 'completed', answer: 'Recovered album answer' });
    expect(f.dispatcher.reconcile(claimed.id).state).toBe('completed'); expect(f.submitted).toHaveLength(0);
    expect(f.inbox.list()[0].operationId).toBe(claimed.operationId);
  });

  it('keeps confirmed text and file sends while holding unconfirmed album deliveries', async () => {
    const f = await fixture(); const sources = await f.saved(); const ids = sources.map((item) => item.id); f.seal(ids);
    await f.dispatcher.wake(); await expect.poll(() => f.inbox.list()[0].dispatch?.state).toBe('running');
    f.services.poll = () => ({ state: 'completed', answer: 'a'.repeat(6001) }); await f.dispatcher.wake();
    for (let index = 0; index < 3; index++) { const text = f.inbox.claimReply()!; f.inbox.settleReply(text.event.id, text.index, { remoteId: `text-${index}` }); }
    f.inbox.selectOutgoing(ids[0], [1, 2, 3].map((index) => ({ path: `/album-result-${index}.txt`, name: `${index}.txt`, size: 5, sha256: 'a'.repeat(64) })));
    const confirmed = f.inbox.claimOutgoing()!; f.inbox.settleOutgoing(ids[0], confirmed.index, { remoteId: 'confirmed-file' });
    const uploading = f.inbox.claimOutgoing()!; f.accept('3');
    f.inbox.settleOutgoing(ids[0], uploading.index, { status: 'pending', retryAt: Date.now() });
    const leader = f.inbox.list()[0];
    expect(leader.reply?.parts.every((part) => part.status === 'sent')).toBe(true);
    expect(leader.outgoing?.map((file) => file.status)).toEqual(['sent', 'failed', 'failed']); expect(f.inbox.claimOutgoing()).toBeNull();
  });

  it('charges the album as one message across source downloads and failed reservations', async () => {
    const f = await fixture({ perFileBytes: 5, perMessageBytes: 8, filesPerMessage: 10, dailyBytes: 100 });
    await f.saved(); const events = f.inbox.list();
    expect(f.downloads()).toBe(2); expect(events[0].files![0].status).toBe('saved'); expect(events[1].files![0].status).toBe('failed');
    expect(events.flatMap((item) => item.files!).flatMap((file) => file.attempts).reduce((sum, attempt) => sum + attempt.bytes, 0)).toBe(8);
    f.inbox.retryFiles(events[1].id); await f.files.wake(); expect(f.downloads()).toBe(2);
    expect(() => f.seal(events.map((item) => item.id))).toThrow();
  });

  it('rejects an album exceeding the aggregate file count before download', async () => {
    const f = await fixture({ perFileBytes: 1024, perMessageBytes: 4096, filesPerMessage: 1, dailyBytes: 8192 });
    await f.saved(); expect(f.downloads()).toBe(0); expect(f.inbox.list().every((item) => item.files?.[0].status === 'failed')).toBe(true);
  });

  it('cleans only whole delivered albums and remembers grouped families after cleanup and restart', async () => {
    const f = await fixture(); const sources = await f.saved(); const ids = sources.map((item) => item.id); f.seal(ids);
    await f.dispatcher.wake(); await expect.poll(() => f.inbox.list()[0].dispatch?.state).toBe('running'); await f.finish();
    const reply = f.inbox.claimReply()!; f.inbox.settleReply(reply.event.id, 0, { remoteId: 'confirmed' });
    const before = Date.now() + 1; const eligible = gatewayCleanupCandidates(f.inbox.list(), before);
    expect(eligible.map((item) => item.id)).toEqual(ids);
    expect(() => f.inbox.cleanup({ before: Date.now(), eventIds: [ids[0]] })).toThrow('together');
    expect(f.inbox.cleanup({ before: Date.now(), eventIds: ids })).toEqual({ removed: 2 });
    await f.state.disconnect(); await f.state.connect(); expect(f.inbox.accept(sources[0].input)).toBeNull();
    const late = f.accept('3'); expect(late.albumBlocked).toBe(true); expect(f.inbox.claimNext()).toBeNull();
    f.accept('4'); await f.files.wake(); expect(() => f.seal(f.inbox.list().map((item) => item.id))).toThrow();
    expect(f.downloads()).toBe(2);
  });

  it('refuses damaged album links in both processing and read-only diagnostics', async () => {
    const f = await fixture(); const sources = await f.saved(); f.seal(sources.map((item) => item.id));
    const file = f.state.inboxFile(); const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as GatewayInboxJournal;
    journal.events[1].album!.leaderId = 'missing'; fs.writeFileSync(file, JSON.stringify(journal));
    expect(() => f.inbox.list()).toThrow('album receipts'); expect(() => gatewayInboxHistory(f.instance.id)).toThrow('unreadable');
  });
});
