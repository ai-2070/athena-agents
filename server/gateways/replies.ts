import type { GatewayInboxEvent, ServerEvent } from '../../shared/types.ts';
import { bus } from '../store.ts';
import type { GatewayInbox } from './inbox.ts';

export class GatewaySendError extends Error {
  readonly outcome: 'retry' | 'failed' | 'uncertain';
  readonly retryAfterMs: number;
  constructor(outcome: 'retry' | 'failed' | 'uncertain', retryAfterMs = 1000) {
    super('The gateway reply could not be confirmed.'); this.outcome = outcome;
    this.retryAfterMs = Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 1000;
  }
}
export type GatewayReplySender = (event: GatewayInboxEvent, text: string, signal: AbortSignal) => Promise<string>;

/** Each part is marked before I/O. A lost confirmation is never treated as a retryable send. */
export class GatewayReplies {
  private readonly inbox: GatewayInbox;
  private readonly send: GatewayReplySender;
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  private readonly noticeAllowed: (event: GatewayInboxEvent, kind: 'working' | 'approval') => boolean;
  private pending: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly changed = (event: ServerEvent) => { if (event.type === 'gateway-inbox') void this.wake().catch(() => {}); };
  constructor(inbox: GatewayInbox, send: GatewayReplySender, signal: AbortSignal, noticeAllowed: (event: GatewayInboxEvent, kind: 'working' | 'approval') => boolean = () => true) {
    this.inbox = inbox; this.send = send; this.signal = AbortSignal.any([signal, this.abort.signal]);
    this.noticeAllowed = noticeAllowed;
  }
  start(): void {
    if (this.timer) return;
    bus.on('event', this.changed);
    this.timer = setInterval(() => { void this.wake().catch(() => {}); }, 1000); this.timer.unref();
    void this.wake().catch(() => {});
  }
  wake(): Promise<void> {
    if (this.stopped || this.signal.aborted) return Promise.resolve();
    if (this.pending) { this.again = true; return this.pending; }
    this.again = false;
    return this.pending = Promise.resolve().then(() => this.drain()).finally(() => {
      this.pending = undefined;
      if (this.again) return this.wake();
    });
  }
  private async drain(): Promise<void> {
    while (!this.stopped && !this.signal.aborted) {
      const claimed = this.inbox.claimReply();
      const notice = claimed ? null : this.inbox.claimNotice(this.noticeAllowed);
      if (!claimed && !notice) return;
      const event = claimed?.event ?? notice!.event;
      const text = claimed ? event.reply!.parts[claimed.index].text : event.notices![notice!.kind]!.text;
      const settle = (outcome: { remoteId: string } | { status: 'pending' | 'failed' | 'uncertain'; retryAt?: number }) => {
        if (claimed) this.inbox.settleReply(event.id, claimed.index, outcome);
        else this.inbox.settleNotice(event.id, notice!.kind, outcome);
      };
      try {
        if (this.signal.aborted) { settle({ status: 'pending' }); return; }
        const id = await this.send(event, text, this.signal);
        settle({ remoteId: id });
      } catch (error) {
        const result = error instanceof GatewaySendError ? error : new GatewaySendError('uncertain');
        const retryAt = Math.min(Number.MAX_SAFE_INTEGER, Date.now() + Math.max(1000, result.retryAfterMs));
        settle(result.outcome === 'retry' ? { status: 'pending', retryAt } : { status: result.outcome });
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; this.abort.abort();
    clearInterval(this.timer); bus.off('event', this.changed);
    await this.pending;
  }
}
