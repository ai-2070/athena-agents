import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayOutboxJournal } from '../../shared/types.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayOutboxLedger, gatewayOutboxProtectedBindings } from '../../server/gateways/outbox.ts';
import { GatewayReplies, GatewaySendError } from '../../server/gateways/replies.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

const closes: (() => Promise<void>)[] = [];
let accounts = 9570000000;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture(platform: 'telegram' | 'discord' = 'telegram') {
  const config = {
    ...gatewayConfig(String(accounts++)),
    platform,
    senderPolicy: { platform, allowedUserIds: ['123'] },
    scope: { directMessages: true, conversationIds: [], guildIds: [] },
  };
  const instance = saveGatewayInstance(config);
  saveGatewayCredentials(instance.id, { botToken: 'PRIVATE_BOT_TOKEN' });
  const state = new GatewayStateAdapter(instance.id);
  await state.connect();
  closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state);
  const ledger = new GatewayOutboxLedger(state, inbox);
  const input = (id = '1', conversationId = '123') => ({
    ...gatewayInput(id, conversationId),
    platform,
    accountId: instance.accountId,
  });
  const complete = async (id = '1', conversationId = '123') => {
    const event = inbox.accept(input(id, conversationId))!;
    const claim = inbox.claimNext()!;
    inbox.beginDispatch(event.id, claim.operationId!, await gatewayConversation(claim, new AbortController().signal));
    inbox.finishDispatch(event.id, claim.operationId!, 'Native answer');
    inbox.claimReply();
    inbox.settleReply(event.id, 0, { remoteId: `native-${id}` });
    return inbox.list().find((item) => item.id === event.id)!;
  };
  const event = await complete();
  const request = (parts = ['First approved part', 'Second approved part'], postId = 'post-1', eventId = event.id) => ({
    instanceId: instance.id,
    projectId: instance.projectId,
    postId,
    eventId,
    parts,
  });
  const approve = (parts?: string[], postId?: string, eventId?: string) =>
    ledger.approve(ledger.prepare(request(parts, postId, eventId)).approval);
  return { config, instance, state, inbox, ledger, input, complete, event, request, approve };
}

