import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayInboxJournal } from '../../shared/types.ts';
import { gatewayCleanupCandidates, gatewayNeedsReview } from '../../shared/gateways.ts';
import { GatewayInbox, gatewayDeliveryReview, gatewayInboxHistory } from '../../server/gateways/inbox.ts';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { GatewayWorker } from '../../server/gateways/worker.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

const closes: (() => Promise<void>)[] = [];
let accounts = 9600000000;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture() {
  const config = gatewayConfig(String(accounts++));
  const instance = saveGatewayInstance(config);
  const state = new GatewayStateAdapter(instance.id);
  await state.connect();
  closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state);
  const input = (id = '1', conversationId = '123') => ({
    ...gatewayInput(id, conversationId),
    accountId: instance.accountId,
  });
  const first = inbox.accept(input())!;
  const claimed = inbox.claimNext()!;
  inbox.beginDispatch(first.id, claimed.operationId!, await gatewayConversation(claimed, new AbortController().signal));
  inbox.queueNotice(first.id, 'working');
  inbox.claimNotice();
  inbox.settleNotice(first.id, 'working', { status: 'uncertain' });
  inbox.selectOutgoing(first.id, [{ path: '/unused/report.txt', name: 'report.txt', size: 5, sha256: 'a'.repeat(64) }]);
  inbox.finishDispatch(first.id, claimed.operationId!, 'a'.repeat(6100));
  inbox.claimReply();
  inbox.settleReply(first.id, 0, { remoteId: 'confirmed-prefix' });
  inbox.claimReply();
  inbox.settleReply(first.id, 1, { status: 'uncertain' });
  const pause = () => saveGatewayInstance({ ...config, enabled: false }, instance.id);
  const preview = (id = first.id) => gatewayDeliveryReview(instance.id, id);
  const confirm = (target: unknown = { kind: 'text', index: 1 }, remoteId = 'confirmed-in-app') => ({
    action: 'confirm',
    revision: preview().revision,
    target,
    remoteId,
    acknowledgeChecked: true,
  });
  const finish = () => ({ action: 'finish-local', revision: preview().revision, acknowledgeNoSend: true });
  const mutate = (change: (journal: GatewayInboxJournal) => void) => {
    const journal = JSON.parse(fs.readFileSync(state.inboxFile(), 'utf8')) as GatewayInboxJournal;
    change(journal);
    fs.writeFileSync(state.inboxFile(), JSON.stringify(journal));
  };
  return { config, instance, state, inbox, first, input, pause, preview, confirm, finish, mutate };
}

