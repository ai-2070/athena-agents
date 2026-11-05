import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayInboxJournal } from '../../shared/types.ts';
import { gatewayCleanupCandidates, gatewayNeedsReview } from '../../shared/gateways.ts';
import { GatewayInbox, gatewayInboxHistory, gatewayRequestReview } from '../../server/gateways/inbox.ts';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { GatewayDispatcher } from '../../server/gateways/dispatch.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

const closes: (() => Promise<void>)[] = []; let accounts = 9700000000;
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0).reverse()) await close(); });
async function fixture() {
  const config = gatewayConfig(String(accounts++)); const instance = saveGatewayInstance(config);
  const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect()); const inbox = new GatewayInbox(state);
  const accept = (id = '1') => inbox.accept({ ...gatewayInput(id), accountId: instance.accountId })!;
  const first = accept(); inbox.review(first.id); const later = accept('2'); const pause = () => saveGatewayInstance({ ...config, enabled: false }, instance.id);
  const preview = () => gatewayRequestReview(instance.id, first.id);
  const body = () => ({ revision: preview().revision, acknowledgeDismiss: true });
  return { config, instance, state, inbox, first, later, pause, preview, body, accept };
}

describe('explicit dismissal of never-started gateway requests', () => {
  it('dismisses while paused, retains the source and admits only later work after enable', async () => {
    const f = await fixture(); expect(f.preview()).toMatchObject({ canDismiss: false, reason: expect.stringContaining('Pause') });
    expect(f.inbox.claimNext()).toBeNull(); f.pause(); expect(f.preview().canDismiss).toBe(true); const original = structuredClone(f.inbox.list()[0]);
    const body = f.body(); f.inbox.dismissRequest(f.first.id, body); const dismissed = f.inbox.list()[0];
    expect(dismissed).toEqual({ ...original, dismissed: { at: expect.any(Number), revision: body.revision } });
    expect(gatewayNeedsReview(dismissed)).toBe(false); expect(f.preview().canDismiss).toBe(false);
    await f.state.disconnect(); await f.state.connect(); saveGatewayInstance(f.config, f.instance.id);
    const submissions: string[] = []; const dispatcher = new GatewayDispatcher(f.inbox, new AbortController().signal, { async submit(event) { submissions.push(event.id); return {}; }, poll() { return { state: 'pending' }; } });
    closes.push(() => dispatcher.stop()); await dispatcher.start(); await expect.poll(() => submissions).toEqual([f.later.id]);
    expect(f.inbox.list()[0].operationId).toBeUndefined(); expect(f.inbox.list()[0].reply).toBeUndefined(); f.accept(); expect(f.inbox.list()).toHaveLength(2);
  });

  it('requires current explicit acknowledgement and rejects a stale preview or repeated dismissal', async () => {
    const f = await fixture(); f.pause(); const current = f.body();
    for (const body of [{}, { revision: current.revision }, { ...current, acknowledgeDismiss: false }, { ...current, extra: 'invented' }, { ...current, revision: '0'.repeat(64) }]) expect(() => f.inbox.dismissRequest(f.first.id, body)).toThrow('changed');
    f.inbox.review(f.first.id, 'Source changed'); expect(() => f.inbox.dismissRequest(f.first.id, current)).toThrow('changed');
    const next = f.body(); f.inbox.dismissRequest(f.first.id, next); expect(() => f.inbox.dismissRequest(f.first.id, next)).toThrow('changed');
  });

  it('lets later text and file replies pass an earlier dismissed request in the same conversation', async () => {
    const f = await fixture(); f.pause(); f.inbox.dismissRequest(f.first.id, f.body()); saveGatewayInstance(f.config, f.instance.id);
    const next = f.inbox.claimNext()!; f.inbox.beginDispatch(next.id, next.operationId!, await gatewayConversation(next, new AbortController().signal)); f.inbox.finishDispatch(next.id, next.operationId!, 'Later answer');
    const reply = f.inbox.claimReply()!; expect(reply.event.id).toBe(f.later.id); f.inbox.settleReply(reply.event.id, reply.index, { remoteId: 'sent-reply' });
    f.inbox.selectOutgoing(next.id, [{ path: 'generated.txt', name: 'generated.txt', size: 1, sha256: 'a'.repeat(64) }]);
    expect(f.inbox.claimOutgoing()!.event.id).toBe(f.later.id); expect(f.inbox.list()[0].operationId).toBeUndefined(); expect(f.inbox.list()[0].reply).toBeUndefined();
  });

  it('invalidates confirmation when instance settings or later messages change', async () => {
    const f = await fixture(); f.pause(); const first = f.body(); saveGatewayInstance({ ...f.config, enabled: false, name: 'Renamed' }, f.instance.id);
    expect(() => f.inbox.dismissRequest(f.first.id, first)).toThrow('changed'); const second = f.body(); f.inbox.review(f.later.id);
    expect(() => f.inbox.dismissRequest(f.first.id, second)).toThrow('changed');
  });

  it('binds the confirmation to the selected request rather than another hold in the same snapshot', async () => {
    const f = await fixture(); f.inbox.review(f.later.id); f.pause(); const first = f.body();
    const other = gatewayRequestReview(f.instance.id, f.later.id); expect(other.canDismiss).toBe(true); expect(other.revision).not.toBe(first.revision);
    expect(() => f.inbox.dismissRequest(f.later.id, first)).toThrow('changed'); expect(f.inbox.list().every((event) => !event.dismissed)).toBe(true);
  });

  it('refuses an enabled instance even with a current revision', async () => {
    const f = await fixture(); expect(() => f.inbox.dismissRequest(f.first.id, f.body())).toThrow('Pause'); expect(f.inbox.list()[0].dismissed).toBeUndefined();
  });

  it.each(['reserved', 'dispatch', 'completed', 'album', 'delivery', 'notice'] as const)('never dismisses $0 work or delivery evidence', async (kind) => {
    const f = await fixture(); const file = f.state.inboxFile();
    if (kind === 'album') {
      const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as GatewayInboxJournal; journal.events[0].input.mediaGroupId = 'album'; fs.writeFileSync(file, JSON.stringify(journal));
    } else {
      f.inbox.review(f.first.id); const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as GatewayInboxJournal; journal.events[0].status = 'queued'; fs.writeFileSync(file, JSON.stringify(journal));
      const claimed = f.inbox.claimNext()!;
      if (kind !== 'reserved') f.inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, new AbortController().signal));
      if (kind === 'completed' || kind === 'delivery') f.inbox.finishDispatch(claimed.id, claimed.operationId!, 'Saved answer');
      if (kind === 'delivery') f.inbox.claimReply();
      if (kind === 'notice') f.inbox.queueNotice(claimed.id, 'working');
      f.inbox.review(f.first.id);
    }
    f.pause(); const before = fs.readFileSync(file, 'utf8'); expect(f.preview().canDismiss).toBe(false);
    expect(() => f.inbox.dismissRequest(f.first.id, f.body())).toThrow('Only held requests'); expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('retains failed/interrupted incoming download charges and cleanup keeps compact replay protection', async () => {
    const f = await fixture(); const journal = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal;
    journal.events = [journal.events[0]]; journal.events[0].input.media = [{ kind: 'file', fileId: 'private-file', name: 'plan.txt' }];
    journal.events[0].fileBatch = 'dismiss-download'; journal.events[0].files = [{ index: 0, status: 'transferring', attempts: [{ id: 'attempt-1', day: new Date().toISOString().slice(0, 10), bytes: 900 }] }];
    fs.writeFileSync(f.state.inboxFile(), JSON.stringify(journal)); f.pause(); f.inbox.dismissRequest(f.first.id, f.body());
    const saved = f.inbox.list()[0]; expect(saved.files![0]).toMatchObject({ status: 'failed', attempts: [{ bytes: 900 }] }); expect(saved.input.media[0].name).toBe('plan.txt');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000); const eligible = gatewayCleanupCandidates(f.inbox.list(), Date.now()); expect(eligible.map((event) => event.id)).toEqual([f.first.id]);
    expect(f.inbox.cleanup({ before: Date.now(), eventIds: [f.first.id] })).toEqual({ removed: 1 });
    const retired = JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal; expect(retired.retiredQuota?.[0].incomingBytes).toBe(900);
    saveGatewayInstance(f.config, f.instance.id); expect(f.accept()).toBeNull(); expect(f.inbox.list()).toEqual([]);
  });

  it('does not compact dismissed context while another message in its binding is unresolved', async () => {
    const f = await fixture(); f.pause(); f.inbox.dismissRequest(f.first.id, f.body()); vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    expect(gatewayCleanupCandidates(f.inbox.list(), Date.now())).toEqual([]);
  });

  it('rejects forged dismissal of an active operation in live and read-only journals', async () => {
    const f = await fixture(); const file = f.state.inboxFile(); const journal = JSON.parse(fs.readFileSync(file, 'utf8')) as GatewayInboxJournal;
    journal.events[0].operationId = 'unknown-operation'; journal.events[0].dismissed = { at: Date.now(), revision: 'a'.repeat(64) }; fs.writeFileSync(file, JSON.stringify(journal));
    expect(() => f.inbox.list()).toThrow('unreadable'); expect(() => gatewayInboxHistory(f.instance.id)).toThrow('unreadable');
  });

  it('leaves receipts unchanged after a failed local save and permits a deliberate retry', async () => {
    const f = await fixture(); f.pause(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); const write = fs.writeFileSync.bind(fs);
    const fault = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => { if (String(file).includes('inbox.json')) throw new Error('Simulated private disk failure'); return write(file, ...args); });
    expect(() => f.inbox.dismissRequest(f.first.id, f.body())).toThrow(); fault.mockRestore(); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
    f.inbox.dismissRequest(f.first.id, f.body()); expect(f.inbox.list()[0].dismissed).toBeDefined();
  });

  it('requires exclusive state/account ownership through the supervisor and never enables the instance', async () => {
    const f = await fixture(); f.pause(); const body = f.body(); const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop());
    await expect(supervisor.dismissRequest(f.instance.id, f.first.id, body)).rejects.toThrow('storage and ownership'); await f.state.disconnect();
    await supervisor.dismissRequest(f.instance.id, f.first.id, body); await f.state.connect(); expect(f.inbox.list()[0].dismissed).toBeDefined();
    expect(gatewayRequestReview(f.instance.id, f.first.id).reason).toContain('already dismissed');
  });
});
