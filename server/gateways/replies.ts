import type { GatewayDeliveryFailureReason, GatewayDeliveryOutcome, GatewayInboxEvent, ServerEvent } from '../../shared/types.ts';
import { bus } from '../store.ts';
import type { GatewayInbox } from './inbox.ts';
import type { GatewayFileSender } from './outgoing.ts';
import type { GatewayOutboxLedger } from './outbox.ts';

export class GatewaySendError extends Error {
  readonly outcome: 'retry' | 'failed' | 'uncertain';
  readonly retryAfterMs: number;
  readonly reason?: GatewayDeliveryFailureReason;
  constructor(outcome: 'retry' | 'failed' | 'uncertain', retryAfterMs = 1000, reason?: GatewayDeliveryFailureReason) {
    super('The gateway reply could not be confirmed.'); this.outcome = outcome;
    this.retryAfterMs = Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 1000;
    this.reason = reason;
  }
}
export interface GatewayApprovedTextSend { authorize(event: GatewayInboxEvent, text: string): string }
export type GatewayReplySender = (event: GatewayInboxEvent, text: string, signal: AbortSignal, approved?: GatewayApprovedTextSend) => Promise<string>;

/** Each part is marked before I/O. A lost confirmation is never treated as a retryable send. */
export class GatewayReplies {
  private readonly inbox: GatewayInbox;
  private readonly send: GatewayReplySender;
  private readonly abort = new AbortController();
  private readonly signal: AbortSignal;
  private readonly noticeAllowed: (event: GatewayInboxEvent, kind: 'working' | 'approval') => boolean;
  private readonly sendFile: GatewayFileSender | undefined;
  private readonly outbox: GatewayOutboxLedger | undefined;
  private pending: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly changed = (event: ServerEvent) => { if (event.type === 'gateway-inbox') void this.wake().catch(() => {}); };
  constructor(inbox: GatewayInbox, send: GatewayReplySender, signal: AbortSignal, noticeAllowed: (event: GatewayInboxEvent, kind: 'working' | 'approval') => boolean = () => true, sendFile?: GatewayFileSender, outbox?: GatewayOutboxLedger) {
    this.inbox = inbox; this.send = send; this.signal = AbortSignal.any([signal, this.abort.signal]);
    this.noticeAllowed = noticeAllowed;
    this.sendFile = sendFile;
    this.outbox = outbox;
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
      const upload = !claimed && this.sendFile ? this.inbox.claimOutgoing() : null;
      const notice = claimed || upload ? null : this.inbox.claimNotice(this.noticeAllowed);
      const post = claimed || upload || notice ? null : this.outbox?.claim();
      if (!claimed && !upload && !notice && !post) return;
      const event = claimed?.event ?? upload?.event ?? notice?.event ?? post!.event;
      const settle = (outcome: GatewayDeliveryOutcome) => {
        if (claimed) this.inbox.settleReply(event.id, claimed.index, outcome);
        else if (upload) this.inbox.settleOutgoing(event.id, upload.index, outcome);
        else if (post) this.outbox!.settle(post, outcome);
        else this.inbox.settleNotice(event.id, notice!.kind, outcome);
      };
      try {
        if (this.signal.aborted) { settle({ status: 'pending' }); return; }
        const id = upload ? await this.sendFile!(event, event.outgoing![upload.index], this.signal)
          : await this.send(event, claimed ? event.reply!.parts[claimed.index].text : post ? post.text : event.notices![notice!.kind]!.text, this.signal,
            post ? { authorize: (event, text) => this.outbox!.authorize(post, event, text) } : undefined);
        settle({ remoteId: id });
      } catch (error) {
        const result = error instanceof GatewaySendError ? error : new GatewaySendError('uncertain');
        const retryAt = Math.min(Number.MAX_SAFE_INTEGER, Date.now() + Math.max(1000, result.retryAfterMs));
        settle(result.outcome === 'retry' ? { status: 'pending', retryAt } : { status: result.outcome, ...(result.reason ? { reason: result.reason } : {}) });
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; this.abort.abort();
    clearInterval(this.timer); bus.off('event', this.changed);
    await this.pending;
  }
}
