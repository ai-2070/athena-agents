import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayDispatcher } from '../../server/gateways/dispatch.ts';
import { GatewayReplies, GatewaySendError } from '../../server/gateways/replies.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import type { GatewayCompletion, GatewayExecutionServices } from '../../server/gateways/execution.ts';
import type { GatewayReplySender } from '../../server/gateways/replies.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

let account = 60000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const config = gatewayConfig(String(account++)); const instance = saveGatewayInstance(config);
  const state = new GatewayStateAdapter(instance.id); await state.connect();
  const inbox = new GatewayInbox(state); const abort = new AbortController();
  cleanups.push(() => state.disconnect());
  const accept = (id = '1', conversationId = '123') => inbox.accept({ ...gatewayInput(id, conversationId), accountId: instance.accountId })!;
  const outcomes = new Map<string, GatewayCompletion>(); const submissions: string[] = [];
  const services: GatewayExecutionServices = {
    submit: async (event) => {
      expect(inbox.list().find((item) => item.id === event.id)?.dispatch?.state).toBe('starting');
      submissions.push(event.id); return {};
    },
    poll: (event) => outcomes.get(event.id) ?? { state: 'pending' },
  };
  const dispatcher = new GatewayDispatcher(inbox, abort.signal, services);
  cleanups.push(() => dispatcher.stop());
  const replies = (send: GatewayReplySender) => {
    const worker = new GatewayReplies(inbox, send, abort.signal); cleanups.push(() => worker.stop()); return worker;
  };
  const finish = async (text: string, id = '1', chat = '123') => {
    const input = accept(id, chat); const claimed = inbox.claimNext()!;
    const local = await gatewayConversation(claimed, abort.signal);
    inbox.beginDispatch(input.id, claimed.operationId!, local); inbox.finishDispatch(input.id, claimed.operationId!, text);
    return input.id;
  };
  return { config, instance, state, inbox, abort, accept, outcomes, submissions, services, dispatcher, replies, finish };
}

