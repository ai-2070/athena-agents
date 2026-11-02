import type { GatewayInboxEvent } from './types.ts';

/** Advisory notices do not hold work; model holds and unresolved deliveries need review. */
export function gatewayNeedsReview(event: GatewayInboxEvent): boolean {
  const unresolved = (status: string) => status === 'failed' || status === 'uncertain';
  return event.status === 'needs-review' || Boolean(event.files?.some((file) => file.status === 'failed')
    || event.reply?.parts.some((part) => unresolved(part.status)) || event.outgoing?.some((file) => unresolved(file.status)));
}
