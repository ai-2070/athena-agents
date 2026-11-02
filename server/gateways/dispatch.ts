import type { GatewayInboxEvent, GatewayReconciliation, ServerEvent } from '../../shared/types.ts';
import { bus } from '../store.ts';
import { gatewayConversation, gatewayRunInput } from './conversations.ts';
import { gatewayExecution } from './execution.ts';
import type { GatewayCompletion, GatewayExecutionServices } from './execution.ts';
import type { GatewayInbox } from './inbox.ts';

/** Durable admission is separate from transport handlers and long-running model promises. */
export class GatewayDispatcher {
  private readonly inbox: GatewayInbox;
  private readonly services: GatewayExecutionServices;
  private readonly signal: AbortSignal;
  private readonly tasks = new Map<string, Promise<void>>();
  private pending: Promise<void> | undefined;
  private again = false;
  private stopped = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly changed = (event: ServerEvent) => {
    if (['gateway-inbox', 'run', 'team', 'brief', 'brain-chat', 'approvals'].includes(event.type)) void this.wake().catch(() => {});
  };

  constructor(inbox: GatewayInbox, signal: AbortSignal, services = gatewayExecution) {
    this.inbox = inbox; this.signal = signal; this.services = services;
  }

  start(): Promise<void> {
    if (!this.timer) {
      bus.on('event', this.changed);
      this.timer = setInterval(() => { void this.wake().catch(() => {}); }, 1000); this.timer.unref();
    }
    return this.wake();
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

  private allowed(event: GatewayInboxEvent): boolean {
    if (this.stopped || this.signal.aborted) return false;
    try {
      const current = this.inbox.list().find((item) => item.id === event.id);
      if (!current || current.status !== 'running' || current.operationId !== event.operationId) return false;
      this.inbox.checkAccess(current); this.inbox.dispatchSources(current.id); return true;
    } catch { return false; }
  }

  reconcile(eventId: string): GatewayReconciliation {
    if (this.stopped || this.signal.aborted) throw new Error('This gateway is not connected.');
    const event = this.inbox.reconciliationCandidate(eventId);
    const result = this.tasks.has(event.id) ? { state: 'pending' as const } : this.checkCompletion(event, true);
    return this.inbox.settleReconciliation(event.id, event.operationId!, result);
  }

  private checkCompletion(event: GatewayInboxEvent, strict = false): GatewayCompletion {
    return strict && this.services.reconcile ? this.services.reconcile(event) : this.services.poll(event);
  }

  private async drain(): Promise<void> {
    for (const event of this.inbox.list()) {
      if (this.stopped || this.signal.aborted) return;
      if (event.status !== 'running' || !event.dispatch) continue;
      try {
        if (!this.allowed(event)) { this.inbox.review(event.id, 'Access or the destination changed. Review this work in Athena.'); continue; }
        const result = this.tasks.has(event.id) ? { state: 'pending' as const } : this.checkCompletion(event, event.reconciliation?.state === 'tracking');
        if (result.state === 'needs-review') this.inbox.review(event.id);
        else if (result.state === 'completed') this.inbox.finishDispatch(event.id, event.operationId!, result.answer);
        else if (this.services.approvalPending?.(event)) this.inbox.queueNotice(event.id, 'approval');
        else if (Date.now() - event.dispatch.startedAt >= 5000) this.inbox.queueNotice(event.id, 'working');
      } catch { this.inbox.review(event.id); }
    }
    while (!this.stopped && !this.signal.aborted && this.inbox.list().filter((event) => event.status === 'running').length < 4) {
      const claimed = this.inbox.claimNext();
      if (!claimed) return;
      try {
        const sources = this.inbox.dispatchSources(claimed.id);
        const local = await gatewayConversation(claimed, this.signal, sources);
        if (!this.allowed(claimed)) { this.inbox.review(claimed.id); continue; }
        const event = this.inbox.beginDispatch(claimed.id, claimed.operationId!, local);
        const input = gatewayRunInput(event, sources);
        const task = Promise.resolve().then(() => this.services.submit(event, this.signal, () => this.allowed(event), input)).then((result) => {
          if (!this.stopped && !this.signal.aborted) this.inbox.recordDispatch(event.id, event.operationId!, result);
        }).catch(() => {
          if (!this.stopped && !this.signal.aborted) this.inbox.review(event.id);
        }).finally(() => {
          this.tasks.delete(event.id);
          if (!this.stopped && !this.signal.aborted) void this.wake().catch(() => {});
        });
        this.tasks.set(event.id, task);
      } catch { this.inbox.review(claimed.id); }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer); bus.off('event', this.changed);
    // Running engines keep their normal stop/recovery semantics; never wait for a long model call here.
    await this.pending;
  }
}