describe('paused gateway delivery review', () => {
  it.each(['slack', 'discord'] as const)(
    'reviews %s deliveries locally under the same paused ownership rules',
    async (platform) => {
      const account = String(accounts++);
      const config = {
        ...gatewayConfig(platform === 'slack' ? `T${account}` : account),
        platform,
        senderPolicy: { platform, allowedUserIds: [platform === 'slack' ? 'UALICE' : '123'] },
        scope: { directMessages: true, conversationIds: [], guildIds: [] },
      };
      const instance = saveGatewayInstance(config);
      const state = new GatewayStateAdapter(instance.id);
      await state.connect();
      closes.push(() => state.disconnect());
      const inbox = new GatewayInbox(state);
      const input = {
        ...gatewayInput(),
        platform,
        accountId: instance.accountId,
        conversationId: platform === 'slack' ? 'DALICE' : '123',
        actor: { id: platform === 'slack' ? 'UALICE' : '123', label: 'Alice', kind: 'user' as const },
        sourceMessageId: platform === 'slack' ? '1700000000.000001' : '1',
      };
      const event = inbox.accept(input)!;
      const work = inbox.claimNext()!;
      inbox.beginDispatch(event.id, work.operationId!, await gatewayConversation(work, new AbortController().signal));
      inbox.finishDispatch(event.id, work.operationId!, 'Answer');
      inbox.claimReply();
      inbox.settleReply(event.id, 0, { status: 'uncertain' });
      saveGatewayInstance({ ...config, enabled: false }, instance.id);
      await state.disconnect();
      const supervisor = new GatewaySupervisor(() => {
        throw new Error('No transport');
      });
      closes.push(() => supervisor.stop());
      const preview = gatewayDeliveryReview(instance.id, event.id);
      expect(preview.source.platform).toBe(platform);
      expect(
        (
          await supervisor.reviewDelivery(instance.id, event.id, {
            action: 'confirm',
            revision: preview.revision,
            target: { kind: 'text', index: 0 },
            remoteId: 'app-message',
            acknowledgeChecked: true,
          })
        ).items[0].status,
      ).toBe('sent');
    },
  );

  it('records only the chosen attempted uncertain text, keeping the confirmed prefix and native work intact', async () => {
    const f = await fixture();
    f.pause();
    const before = structuredClone(f.inbox.list()[0]);
    const body = f.confirm();
    expect(f.preview().items.map((item) => item.canConfirm)).toEqual([false, true, false, false, true]);
    f.inbox.reviewDelivery(f.first.id, body);
    const after = f.inbox.list()[0];
    expect(after).toEqual({
      ...before,
      reply: {
        ...before.reply,
        parts: [
          before.reply!.parts[0],
          { ...before.reply!.parts[1], status: 'sent', remoteId: 'confirmed-in-app' },
          before.reply!.parts[2],
        ],
      },
      deliveryReviews: [
        {
          action: 'confirmed',
          at: expect.any(Number),
          revision: body.revision,
          target: body.target,
          remoteId: 'confirmed-in-app',
        },
      ],
    });
    expect(f.preview().items[1]).toMatchObject({
      status: 'sent',
      remoteId: 'confirmed-in-app',
      confirmedAt: expect.any(Number),
      canConfirm: false,
    });
    saveGatewayInstance(f.config, f.instance.id);
    expect(f.inbox.claimReply()).toMatchObject({ event: { id: f.first.id }, index: 2 });
  });

  it('confirms attempted files and advisory notices without changing quotas or sending', async () => {
    const f = await fixture();
    f.pause();
    f.inbox.reviewDelivery(f.first.id, f.confirm({ kind: 'notice', notice: 'working' }));
    f.mutate((journal) => {
      const event = journal.events[0];
      event.reply!.parts.forEach((part) => {
        part.status = 'sent';
        part.remoteId = 'saved-text';
      });
    });
    saveGatewayInstance(f.config, f.instance.id);
    f.inbox.claimOutgoing();
    f.inbox.settleOutgoing(f.first.id, 0, { status: 'uncertain' });
    f.pause();
    const before = structuredClone(f.inbox.list()[0].outgoing![0]);
    f.inbox.reviewDelivery(f.first.id, f.confirm({ kind: 'file', index: 0 }, 'document-123'));
    expect(f.inbox.list()[0].outgoing![0]).toEqual({
      path: before.path,
      name: before.name,
      size: before.size,
      sha256: before.sha256,
      status: 'sent',
      attempts: before.attempts,
      remoteId: 'document-123',
    });
    expect(f.preview()).toMatchObject({ canFinish: false, reason: 'No unresolved delivery needs review.' });
  });

  it('permanently finishes delivery while preserving uncertainty, pending parts, attempts and native operation IDs', async () => {
    const f = await fixture();
    const later = f.inbox.accept(f.input('2'))!;
    expect(f.inbox.claimNext()).toBeNull();
    f.pause();
    const before = structuredClone(f.inbox.list()[0]);
    const body = f.finish();
    f.inbox.reviewDelivery(f.first.id, body);
    const closed = f.inbox.list()[0];
    expect(closed).toEqual({
      ...before,
      deliveryFinished: { at: expect.any(Number), revision: body.revision },
      deliveryReviews: [{ action: 'finish-local', at: expect.any(Number), revision: body.revision }],
    });
    expect(gatewayNeedsReview(closed)).toBe(false);
    expect(f.preview().closedAt).toBeDefined();
    expect(() => f.inbox.retryReply(closed.id)).toThrow('finished locally');
    expect(() => f.inbox.changeOutgoing(closed.id, 0, 'skip')).toThrow();
    expect(() => f.inbox.selectOutgoing(closed.id, [])).toThrow();
    expect(() => f.inbox.reviewDelivery(closed.id, f.finish())).toThrow('finished locally');
    f.inbox.review(closed.id);
    f.inbox.holdInput(closed.id, 'Later hold');
    expect(f.inbox.list()[0]).toEqual(closed);
    await f.state.disconnect();
    await f.state.connect();
    f.inbox.recover();
    expect(f.inbox.list()[0]).toEqual(closed);
    saveGatewayInstance(f.config, f.instance.id);
    expect(f.inbox.claimReply()).toBeNull();
    expect(f.inbox.claimOutgoing()).toBeNull();
    expect(f.inbox.claimNotice()).toBeNull();
    const next = f.inbox.claimNext()!;
    expect(next.id).toBe(later.id);
    f.inbox.beginDispatch(next.id, next.operationId!, await gatewayConversation(next, new AbortController().signal));
    f.inbox.finishDispatch(next.id, next.operationId!, 'Next answer');
    expect(f.inbox.claimReply()!.event.id).toBe(next.id);
    f.inbox.settleReply(next.id, 0, { remoteId: 'next-delivered' });
    expect(f.inbox.list()[0]).toEqual(closed);
  });

  it('keeps replay protection and charged file bytes when a locally finished receipt is cleaned', async () => {
    const f = await fixture();
    f.mutate((journal) => {
      journal.events[0].outgoing![0].attempts = [{ day: new Date().toISOString().slice(0, 10), bytes: 5 }];
      journal.events[0].outgoing![0].status = 'uncertain';
    });
    f.pause();
    f.inbox.reviewDelivery(f.first.id, f.finish());
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    expect(gatewayCleanupCandidates(f.inbox.list(), Date.now()).map((item) => item.id)).toEqual([f.first.id]);
    expect(f.inbox.cleanup({ before: Date.now(), eventIds: [f.first.id] })).toEqual({ removed: 1 });
    expect(
      (JSON.parse(fs.readFileSync(f.state.inboxFile(), 'utf8')) as GatewayInboxJournal).retiredQuota?.[0].outgoingBytes,
    ).toBe(5);
    saveGatewayInstance(f.config, f.instance.id);
    expect(f.inbox.accept(f.input())).toBeNull();
  });

  it('requires a current paused snapshot, exact target and explicit acknowledgement', async () => {
    const f = await fixture();
    expect(() => f.inbox.reviewDelivery(f.first.id, f.finish())).toThrow('Pause');
    f.pause();
    const body = f.confirm();
    for (const input of [
      {},
      { ...body, acknowledgeChecked: false },
      { ...body, extra: true },
      { ...body, target: { kind: 'text', index: 0 } },
      { ...body, target: { kind: 'text', index: 2 } },
      { ...body, target: { kind: 'text', index: 2000 } },
      ...['', ' ', 'two ids', 'x'.repeat(501)].map((remoteId) => ({ ...body, remoteId })),
    ])
      expect(() => f.inbox.reviewDelivery(f.first.id, input)).toThrow();
    saveGatewayInstance({ ...f.config, enabled: false, name: 'Renamed' }, f.instance.id);
    expect(() => f.inbox.reviewDelivery(f.first.id, body)).toThrow('changed');
    const current = f.confirm();
    f.inbox.reviewDelivery(f.first.id, current);
    expect(() => f.inbox.reviewDelivery(f.first.id, current)).toThrow('changed');
  });

  it.each(['pending', 'failed', 'sent', 'unattempted'] as const)(
    'does not promote %s receipts to operator-confirmed delivery',
    async (status) => {
      const f = await fixture();
      f.mutate((journal) => {
        const part = journal.events[0].reply!.parts[1];
        if (status === 'unattempted') part.attempts = 0;
        else part.status = status;
      });
      f.pause();
      expect(() => f.inbox.reviewDelivery(f.first.id, f.confirm())).toThrow('Only an attempted uncertain');
    },
  );

  it.each(['running', 'needs-review', 'no-reply'] as const)('does not finish %s native work', async (kind) => {
    const f = await fixture();
    f.mutate((journal) => {
      const event = journal.events[0];
      if (kind === 'no-reply') delete event.reply;
      else event.status = kind;
    });
    f.pause();
    expect(f.preview().canFinish).toBe(false);
    expect(() => f.inbox.prepareDeliveryReview(f.first.id)).toThrow('completed');
    expect(() => f.inbox.reviewDelivery(f.first.id, f.finish())).toThrow('completed');
  });

  it('only recovers the selected completed receipt and leaves unrelated native work and sends untouched', async () => {
    const f = await fixture();
    f.inbox.accept(f.input('other', '456'));
    const active = f.inbox.claimNext()!;
    f.inbox.beginDispatch(
      active.id,
      active.operationId!,
      await gatewayConversation(active, new AbortController().signal),
    );
    f.inbox.queueNotice(active.id, 'working');
    f.inbox.claimNotice();
    f.mutate((journal) => {
      journal.events[0].reply!.parts[1].status = 'sending';
      journal.events[0].outgoing![0].status = 'sending';
      journal.events[0].outgoing![0].attempts = [{ day: new Date().toISOString().slice(0, 10), bytes: 5 }];
    });
    f.pause();
    const before = structuredClone(f.inbox.list()[1]);
    expect(f.preview().needsPrepare).toBe(true);
    expect(() => f.inbox.reviewDelivery(f.first.id, f.finish())).toThrow('Recover');
    const snapshot = fs.readFileSync(f.state.inboxFile(), 'utf8');
    f.preview();
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(snapshot);
    f.inbox.prepareDeliveryReview(f.first.id);
    expect(f.preview().needsPrepare).toBe(false);
    expect(f.inbox.list()[1]).toEqual(before);
    expect(f.inbox.list()[0].outgoing![0].status).toBe('uncertain');
    expect(() => f.inbox.prepareDeliveryReview(active.id)).toThrow('completed');
    expect(() => f.inbox.reviewDelivery(active.id, f.finish())).toThrow();
  });

  it('can close old delivery after sender permission changes without granting transport access', async () => {
    const f = await fixture();
    saveGatewayInstance(
      { ...f.config, enabled: false, senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } },
      f.instance.id,
    );
    expect(() => f.inbox.checkAccess(f.inbox.list()[0])).toThrow();
    f.inbox.reviewDelivery(f.first.id, f.confirm());
    f.inbox.reviewDelivery(f.first.id, f.finish());
    expect(f.preview().closedAt).toBeDefined();
  });

  it('binds a confirmation to one event and retains its closed evidence after a later source edit', async () => {
    const f = await fixture();
    f.pause();
    const body = f.finish();
    f.mutate((journal) => {
      const original = journal.events[0];
      journal.events.push({
        ...structuredClone(original),
        id: 'other-event',
        sequence: 2,
        input: { ...original.input, sourceMessageId: 'other', sourceEventId: 'other' },
      });
      journal.nextSequence = 3;
    });
    expect(() => f.inbox.reviewDelivery('other-event', body)).toThrow('changed');
    const selected = f.finish();
    expect(() => f.inbox.reviewDelivery('other-event', selected)).toThrow('changed');
    f.inbox.reviewDelivery(f.first.id, selected);
    const closed = structuredClone(f.inbox.list()[0]);
    saveGatewayInstance(f.config, f.instance.id);
    f.inbox.accept({ ...f.input(), sourceEventId: 'edited', kind: 'edit', text: 'Changed source' });
    expect(f.inbox.list()[0]).toEqual(closed);
  });

  it('drains a worker before local review and hides failures from transport shutdown', async () => {
    const f = await fixture();
    await f.state.disconnect();
    let reject = true;
    const stopped = vi.fn(async () => {
      if (reject) throw Object.assign(new Error('PRIVATE_TRANSPORT'), { status: 503 });
    });
    const worker = new GatewayWorker(f.instance.id);
    vi.spyOn(worker, 'start').mockResolvedValue(undefined);
    vi.spyOn(worker, 'stop').mockImplementation(stopped);
    const supervisor = new GatewaySupervisor(() => worker);
    closes.push(() => supervisor.stop());
    await supervisor.start();
    f.pause();
    await expect(supervisor.reviewDelivery(f.instance.id, f.first.id, f.finish())).rejects.toThrow(
      'could not be reviewed safely',
    );
    expect(stopped).toHaveBeenCalled();
    reject = false;
    expect((await supervisor.prepareDeliveryReview(f.instance.id, f.first.id)).needsPrepare).toBe(false);
    expect((await supervisor.reviewDelivery(f.instance.id, f.first.id, f.finish())).closedAt).toBeDefined();
  });

  it('saves atomically, takes exclusive ownership, and never constructs a transport', async () => {
    const f = await fixture();
    f.pause();
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    const write = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).includes('inbox.json')) throw new Error('PRIVATE_DISK');
      return write(file, ...args);
    });
    expect(() => f.inbox.reviewDelivery(f.first.id, f.finish())).toThrow('could not be saved');
    vi.restoreAllMocks();
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
    const supervisor = new GatewaySupervisor(() => {
      throw new Error('Must never construct a transport');
    });
    closes.push(() => supervisor.stop());
    await expect(supervisor.reviewDelivery(f.instance.id, f.first.id, f.finish())).rejects.toMatchObject({
      status: 503,
    });
    await f.state.disconnect();
    const result = await supervisor.reviewDelivery(f.instance.id, f.first.id, f.finish());
    expect(result.closedAt).toBeDefined();
    expect(gatewayInboxHistory(f.instance.id)[0].deliveryFinished).toBeDefined();
  });

  it('rejects forged close markers and audit targets, and does not evict full review history', async () => {
    const f = await fixture();
    f.pause();
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    f.mutate((journal) => {
      journal.events[0].deliveryFinished = { at: 1, revision: 'a'.repeat(64) };
    });
    expect(() => f.preview()).toThrow();
    fs.writeFileSync(f.state.inboxFile(), before);
    f.mutate((journal) => {
      journal.events[0].deliveryReviews = [
        {
          at: 1,
          revision: 'a'.repeat(64),
          action: 'confirmed',
          target: { kind: 'file', index: 0 },
          remoteId: 'forged',
        },
      ];
    });
    expect(() => f.preview()).toThrow();
    fs.writeFileSync(f.state.inboxFile(), before);
    f.mutate((journal) => {
      const event = journal.events[0];
      event.deliveryReviews = Array.from({ length: 3000 }, (_, index) => ({
        at: index,
        revision: crypto.createHash('sha256').update(String(index)).digest('hex'),
        action: 'confirmed' as const,
        target: { kind: 'text' as const, index: 0 },
        remoteId: 'confirmed-prefix',
      }));
    });
    expect(f.preview().reason).toContain('history is full');
    expect(() => f.inbox.reviewDelivery(f.first.id, f.finish())).toThrow('history is full');
  });
});
