import fs from 'node:fs';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { GatewayInbox, gatewayInboxHistory } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayFileProcessor } from '../../server/gateways/files.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { gatewayCleanupCandidates } from '../../shared/gateways.ts';
import { readJSON, writeJSON } from '../../server/util.ts';
import type { GatewayInboxJournal } from '../../shared/types.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';
import { newAgent } from '../../server/library.ts';

let account = 99000;
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture() {
  const config = gatewayConfig(String(account++)); const instance = saveGatewayInstance(config);
  const state = new GatewayStateAdapter(instance.id); await state.connect(); closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state); const signal = new AbortController().signal;
  const accept = (id = '1') => inbox.accept({ ...gatewayInput(id), accountId: instance.accountId })!;
  const complete = () => { const event = inbox.claimNext()!; inbox.complete(event.id, event.operationId!); return inbox.list().find((item) => item.id === event.id)!; };
  const cleanup = (ids = inbox.list().map((event) => event.id)) => inbox.cleanup({ before: Date.now(), eventIds: ids });
  return { config, instance, state, inbox, signal, accept, complete, cleanup };
}

it('removes completed bodies while preserving replay protection, bindings and source-edit suppression across restart', async () => {
  const f = await fixture();
  const input = { ...gatewayInput(), accountId: f.instance.accountId, conversationId: '-100', threadId: '7', directMessage: false, triggered: true, text: 'PRIVATE_RECEIPT_BODY' };
  const original = f.inbox.accept(input)!; f.complete();
  expect(f.cleanup().removed).toBe(1);
  expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).not.toContain('PRIVATE_RECEIPT_BODY');
  await f.state.disconnect(); await f.state.connect(); f.inbox.recover();
  expect(f.inbox.accept(input)).toBeNull();
  expect(f.inbox.accept({ ...input, sourceEventId: 'replayed-update' })).toBeNull();
  expect(f.inbox.accept({ ...input, kind: 'edit', sourceEventId: 'edit-1', text: 'Edited old input' })).toBeNull();
  const next = f.inbox.accept({ ...input, sourceMessageId: '2', sourceEventId: '2', triggered: false });
  expect(next?.bindingId).toBe(original.bindingId); expect(next?.sequence).toBe(2);
  const agent = newAgent({ name: 'New destination' });
  saveGatewayInstance({ ...f.config, target: { kind: 'agent', id: agent.id } }, f.instance.id);
  expect(f.inbox.accept(input)).toBeNull();
});

it('keeps an entire unresolved conversation and rejects a stale cleanup selection atomically', async () => {
  const f = await fixture(); f.accept(); const first = f.complete();
  expect(gatewayCleanupCandidates(f.inbox.list(), Date.now()).map((event) => event.id)).toEqual([first.id]);
  f.accept('2');
  expect(gatewayCleanupCandidates(f.inbox.list(), Date.now())).toEqual([]);
  expect(() => f.cleanup([first.id])).toThrow('no longer eligible');
  expect(f.inbox.list()).toHaveLength(2);
  expect((readJSON(f.state.inboxFile()) as GatewayInboxJournal).retired).toBeUndefined();
});

it('does not remove ambiguous or in-flight deliveries', async () => {
  const f = await fixture(); f.accept(); const claimed = f.inbox.claimNext()!;
  f.inbox.beginDispatch(claimed.id, claimed.operationId!, await gatewayConversation(claimed, f.signal));
  f.inbox.finishDispatch(claimed.id, claimed.operationId!, 'Chosen answer');
  expect(() => f.cleanup()).toThrow('no longer eligible');
  f.inbox.claimReply(); expect(() => f.cleanup()).toThrow('no longer eligible');
  f.inbox.settleReply(claimed.id, 0, { status: 'uncertain' }); expect(() => f.cleanup()).toThrow('no longer eligible');
  expect(f.inbox.list()[0].reply?.parts[0].status).toBe('uncertain');
});

it('preserves failed and successful incoming byte reservations and keeps uploaded files', async () => {
  const f = await fixture(); saveGatewayInstance({ ...f.config, fileLimits: { perFileBytes: 5, perMessageBytes: 10, filesPerMessage: 2, dailyBytes: 10 } }, f.instance.id);
  let downloads = 0;
  const processor = new GatewayFileProcessor(f.instance.id, f.inbox, async () => { if (++downloads === 1) throw new Error('Temporary failure'); return { source: Readable.from([Buffer.from('hello')]), declaredBytes: 5 }; }, f.signal);
  closes.push(() => processor.stop());
  const first = f.inbox.accept({ ...gatewayInput(), accountId: f.instance.accountId, media: [{ kind: 'file', fileId: 'one', name: 'one.txt', size: 5 }] })!;
  await processor.start(); f.inbox.retryFiles(first.id); await processor.wake(); f.complete();
  const file = f.inbox.list()[0].files![0].file!.path;
  expect(f.cleanup().removed).toBe(1); expect(fs.readFileSync(file, 'utf8')).toBe('hello');
  await f.state.disconnect(); await f.state.connect();
  f.inbox.accept({ ...gatewayInput('2'), accountId: f.instance.accountId, media: [{ kind: 'file', fileId: 'two', size: 5 }] }); await processor.wake();
  expect(downloads).toBe(2); expect(f.inbox.list()[0].files?.[0].status).toBe('failed');
  expect((readJSON(f.state.inboxFile()) as GatewayInboxJournal).retiredQuota?.[0].incomingBytes).toBe(10);
});