describe('instance-bound approved Outbox ledger', () => {
  it.each(['telegram', 'discord'] as const)(
    'reviews exact %s text and a real recipient without saving an intent or private input',
    async (platform) => {
      const f = await fixture(platform);
      const preview = f.ledger.prepare(f.request(['Hello 😀']));
      expect(preview.recipient).toEqual({
        platform,
        instanceName: f.instance.name,
        accountId: f.instance.accountId,
        conversationId: '123',
        threadId: '',
        sourceMessageId: '1',
        sender: 'Alice',
      });
      expect(preview.approval).toMatchObject({
        ...f.request(['Hello 😀']),
        revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(JSON.stringify(preview)).not.toContain('PRIVATE_BOT_TOKEN');
      expect(JSON.stringify(preview)).not.toContain('Message 1');
      expect(f.ledger.list()).toEqual([]);
      expect(fs.existsSync(f.state.outboxFile())).toBe(false);
    },
  );

  it('requires a selected instance, correct project and completed unchanged source with confirmed delivery', async () => {
    const f = await fixture();
    for (const body of [
      { ...f.request(), instanceId: 'another' },
      { ...f.request(), projectId: 'another' },
      { ...f.request(), eventId: 'a'.repeat(64) },
      { ...f.request(), parts: [' '] },
      { ...f.request(), parts: ['x'.repeat(3001)] },
      { ...f.request(), parts: ['\ud800'] },
      { ...f.request(), extra: true },
    ])
      expect(() => f.ledger.prepare(body)).toThrow();
    const queued = f.inbox.accept(f.input('2'))!;
    expect(() => f.ledger.prepare(f.request(['Text'], 'post-2', queued.id))).toThrow('completed');
    f.inbox.accept({ ...f.input(), kind: 'edit', sourceEventId: 'edit-1', text: 'Changed' });
    expect(() => f.ledger.prepare(f.request())).toThrow('completed');
    const discord = await fixture('discord');
    expect(() => discord.ledger.prepare(discord.request(['x'.repeat(2001)]))).toThrow('2,000');
  });

  it('does not accept old global tokens or enable Slack and WhatsApp proactive sends', async () => {
    const f = await fixture();
    saveGatewayCredentials(f.instance.id, {});
    expect(() => f.ledger.prepare(f.request())).toThrow('bot token');
    const config = {
      ...gatewayConfig(`T${accounts++}`),
      platform: 'slack',
      senderPolicy: { platform: 'slack', allowedUserIds: ['UALICE'] },
      scope: { directMessages: true, conversationIds: [], guildIds: [] },
    };
    const instance = saveGatewayInstance(config);
    saveGatewayCredentials(instance.id, { botToken: 'PRIVATE_SLACK_TOKEN' });
    const state = new GatewayStateAdapter(instance.id);
    await state.connect();
    closes.push(() => state.disconnect());
    const inbox = new GatewayInbox(state);
    const event = inbox.accept({
      ...gatewayInput(),
      platform: 'slack',
      accountId: instance.accountId,
      conversationId: 'DALICE',
      sourceMessageId: '1700000000.000001',
      actor: { id: 'UALICE', label: 'Alice', kind: 'user' },
    })!;
    const claim = inbox.claimNext()!;
    inbox.beginDispatch(event.id, claim.operationId!, await gatewayConversation(claim, new AbortController().signal));
    inbox.finishDispatch(event.id, claim.operationId!, 'Answer');
    inbox.claimReply();
    inbox.settleReply(event.id, 0, { remoteId: 'native' });
    const ledger = new GatewayOutboxLedger(state, inbox);
    expect(() => ledger.prepare({ ...f.request(), instanceId: instance.id, eventId: event.id })).toThrow(
      'Telegram and Discord only',
    );
  });

  it('refuses stale approval after access, credentials or reviewed text changes', async () => {
    const f = await fixture();
    const approval = f.ledger.prepare(f.request()).approval;
    expect(() => f.ledger.approve({ ...approval, parts: ['Different text'] })).toThrow('changed');
    saveGatewayInstance({ ...f.config, name: 'Another name' }, f.instance.id);
    expect(() => f.ledger.approve(approval)).toThrow('changed');
    saveGatewayInstance(f.config, f.instance.id);
    saveGatewayCredentials(f.instance.id, { botToken: 'NEW_PRIVATE_TOKEN' });
    expect(() => f.ledger.approve(approval)).toThrow('Reconnect');
    expect(f.ledger.list()).toEqual([]);
  });

  it('deduplicates approval without clearing receipts and refuses replacing its text or recipient', async () => {
    const f = await fixture();
    const approval = f.ledger.prepare(f.request()).approval;
    f.ledger.approve(approval);
    const claim = f.ledger.claim()!;
    f.ledger.settle(claim, { remoteId: 'confirmed-first' });
    expect(f.ledger.approve(approval).receipts[0]).toMatchObject({
      status: 'sent',
      remoteId: 'confirmed-first',
      attempts: 1,
    });
    const other = await f.complete('2');
    expect(() => f.ledger.approve(f.ledger.prepare(f.request(['Different'], 'post-1', other.id)).approval)).toThrow(
      'already has',
    );
    expect(f.ledger.list()).toHaveLength(1);
  });

  it('marks parts before I/O, serializes claims and preserves native receipts byte for byte', async () => {
    const f = await fixture();
    const native = fs.readFileSync(f.state.inboxFile(), 'utf8');
    f.approve();
    const sends: string[] = [];
    const replies = new GatewayReplies(
      f.inbox,
      async (event, text, _signal, approved) => {
        expect(f.ledger.list()[0].receipts[sends.length]).toMatchObject({ text, status: 'sending', attempts: 1 });
        expect(approved!.authorize(event, text)).toMatch(/^[a-f0-9]{24}$/);
        expect(f.ledger.claim()).toBeNull();
        sends.push(text);
        return `remote-${sends.length}`;
      },
      new AbortController().signal,
      () => true,
      undefined,
      f.ledger,
    );
    closes.push(() => replies.stop());
    await replies.wake();
    await replies.wake();
    expect(sends).toEqual(f.request().parts);
    expect(f.ledger.list()[0].receipts.map((part) => part.status)).toEqual(['sent', 'sent']);
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(native);
  });

  it('honors provider retry times and never resends confirmed parts', async () => {
    const f = await fixture();
    f.approve();
    const texts: string[] = [];
    let limited = false;
    const replies = new GatewayReplies(
      f.inbox,
      async (_event, text) => {
        texts.push(text);
        if (text.startsWith('Second') && !limited) {
          limited = true;
          throw new GatewaySendError('retry', 7000);
        }
        return `remote-${texts.length}`;
      },
      new AbortController().signal,
      () => true,
      undefined,
      f.ledger,
    );
    closes.push(() => replies.stop());
    await replies.wake();
    const retryAt = f.ledger.list()[0].receipts[1].retryAt!;
    await replies.wake();
    expect(texts).toHaveLength(2);
    vi.spyOn(Date, 'now').mockReturnValue(retryAt);
    await replies.wake();
    expect(texts).toEqual(['First approved part', 'Second approved part', 'Second approved part']);
    expect(f.ledger.list()[0].receipts[1]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it.each(['failed', 'uncertain', 'unknown'] as const)(
    'holds %s outcomes without retrying or losing confirmed IDs',
    async (outcome) => {
      const f = await fixture();
      f.approve();
      let calls = 0;
      const replies = new GatewayReplies(
        f.inbox,
        async () => {
          calls++;
          if (calls === 1) return 'confirmed-first';
          throw outcome === 'unknown' ? new Error('PRIVATE_PROVIDER_DETAIL') : new GatewaySendError(outcome);
        },
        new AbortController().signal,
        () => true,
        undefined,
        f.ledger,
      );
      closes.push(() => replies.stop());
      await replies.wake();
      await replies.wake();
      expect(calls).toBe(2);
      expect(f.ledger.list()[0].receipts).toMatchObject([
        { status: 'sent', remoteId: 'confirmed-first' },
        { status: outcome === 'unknown' ? 'uncertain' : outcome },
      ]);
      expect(fs.readFileSync(f.state.outboxFile(), 'utf8')).not.toContain('PRIVATE_PROVIDER_DETAIL');
    },
  );

  it('recovers a crash as uncertain and rejects an old attempt settlement or authority', async () => {
    const f = await fixture();
    f.approve();
    const claim = f.ledger.claim()!;
    await f.state.disconnect();
    expect(() => f.ledger.list()).toThrow('not connected');
    await f.state.connect();
    const recovered = new GatewayOutboxLedger(f.state, f.inbox);
    recovered.recover();
    expect(recovered.list()[0].receipts[0]).toMatchObject({ status: 'uncertain', attempts: 1 });
    expect(recovered.claim()).toBeNull();
    expect(() => recovered.settle(claim, { remoteId: 'late' })).toThrow('no longer owns');
    expect(() => recovered.authorize(claim, claim.event, claim.text)).toThrow('no longer current');
  });

  it('stops at the original instance, access and source boundaries even after a claim', async () => {
    const f = await fixture();
    f.approve();
    const claim = f.ledger.claim()!;
    expect(() =>
      f.ledger.authorize(claim, { ...claim.event, input: { ...claim.event.input, conversationId: '456' } }, claim.text),
    ).toThrow('changed');
    expect(() => f.ledger.authorize(claim, claim.event, 'Unapproved text')).toThrow('no longer current');
    saveGatewayInstance({ ...f.config, enabled: false }, f.instance.id);
    expect(() => f.ledger.authorize(claim, claim.event, claim.text)).toThrow();
    f.ledger.settle(claim, { status: 'failed' });
    saveGatewayInstance(f.config, f.instance.id);
    expect(f.ledger.claim()).toBeNull();
    const other = await fixture();
    other.approve();
    saveGatewayInstance(
      { ...other.config, senderPolicy: { platform: 'telegram', allowedUserIds: ['456'] } },
      other.instance.id,
    );
    expect(other.ledger.claim()).toBeNull();
    expect(other.ledger.list()[0]).toMatchObject({
      held: 'destination-changed',
      receipts: [{ attempts: 0 }, { attempts: 0 }],
    });
  });

  it('blocks later sends in the same binding while allowing an unrelated conversation to progress', async () => {
    const f = await fixture();
    f.approve(['First'], 'post-1');
    f.approve(['Later'], 'post-2');
    const unrelated = await f.complete('2', '456');
    f.approve(['Unrelated'], 'post-3', unrelated.id);
    const first = f.ledger.claim()!;
    f.ledger.settle(first, { status: 'uncertain' });
    expect(f.ledger.claim()).toMatchObject({ postId: 'post-3', text: 'Unrelated' });
  });

  it('prevents cleanup of unresolved source bindings and releases them only after all parts are confirmed', async () => {
    const f = await fixture();
    f.approve();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000);
    expect(gatewayOutboxProtectedBindings(f.instance.id)).toEqual(new Set([f.event.bindingId]));
    expect(() => f.inbox.cleanup({ before: Date.now(), eventIds: [f.event.id] })).toThrow('Outbox delivery');
    let claim = f.ledger.claim()!;
    f.ledger.settle(claim, { remoteId: 'first' });
    claim = f.ledger.claim()!;
    f.ledger.settle(claim, { remoteId: 'second' });
    expect(gatewayOutboxProtectedBindings(f.instance.id).size).toBe(0);
    expect(f.inbox.cleanup({ before: Date.now(), eventIds: [f.event.id] })).toEqual({ removed: 1 });
    expect(f.ledger.list()[0].receipts.map((part) => part.remoteId)).toEqual(['first', 'second']);
  });

  it('refuses inconsistent, foreign and duplicate receipts without resetting evidence', async () => {
    const f = await fixture();
    f.approve();
    const original = fs.readFileSync(f.state.outboxFile(), 'utf8');
    const mutations: ((journal: GatewayOutboxJournal) => void)[] = [
      (journal) => {
        journal.deliveries.push(structuredClone(journal.deliveries[0]));
      },
      (journal) => {
        journal.deliveries[0].instanceId = 'foreign';
      },
      (journal) => {
        journal.deliveries[0].receipts[0].text = 'Changed';
      },
      (journal) => {
        journal.deliveries[0].receipts[0].status = 'sent';
      },
      (journal) => {
        journal.deliveries[0].receipts[1] = { text: 'Second approved part', status: 'uncertain', attempts: 1 };
      },
    ];
    for (const mutate of mutations) {
      const value = JSON.parse(original) as GatewayOutboxJournal;
      mutate(value);
      const bytes = JSON.stringify(value);
      fs.writeFileSync(f.state.outboxFile(), bytes);
      expect(() => f.ledger.recover()).toThrow('unreadable');
      expect(fs.readFileSync(f.state.outboxFile(), 'utf8')).toBe(bytes);
    }
    fs.writeFileSync(f.state.outboxFile(), '{broken');
    expect(() => f.inbox.cleanup({ before: Date.now() + 1, eventIds: [f.event.id] })).toThrow();
  });

  it('never claims or sends after a failed durable write and leaves the previous ledger intact', async () => {
    const f = await fixture();
    f.approve();
    const original = fs.readFileSync(f.state.outboxFile(), 'utf8');
    const write = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).includes('outbox.json')) throw new Error('PRIVATE_DISK_PATH');
      return write(file, ...args);
    });
    expect(() => f.ledger.claim()).toThrow('could not be saved');
    expect(fs.readFileSync(f.state.outboxFile(), 'utf8')).toBe(original);
  });
});
