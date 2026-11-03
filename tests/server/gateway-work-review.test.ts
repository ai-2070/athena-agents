import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayInboxJournal, GatewayTarget } from '../../shared/types.ts';
import { gatewayCleanupCandidates, gatewayNeedsReview } from '../../shared/gateways.ts';
import { GatewayInbox, gatewayInboxHistory, gatewayWorkReview } from '../../server/gateways/inbox.ts';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { GatewayWorker } from '../../server/gateways/worker.ts';
import { GatewayDispatcher } from '../../server/gateways/dispatch.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { gatewayExecution } from '../../server/gateways/execution.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';
import { newAgent } from '../../server/library.ts';
import { chats, workflows } from '../../server/store.ts';
import { admitExecution, readExecution } from '../../server/execution.ts';

const closes: (() => Promise<void>)[] = []; let accounts = 9540000000;
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });
async function fixture(options: { target?: GatewayTarget; reserved?: boolean } = {}) {
  const config = { ...gatewayConfig(String(accounts++)), target: options.target ?? { kind: 'brain' as const } }; const instance = saveGatewayInstance(config);
  const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect()); const inbox = new GatewayInbox(state);
  const input = (id = '1', conversationId = '123', threadId = '') => ({ ...gatewayInput(id, conversationId), threadId, accountId: instance.accountId });
  inbox.accept(input()); const first = inbox.claimNext()!;
  if (!options.reserved) inbox.beginDispatch(first.id, first.operationId!, await gatewayConversation(first, new AbortController().signal));
  const later = inbox.accept(input('2'))!; const pause = () => saveGatewayInstance({ ...config, enabled: false }, instance.id);
  const preview = (id = first.id) => gatewayWorkReview(instance.id, id);
  const body = () => ({ revision: preview().revision, acknowledgeMayStillRun: true, acknowledgeFreshConversation: true, acknowledgeNoReply: true });
  const keep = () => inbox.keepWork(first.id, body());
  const mutate = (change: (journal: GatewayInboxJournal) => void) => { const journal = JSON.parse(fs.readFileSync(state.inboxFile(), 'utf8')) as GatewayInboxJournal; change(journal); fs.writeFileSync(state.inboxFile(), JSON.stringify(journal)); };
  return { config, instance, state, inbox, first, later, input, pause, preview, body, keep, mutate };
}