describe('gateway dispatch and reply receipts', () => {
  it('sends one delayed working notice while a long Brain submission is still pending', async () => {
    const f = await fixture(); f.accept();
    let finish: (() => void) | undefined;
    f.services.submit = () => new Promise((resolve) => { finish = () => resolve({}); });
    await f.dispatcher.start();
    await expect.poll(() => Boolean(finish)).toBe(true);
    const sent: string[] = [];
    const sender = f.replies(async (_event, text) => { sent.push(text); return 'working-id'; });
    await sender.wake(); expect(sent).toEqual([]);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
    await f.dispatcher.wake(); await sender.wake();
    expect(sent).toEqual(['Working on it in Athena.']);
    f.inbox.recover(); await f.dispatcher.wake(); await sender.wake();
    expect(sent).toHaveLength(1);
    expect(f.inbox.list()[0].notices?.working?.remoteId).toBe('working-id');
    finish!();
  });

  it('sends only a fixed approval notice and suppresses later working notices for the same operation', async () => {
    const f = await fixture(); f.accept(); f.services.approvalPending = () => true;
    await f.dispatcher.start();
    await expect.poll(() => f.inbox.list()[0].notices?.approval?.status).toBe('pending');
    const sent: string[] = [];
    const sender = f.replies(async (_event, text) => { sent.push(text); return 'approval-id'; });
    await sender.wake();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6000);
    f.services.approvalPending = () => false;
    await f.dispatcher.wake(); await sender.wake();
    expect(sent).toEqual(['Needs approval in Athena.']);
    expect(f.inbox.list()[0].notices?.working).toBeUndefined();
  });

  it('holds ambiguous notices without blocking the final answer and cancels stale notices', async () => {
    const f = await fixture(); const accepted = f.accept();
    await f.dispatcher.start();
    await expect.poll(() => f.inbox.list()[0].dispatch?.state).toBe('running');
    f.inbox.queueNotice(accepted.id, 'working');
    let fail = true; const sent: string[] = [];
    const sender = f.replies(async (_event, text) => { sent.push(text); if (fail) throw new Error('private failure'); return 'final-id'; });
    await sender.wake(); expect(f.inbox.list()[0].notices?.working?.status).toBe('uncertain');
    f.inbox.recover(); await sender.wake(); expect(sent).toHaveLength(1);
    f.inbox.queueNotice(accepted.id, 'approval'); fail = false;
    f.outcomes.set(accepted.id, { state: 'completed', answer: 'Final answer' });
    await f.dispatcher.wake(); await sender.wake();
    expect(sent).toEqual(['Working on it in Athena.', 'Final answer']);
    expect(f.inbox.list()[0].notices?.approval?.status).toBe('failed');
  });

  it('rechecks approval presence and sender access immediately before sending notices', async () => {
    const f = await fixture(); const accepted = f.accept(); await f.dispatcher.start();
    await expect.poll(() => f.inbox.list()[0].dispatch?.state).toBe('running');
    f.inbox.queueNotice(accepted.id, 'approval');
    let sends = 0;
    const sender = new GatewayReplies(f.inbox, async () => { sends++; return 'unexpected'; }, f.abort.signal, () => false);
    cleanups.push(() => sender.stop());
    await sender.wake(); expect(sends).toBe(0);
    expect(f.inbox.list()[0].notices?.approval?.status).toBe('failed');
    const other = f.accept('2', '456'); await f.dispatcher.wake();
    await expect.poll(() => f.inbox.list().find((item) => item.id === other.id)?.dispatch?.state).toBe('running');
    f.inbox.queueNotice(other.id, 'working');
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } }, f.instance.id);
    await f.replies(async () => { sends++; return 'unexpected'; }).wake();
    expect(sends).toBe(0);
  });

  it('persists notice rate limits and treats interrupted notice sends as uncertain', async () => {
    const f = await fixture(); const accepted = f.accept(); await f.dispatcher.start();
    await expect.poll(() => f.inbox.list()[0].dispatch?.state).toBe('running');
    f.inbox.queueNotice(accepted.id, 'working');
    let attempts = 0;
    const sender = f.replies(async () => { attempts++; throw new GatewaySendError('retry', 7000); });
    await sender.wake();
    const retryAt = f.inbox.list()[0].notices?.working?.retryAt;
    expect(retryAt).toBeGreaterThan(Date.now());
    await f.state.disconnect(); await f.state.connect(); f.inbox.recover();
    await sender.wake(); expect(attempts).toBe(1);
    vi.spyOn(Date, 'now').mockReturnValue(retryAt! + 1);
    expect(f.inbox.claimNotice()?.kind).toBe('working');
    await f.state.disconnect(); await f.state.connect(); f.inbox.recover();
    expect(f.inbox.list()[0].notices?.working?.status).toBe('uncertain');
    await sender.wake(); expect(attempts).toBe(1);
  });

  it('admits once, waits for actual completion, and preserves the full long reply in ordered parts', async () => {
    const f = await fixture(); const event = f.accept();
    f.accept(); const second = f.accept('2');
    await f.dispatcher.start();
    await expect.poll(() => f.submissions.length).toBe(1);
    await f.dispatcher.wake(); expect(f.inbox.list()[0].status).toBe('running');
    const answer = 'x'.repeat(2999) + '😀' + 'z'.repeat(6200);
    f.outcomes.set(event.id, { state: 'completed', answer }); await f.dispatcher.wake();
    expect(f.inbox.list()[0].reply!.parts.map((part) => part.text).join('')).toBe(answer);
    expect(f.inbox.list()[1].status).toBe('queued');
    const sent: string[] = [];
    const sender = f.replies(async (_event, text) => { sent.push(text); return `remote-${sent.length}`; });
    await sender.wake();
    await expect.poll(() => f.submissions.includes(second.id)).toBe(true);
    expect(sent.join('')).toBe(answer);
    f.accept(); await f.dispatcher.wake(); expect(f.submissions.filter((id) => id === event.id)).toHaveLength(1);
  });

  it('recovers a saved operation by polling it without submitting another model request', async () => {
    const f = await fixture(); const accepted = f.accept(); const claimed = f.inbox.claimNext()!;
    f.inbox.beginDispatch(accepted.id, claimed.operationId!, await gatewayConversation(claimed, f.abort.signal));
    await f.state.disconnect(); await f.state.connect(); f.inbox.recover();
    await f.dispatcher.start(); expect(f.submissions).toEqual([]);
    f.outcomes.set(accepted.id, { state: 'completed', answer: 'Recovered answer' }); await f.dispatcher.wake();
    expect(f.inbox.list()[0].dispatch?.answer).toBe('Recovered answer'); expect(f.submissions).toEqual([]);
  });

  it('holds failed submissions, revoked access and edits without a blind model retry or reply', async () => {
    const f = await fixture(); const event = f.accept();
    f.services.submit = async () => { f.submissions.push(event.id); throw new Error('provider PRIVATE_TOKEN'); };
    await f.dispatcher.start();
    await expect.poll(() => f.inbox.list()[0].status).toBe('needs-review');
    await f.dispatcher.wake(); expect(f.submissions).toHaveLength(1);
    expect(JSON.stringify(f.inbox.list())).not.toContain('PRIVATE_TOKEN');
    const other = f.accept('2', '456'); f.services.submit = async () => ({});
    await f.dispatcher.wake();
    await expect.poll(() => f.inbox.list().find((item) => item.id === other.id)?.dispatch?.state).toBe('running');
    f.outcomes.set(other.id, { state: 'completed', answer: 'Must stay local' });
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } }, f.instance.id);
    await f.dispatcher.wake(); expect(f.inbox.list().find((item) => item.id === other.id)?.reply).toBeUndefined();
    expect(f.inbox.list().find((item) => item.id === other.id)?.status).toBe('needs-review');
  });

  it('preserves confirmed parts and requires an explicit retry after an uncertain send', async () => {
    const f = await fixture(); const id = await f.finish('a'.repeat(7000));
    const sent: string[] = []; let fail = true;
    const sender = f.replies(async (_event, text) => {
      sent.push(text); if (sent.length === 2 && fail) throw new Error('private transport URL');
      return `remote-${sent.length}`;
    });
    await sender.wake();
    expect(f.inbox.list()[0].reply!.parts.map((part) => part.status)).toEqual(['sent', 'uncertain', 'pending']);
    await sender.wake(); expect(sent).toHaveLength(2);
    fail = false; f.inbox.retryReply(id); await sender.wake();
    expect(sent).toHaveLength(4); expect(f.inbox.list()[0].reply!.parts[0].remoteId).toBe('remote-1');
    expect(f.inbox.list()[0].reply!.parts.every((part) => part.status === 'sent')).toBe(true);
    expect(f.inbox.list()[0].reply!.reason).toBeUndefined();
  });

  it('honors persisted rate-limit waits and does not resend a confirmed prefix', async () => {
    const f = await fixture(); await f.finish('a'.repeat(3500)); let calls = 0;
    const sender = f.replies(async () => { calls++; if (calls === 2) throw new GatewaySendError('retry', 5000); return `remote-${calls}`; });
    await sender.wake(); expect(calls).toBe(2);
    const retryAt = f.inbox.list()[0].reply!.parts[1].retryAt!;
    await sender.wake(); expect(calls).toBe(2);
    vi.spyOn(Date, 'now').mockReturnValue(retryAt + 1);
    await sender.wake(); expect(calls).toBe(3);
    expect(f.inbox.list()[0].reply!.parts[0].remoteId).toBe('remote-1');
  });

  it('marks an interrupted send uncertain on recovery and blocks changed destinations', async () => {
    const f = await fixture(); const id = await f.finish('Answer');
    f.inbox.claimReply(); await f.state.disconnect(); await f.state.connect(); f.inbox.recover();
    let sends = 0; const sender = f.replies(async () => { sends++; return 'remote'; });
    await sender.wake(); expect(sends).toBe(0); expect(f.inbox.list()[0].reply!.parts[0].status).toBe('uncertain');
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } }, f.instance.id);
    expect(() => f.inbox.retryReply(id)).toThrow('no longer allowed'); expect(sends).toBe(0);
  });

  it('holds a running request after an edit instead of sending its stale answer', async () => {
    const f = await fixture(); const event = f.accept(); await f.dispatcher.start();
    await expect.poll(() => f.inbox.list()[0].dispatch?.state).toBe('running');
    f.inbox.accept({ ...event.input, sourceEventId: 'edit-1', kind: 'edit', text: 'Changed request' });
    f.outcomes.set(event.id, { state: 'completed', answer: 'Old answer' }); await f.dispatcher.wake();
    expect(f.inbox.list()[0].status).toBe('needs-review'); expect(f.inbox.list()[0].reply).toBeUndefined();
  });

  it('holds unsent answer parts when the source is edited after completion', async () => {
    const f = await fixture(); await f.finish('Old answer');
    const original = f.inbox.list()[0];
    f.inbox.accept({ ...original.input, sourceEventId: 'edit-2', kind: 'edit', text: 'Changed request' });
    let sends = 0;
    await f.replies(async () => { sends++; return 'remote'; }).wake();
    expect(sends).toBe(0);
    expect(f.inbox.list()[0].reply?.parts[0].status).toBe('failed');
  });

  it('stops without waiting for a model and ignores its late result after releasing ownership', async () => {
    const f = await fixture(); f.accept();
    let finish: (() => void) | undefined;
    f.services.submit = () => new Promise((resolve) => { finish = () => resolve({}); });
    await f.dispatcher.start();
    await expect.poll(() => Boolean(finish)).toBe(true);
    await f.dispatcher.stop(); await f.state.disconnect();
    finish!(); await Promise.resolve(); await Promise.resolve();
    await f.state.connect();
    expect(f.inbox.list()[0].dispatch?.state).toBe('starting');
  });
});