it('keeps outgoing reservations after failed attempts and an explicit skip', async () => {
  const f = await fixture(); saveGatewayInstance({ ...f.config, fileLimits: { perFileBytes: 5, perMessageBytes: 10, filesPerMessage: 2, dailyBytes: 10 } }, f.instance.id);
  const stage = async () => {
    const event = f.inbox.claimNext()!; f.inbox.beginDispatch(event.id, event.operationId!, await gatewayConversation(event, f.signal));
    f.inbox.selectOutgoing(event.id, [{ path: '/unused-path', name: 'report.txt', size: 5, sha256: 'a'.repeat(64) }]);
    f.inbox.finishDispatch(event.id, event.operationId!, 'Final reply'); f.inbox.claimReply(); f.inbox.settleReply(event.id, 0, { remoteId: 'text-confirmed' }); return event;
  };
  f.accept(); const first = await stage(); f.inbox.claimOutgoing(); f.inbox.settleOutgoing(first.id, 0, { status: 'failed' });
  f.inbox.changeOutgoing(first.id, 0, 'retry'); f.inbox.claimOutgoing(); f.inbox.settleOutgoing(first.id, 0, { status: 'uncertain' });
  f.inbox.changeOutgoing(first.id, 0, 'skip'); f.cleanup();
  await f.state.disconnect(); await f.state.connect(); f.accept('2'); await stage();
  expect(f.inbox.claimOutgoing()).toBeNull(); expect(f.inbox.list()[0].outgoing?.[0].status).toBe('failed');
  expect((readJSON(f.state.inboxFile()) as GatewayInboxJournal).retiredQuota?.[0].outgoingBytes).toBe(10);
});

it('cleans paused instances under exclusive ownership without enabling a transport', async () => {
  const f = await fixture(); f.accept(); const first = f.complete(); saveGatewayInstance({ ...f.config, enabled: false }, f.instance.id);
  const supervisor = new GatewaySupervisor(() => { throw new Error('Must not start a transport'); }); closes.push(() => supervisor.stop());
  await expect(supervisor.cleanup(f.instance.id, { before: Date.now(), eventIds: [first.id] })).rejects.toMatchObject({ status: 400 });
  expect(f.inbox.list()).toHaveLength(1); await f.state.disconnect();
  expect(await supervisor.cleanup(f.instance.id, { before: Date.now(), eventIds: [first.id] })).toEqual({ removed: 1 });
  await f.state.connect(); expect(f.inbox.list()).toEqual([]);
});

it('frees a full inbox without rewinding sequence numbers or forgetting replay markers', async () => {
  const f = await fixture(); f.accept(); const original = f.complete();
  const journal = readJSON(f.state.inboxFile()) as GatewayInboxJournal;
  journal.events = Array.from({ length: 10000 }, (_, i) => {
    const id = String(i + 1); const input = { ...original.input, sourceMessageId: id, sourceEventId: id };
    return { ...original, input, sequence: i + 1, receivedAt: 1, id: hash([f.instance.id, input.accountId, input.conversationId, input.threadId, id, 'message']) };
  }); journal.nextSequence = 10001; writeJSON(f.state.inboxFile(), journal);
  expect(() => f.accept('10001')).toThrow('full');
  expect(f.cleanup(journal.events.slice(0, 2).map((event) => event.id)).removed).toBe(2);
  expect(f.accept('10001').sequence).toBe(10001);
  expect(f.inbox.accept(journal.events[0].input)).toBeNull();
});

it('fails closed when the replay-marker capacity is exhausted', async () => {
  const f = await fixture(); f.accept(); const original = f.complete();
  const journal = readJSON(f.state.inboxFile()) as GatewayInboxJournal;
  journal.retired = Array.from({ length: 100000 }, (_, i) => hash(['retired', i])); journal.retiredQuota = []; writeJSON(f.state.inboxFile(), journal);
  expect(() => f.cleanup([original.id])).toThrow('replay-protection store is full');
  expect(f.inbox.list()).toHaveLength(1);
});

it('refuses corrupt replay markers without resetting or rewriting them', async () => {
  const f = await fixture(); f.accept(); f.complete();
  const journal = readJSON(f.state.inboxFile()) as GatewayInboxJournal;
  journal.retired = [hash('old'), hash('old')]; journal.retiredQuota = []; writeJSON(f.state.inboxFile(), journal);
  const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
  expect(() => f.inbox.list()).toThrow('replay or quota receipts are inconsistent');
  expect(() => gatewayInboxHistory(f.instance.id)).toThrow('unreadable');
  expect(() => f.inbox.accept({ ...gatewayInput('2'), accountId: f.instance.accountId })).toThrow();
  expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
});

it('refuses a compacted journal with missing byte accounting', async () => {
  const f = await fixture(); f.accept(); f.complete(); f.cleanup();
  const journal = readJSON(f.state.inboxFile()) as GatewayInboxJournal;
  delete journal.retiredQuota; writeJSON(f.state.inboxFile(), journal);
  expect(() => f.inbox.list()).toThrow('replay or quota receipts are inconsistent');
  expect(() => gatewayInboxHistory(f.instance.id)).toThrow('unreadable');
});