describe('explicit local gateway work review', () => {
  it.each(['slack', 'discord'] as const)('keeps %s work local and separates its next private conversation', async (platform) => {
    const account = String(accounts++); const config = { ...gatewayConfig(platform === 'slack' ? `T${account}` : account), platform,
      senderPolicy: { platform, allowedUserIds: [platform === 'slack' ? 'UALICE' : '123'] }, scope: { directMessages: true, conversationIds: [], guildIds: [] } };
    const instance = saveGatewayInstance(config); const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect()); const inbox = new GatewayInbox(state);
    const input = { ...gatewayInput(), platform, accountId: instance.accountId, conversationId: platform === 'slack' ? 'DALICE' : '123', actor: { id: platform === 'slack' ? 'UALICE' : '123', label: 'Alice', kind: 'user' as const }, sourceMessageId: platform === 'slack' ? '1700000000.000001' : '1' };
    const event = inbox.accept(input)!; const work = inbox.claimNext()!; inbox.beginDispatch(event.id, work.operationId!, await gatewayConversation(work, new AbortController().signal));
    saveGatewayInstance({ ...config, enabled: false }, instance.id); await state.disconnect(); const supervisor = new GatewaySupervisor(() => { throw new Error('No transport'); }); closes.push(() => supervisor.stop());
    const preview = gatewayWorkReview(instance.id, event.id); await supervisor.keepWork(instance.id, event.id, { revision: preview.revision, acknowledgeMayStillRun: true, acknowledgeFreshConversation: true, acknowledgeNoReply: true });
    await state.connect(); saveGatewayInstance(config, instance.id); const fresh = inbox.accept({ ...input, sourceEventId: 'new', sourceMessageId: platform === 'slack' ? '1700000000.000002' : '2' })!;
    expect(fresh.bindingId).not.toBe(event.bindingId); expect(inbox.claimNext()!.id).toBe(fresh.id); expect(inbox.list()[0].reply).toBeUndefined();
  });

  it('keeps native receipts intact, holds old queued input and starts only new input in a separate private conversation', async () => {
    const agent = newAgent({ name: 'Original native agent' }); const f = await fixture({ target: { kind: 'agent', id: agent.id } });
    const old = f.inbox.list()[0]; const local = old.dispatch!.conversation; if (local.kind !== 'agent') throw new Error('Wrong fixture');
    admitExecution({ id: old.operationId!, projectId: old.route.projectId, agentId: agent.id, chatId: local.chatId, engine: agent.engine, ownerChatId: local.chatId, ownerAgentId: agent.id, parentRunId: null, depth: 0, text: 'Original work', from: null, attachments: [], startedAt: Date.now(), status: 'running' });
    const run = structuredClone(readExecution().runs.find((item) => item.id === old.operationId)!);
    const nativeChat = structuredClone(chats.get(agent.id, local.chatId)); f.pause(); const before = structuredClone(f.inbox.list()[0]); const body = f.body();
    const result = f.inbox.keepWork(old.id, body); expect(result).toMatchObject({ canKeep: false, heldRequests: 1, keptAt: expect.any(Number) });
    const kept = f.inbox.list()[0]; expect(kept).toEqual({ ...before, workKept: { at: expect.any(Number), revision: body.revision, throughSequence: 2, serial: 1 } });
    expect(readExecution().runs.find((item) => item.id === run.id)).toEqual(run); expect(chats.get(agent.id, local.chatId)).toEqual(nativeChat);
    expect(gatewayNeedsReview(kept)).toBe(false); expect(f.inbox.list()[1].status).toBe('needs-review'); expect(f.inbox.list()[1].operationId).toBeUndefined();
    await f.state.disconnect(); await f.state.connect(); f.inbox.recover(); expect(f.inbox.list()[0]).toEqual(kept);
    saveGatewayInstance(f.config, f.instance.id); expect(f.inbox.accept(f.input())!.id).toBe(old.id); expect(f.inbox.claimNext()).toBeNull();
    const fresh = f.inbox.accept(f.input('3'))!; expect(fresh.bindingId).not.toBe(old.bindingId); expect(fresh.route).toEqual(old.route);
    const next = f.inbox.claimNext()!; expect(next.id).toBe(fresh.id); const conversation = await gatewayConversation(next, new AbortController().signal);
    expect(conversation.kind).toBe('agent'); if (conversation.kind !== 'agent') throw new Error('Wrong conversation'); expect(conversation.chatId).not.toBe(local.chatId);
    f.inbox.beginDispatch(next.id, next.operationId!, conversation); f.inbox.finishDispatch(next.id, next.operationId!, 'Fresh answer'); const reply = f.inbox.claimReply()!; expect(reply.event.id).toBe(next.id);
    f.inbox.settleReply(next.id, 0, { remoteId: 'fresh-sent' }); f.inbox.selectOutgoing(next.id, [{ path: '/unused/new.txt', name: 'new.txt', size: 1, sha256: 'a'.repeat(64) }]); expect(f.inbox.claimOutgoing()!.event.id).toBe(next.id);
    expect(f.inbox.list()[0]).toEqual(kept); expect(readExecution().runs.find((item) => item.id === run.id)).toEqual(run);
  });

  it.each(['brain', 'team'] as const)('separates fresh %s work without replaying the saved operation', async (kind) => {
    const agent = newAgent({ name: 'Team member' }); const team = workflows.save({ name: 'Original team', members: [agent.id], lead: agent.id, steps: [] });
    const f = await fixture({ target: kind === 'brain' ? { kind } : { kind, id: team.id } }); f.pause(); f.keep(); saveGatewayInstance(f.config, f.instance.id);
    const fresh = f.inbox.accept(f.input('3'))!; const submitted: string[] = []; const dispatcher = new GatewayDispatcher(f.inbox, new AbortController().signal, { async submit(event) { submitted.push(event.id); return {}; }, poll() { return { state: 'pending' }; } });
    closes.push(() => dispatcher.stop()); await dispatcher.start(); await expect.poll(() => submitted).toEqual([fresh.id]);
    const old = f.inbox.list()[0]; const next = f.inbox.list().find((item) => item.id === fresh.id)!; expect(old.operationId).toBe(f.first.operationId); expect(next.operationId).not.toBe(old.operationId);
    expect(next.dispatch!.conversation.conversationId).not.toBe(old.dispatch!.conversation.conversationId);
    if (kind === 'team' && old.dispatch!.conversation.kind === 'team' && next.dispatch!.conversation.kind === 'team') expect(next.dispatch!.conversation.teamId).not.toBe(old.dispatch!.conversation.teamId);
  });

  it('can keep a reservation whose native admission is unknown, without inventing a dispatch or completion', async () => {
    const f = await fixture({ reserved: true }); f.pause(); expect(f.preview().native).toBeUndefined(); f.keep(); const kept = f.inbox.list()[0];
    expect(kept.status).toBe('running'); expect(kept.dispatch).toBeUndefined(); expect(kept.reply).toBeUndefined(); expect(() => f.inbox.complete(kept.id, kept.operationId!)).toThrow();
    saveGatewayInstance(f.config, f.instance.id); const fresh = f.inbox.accept(f.input('3'))!; expect(f.inbox.claimNext()!.id).toBe(fresh.id);
  });

  it('does not let four kept running receipts consume the dispatcher slots for fresh conversations', async () => {
    const f = await fixture(); f.pause(); f.keep();
    for (const conversation of ['456', '789', '987']) {
      saveGatewayInstance(f.config, f.instance.id); const event = f.inbox.accept(f.input(`old-${conversation}`, conversation))!; const work = f.inbox.claimNext()!;
      expect(work.id).toBe(event.id); f.inbox.beginDispatch(work.id, work.operationId!, await gatewayConversation(work, new AbortController().signal)); f.pause();
      f.inbox.keepWork(work.id, { ...f.body(), revision: f.preview(work.id).revision });
    }
    saveGatewayInstance(f.config, f.instance.id); const fresh = ['123', '456', '789', '987'].map((conversation) => f.inbox.accept(f.input(`new-${conversation}`, conversation))!);
    const submitted: string[] = []; const dispatcher = new GatewayDispatcher(f.inbox, new AbortController().signal, { async submit(event) { submitted.push(event.id); return {}; }, poll() { return { state: 'pending' }; } });
    closes.push(() => dispatcher.stop()); await dispatcher.start(); await expect.poll(() => submitted).toEqual(fresh.map((event) => event.id));
  });

  it('binds the action to the exact event, settings and queue with all three acknowledgements', async () => {
    const f = await fixture(); f.pause(); const body = f.body();
    for (const invalid of [{}, { ...body, acknowledgeMayStillRun: false }, { ...body, acknowledgeFreshConversation: false }, { ...body, acknowledgeNoReply: false }, { ...body, extra: true }, { ...body, revision: 'a'.repeat(64) }]) expect(() => f.inbox.keepWork(f.first.id, invalid)).toThrow();
    expect(() => f.inbox.keepWork(f.later.id, body)).toThrow(); saveGatewayInstance({ ...f.config, enabled: false, name: 'Renamed' }, f.instance.id); expect(() => f.inbox.keepWork(f.first.id, body)).toThrow('changed');
    const current = f.body(); f.inbox.review(f.later.id); expect(() => f.inbox.keepWork(f.first.id, current)).toThrow('changed'); f.keep(); expect(() => f.keep()).toThrow('kept in Athena');
  });

  it('refuses enabled, unstarted, edited and completed deliveries without mutating their receipts', async () => {
    const f = await fixture(); expect(() => f.keep()).toThrow('Pause'); f.pause(); const queued = f.preview(f.later.id); expect(queued.canKeep).toBe(false);
    f.mutate((journal) => { journal.events[0].input.kind = 'edit'; }); expect(f.preview().canKeep).toBe(false);
    f.mutate((journal) => { journal.events[0].input.kind = 'message'; }); saveGatewayInstance(f.config, f.instance.id); f.inbox.finishDispatch(f.first.id, f.first.operationId!, 'Final answer'); f.pause();
    expect(f.preview().reason).toContain('Review completed delivery'); const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); expect(() => f.keep()).toThrow('final reply'); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
  });

  it('scopes interrupted receipt recovery to the selected work and preserves confirmed notices and file choices', async () => {
    const f = await fixture(); f.inbox.queueNotice(f.first.id, 'working'); f.inbox.claimNotice(); f.inbox.settleNotice(f.first.id, 'working', { remoteId: 'notice-sent' });
    f.inbox.queueNotice(f.first.id, 'approval'); f.inbox.claimNotice(); f.inbox.selectOutgoing(f.first.id, [{ path: '/unused/report.txt', name: 'report.txt', size: 1, sha256: 'a'.repeat(64) }]); f.pause();
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); expect(f.preview().needsPrepare).toBe(true); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before); expect(() => f.keep()).toThrow('Recover');
    const later = structuredClone(f.inbox.list()[1]); f.inbox.prepareWorkReview(f.first.id); expect(f.inbox.list()[1]).toEqual(later); expect(f.inbox.list()[0].notices!.approval!.status).toBe('uncertain');
    const receipts = structuredClone(f.inbox.list()[0]); f.keep(); const kept = f.inbox.list()[0]; expect(kept.notices).toEqual(receipts.notices); expect(kept.outgoing).toEqual(receipts.outgoing);
    expect(() => f.inbox.prepareWorkReview(kept.id)).toThrow(); expect(() => f.inbox.selectOutgoing(kept.id, [])).toThrow(); expect(() => f.inbox.changeOutgoing(kept.id, 0, 'skip')).toThrow();
  });

  it('never reopens kept work through tracking, native admission or stale completion callbacks', async () => {
    const f = await fixture(); f.pause(); f.keep(); const kept = structuredClone(f.inbox.list()[0]);
    expect(() => f.inbox.reconciliationCandidate(kept.id)).toThrow(); expect(() => f.inbox.recordDispatch(kept.id, kept.operationId!, { brain: { answer: 'Late answer', delegate: null } })).toThrow(); expect(() => f.inbox.finishDispatch(kept.id, kept.operationId!, 'Late answer')).toThrow();
    expect(() => f.inbox.checkAccess(f.first)).toThrow('predates'); expect(() => f.inbox.checkAccess(kept)).toThrow('kept in Athena');
    await expect(gatewayConversation(kept, new AbortController().signal)).rejects.toThrow(); await expect(gatewayExecution.submit(kept, new AbortController().signal, () => true)).rejects.toThrow(); expect(gatewayExecution.poll(kept).state).toBe('needs-review');
    f.inbox.review(kept.id); f.inbox.holdInput(kept.id, 'Source changed'); f.inbox.recover(); expect(f.inbox.list()[0]).toEqual(kept);
    saveGatewayInstance(f.config, f.instance.id); expect(f.inbox.claimReply()).toBeNull(); expect(f.inbox.claimOutgoing()).toBeNull(); expect(f.inbox.claimNotice()).toBeNull();
  });

  it('keeps old edits with the original conversation and leaves other conversations and threads alone', async () => {
    const f = await fixture(); const other = f.inbox.accept(f.input('other', '456'))!; const topic = f.inbox.accept(f.input('topic', '123', '7'))!; f.pause(); f.keep(); saveGatewayInstance(f.config, f.instance.id);
    const fresh = f.inbox.accept(f.input('3'))!; const edited = f.inbox.accept({ ...f.input(), kind: 'edit', sourceEventId: 'edited', text: 'Old source edit' })!;
    expect(edited.bindingId).toBe(f.first.bindingId); expect(edited.bindingId).not.toBe(fresh.bindingId); expect(f.inbox.list().find((item) => item.id === other.id)).toEqual(other); expect(f.inbox.list().find((item) => item.id === topic.id)).toEqual(topic);
    expect([f.inbox.claimNext()!.id, f.inbox.claimNext()!.id, f.inbox.claimNext()!.id]).toEqual([other.id, topic.id, fresh.id]);
  });

  it('uses a new boundary for each later review, while retained markers keep future routing stable after cleanup', async () => {
    const f = await fixture(); f.pause(); f.keep(); saveGatewayInstance(f.config, f.instance.id); const second = f.inbox.accept(f.input('3'))!; const claimed = f.inbox.claimNext()!;
    f.inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, new AbortController().signal)); f.pause(); f.inbox.keepWork(second.id, { ...f.body(), revision: f.preview(second.id).revision });
    expect(f.inbox.list().find((item) => item.id === second.id)!.workKept!.serial).toBe(2); saveGatewayInstance(f.config, f.instance.id); const third = f.inbox.accept(f.input('4'))!; expect(new Set([f.first.bindingId, second.bindingId, third.bindingId]).size).toBe(3);
    const next = f.inbox.claimNext()!; f.inbox.beginDispatch(next.id, next.operationId!, await gatewayConversation(next, new AbortController().signal)); f.inbox.finishDispatch(next.id, next.operationId!, 'Final'); f.inbox.claimReply(); f.inbox.settleReply(next.id, 0, { remoteId: 'sent' });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000); expect(gatewayCleanupCandidates(f.inbox.list(), Date.now()).map((event) => event.id)).toEqual([third.id]); f.inbox.cleanup({ before: Date.now(), eventIds: [third.id] });
    expect(f.inbox.list()).toHaveLength(3); const fourth = f.inbox.accept(f.input('5'))!; expect(fourth.bindingId).toBe(third.bindingId); expect(f.inbox.accept(f.input())!.id).toBe(f.first.id);
    expect(() => f.inbox.cleanup({ before: Date.now(), eventIds: [f.first.id] })).toThrow('no longer eligible');
  });

  it('allows local review after revoked access without granting any new sending permission', async () => {
    const f = await fixture(); saveGatewayInstance({ ...f.config, enabled: false, senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } }, f.instance.id); f.keep();
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } }, f.instance.id); expect(f.inbox.accept(f.input('3'))).toBeNull();
  });

  it('saves atomically and reviews under exclusive ownership without constructing a transport', async () => {
    const f = await fixture(); f.pause(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); const write = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => { if (String(file).includes('inbox.json')) throw new Error('PRIVATE_DISK'); return write(file, ...args); }); expect(() => f.keep()).toThrow('could not be saved'); vi.restoreAllMocks(); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
    const supervisor = new GatewaySupervisor(() => { throw new Error('No transport'); }); closes.push(() => supervisor.stop()); await expect(supervisor.keepWork(f.instance.id, f.first.id, f.body())).rejects.toMatchObject({ status: 503 }); await f.state.disconnect();
    expect((await supervisor.keepWork(f.instance.id, f.first.id, f.body())).keptAt).toBeDefined(); expect(gatewayInboxHistory(f.instance.id)[0].workKept).toBeDefined();
  });

  it('hides transport shutdown errors and refuses to take ownership until the worker has drained', async () => {
    const f = await fixture(); await f.state.disconnect(); let reject = true; const worker = new GatewayWorker(f.instance.id); vi.spyOn(worker, 'start').mockResolvedValue(undefined); vi.spyOn(worker, 'stop').mockImplementation(async () => { if (reject) throw Object.assign(new Error('PRIVATE_TRANSPORT'), { status: 503 }); });
    const supervisor = new GatewaySupervisor(() => worker); closes.push(() => supervisor.stop()); await supervisor.start(); f.pause(); await expect(supervisor.keepWork(f.instance.id, f.first.id, f.body())).rejects.toThrow('could not be reviewed safely'); reject = false;
    expect((await supervisor.prepareWorkReview(f.instance.id, f.first.id)).canKeep).toBe(true); expect((await supervisor.keepWork(f.instance.id, f.first.id, f.body())).keptAt).toBeDefined();
  });

  it('refuses forged review markers and cross-conversation binding roots before reading or claiming work', async () => {
    const f = await fixture(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    f.mutate((journal) => { journal.events[1].workKept = { at: 1, revision: 'a'.repeat(64), throughSequence: 2, serial: 1 }; }); expect(() => f.preview()).toThrow('unreadable'); fs.writeFileSync(f.state.inboxFile(), before);
    f.pause(); f.keep(); saveGatewayInstance(f.config, f.instance.id); f.inbox.accept(f.input('3')); const valid = fs.readFileSync(f.state.inboxFile(), 'utf8');
    for (const change of [(journal: GatewayInboxJournal) => { journal.bindings[1].rootId = journal.bindings[1].id; }, (journal: GatewayInboxJournal) => { journal.events[0].workKept!.throughSequence = journal.nextSequence; }, (journal: GatewayInboxJournal) => { journal.bindings[1].conversationId = 'different'; }, (journal: GatewayInboxJournal) => { journal.events[0].workKept!.serial = 1000; }]) {
      f.mutate(change); expect(() => f.preview()).toThrow('unreadable'); expect(() => f.inbox.claimNext()).toThrow(); fs.writeFileSync(f.state.inboxFile(), valid);
    }
  });
});
