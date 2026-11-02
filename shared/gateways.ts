import type { GatewayInboxEvent } from './types.ts';

/** Advisory notices do not hold work; model holds and unresolved deliveries need review. */
export function gatewayNeedsReview(event: GatewayInboxEvent): boolean {
  const unresolved = (status: string) => status === 'failed' || status === 'uncertain';
  return event.status === 'needs-review' || Boolean(event.files?.some((file) => file.status === 'failed')
    || event.reply?.parts.some((part) => unresolved(part.status)) || event.outgoing?.some((file) => unresolved(file.status)));
}

function settled(event: GatewayInboxEvent): boolean {
  return event.status === 'done' && (!event.dispatch || event.dispatch.state === 'completed')
    && (!event.reply || event.reply.parts.every((part) => part.status === 'sent'))
    && (!event.files || event.files.every((file) => file.status === 'saved'))
    && (!event.outgoing || event.outgoing.every((file) => file.status === 'sent' || file.status === 'skipped'))
    && Object.values(event.notices || {}).every((notice) => notice.status !== 'sending');
}
const source = (event: GatewayInboxEvent) => JSON.stringify([event.input.accountId, event.input.conversationId, event.input.threadId, event.input.sourceMessageId]);

/** Keep unresolved conversations and edited sources intact, including their completed context. */
export function gatewayCleanupCandidates(events: GatewayInboxEvent[], before: number): GatewayInboxEvent[] {
  const unresolved = events.filter((event) => !settled(event));
  const bindings = new Set(unresolved.map((event) => event.bindingId));
  const sources = new Set(unresolved.map(source));
  return events.filter((event) => event.receivedAt < before && settled(event) && !bindings.has(event.bindingId) && !sources.has(source(event)));
}
