import crypto from 'node:crypto';
import type { GatewayInboxEvent, GatewayInboxJournal, GatewayRetiredFinishReview, GatewayRetiredInstance } from '../../shared/types.ts';
import { completedGatewayDelivery, deliveryEntries } from './delivery-review.ts';
import { gatewayBindingRoot, gatewayWorkInFlight, gatewayWorkUnfinished } from './work-review.ts';

/** A removed connection grants only local closure, never delivery or native-run permission. */
export function retiredFinishReview(retired: GatewayRetiredInstance, journal: GatewayInboxJournal, event: GatewayInboxEvent): GatewayRetiredFinishReview {
  const encoded = JSON.stringify(['retired-local-finish-v1', retired, journal, event.id], (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : value);
  const revision = crypto.createHash('sha256').update(encoded).digest('hex');
  const entries = deliveryEntries(event);
  const kind = completedGatewayDelivery(event) ? 'delivery' : gatewayWorkUnfinished(event) ? 'work' : 'unavailable';
  const closedAt = event.deliveryFinished?.at ?? event.workKept?.at;
  const sending = kind === 'work' ? gatewayWorkInFlight(event) : entries.some((entry) => entry.value.status === 'sending');
  const remaining = entries.some((entry) => !['sent', 'skipped'].includes(entry.value.status));
  const matches = event.route.instanceId === retired.id && event.input.accountId === retired.accountId && event.input.platform === retired.platform;
  const ready = retired.completedAt !== undefined && matches && closedAt === undefined && kind !== 'unavailable' && (kind !== 'delivery' || (event.deliveryReviews?.length ?? 0) < 3000);
  const reason = retired.completedAt === undefined ? 'Finish removing this instance before changing its saved receipts.'
    : !matches ? 'The saved source does not match this removed instance. Restore its original receipts.'
      : closedAt !== undefined ? 'This receipt was finished locally and cannot be reopened.'
        : kind === 'unavailable' ? 'Only completed saved answers or reserved or started native work can be finished here. Queued requests and album members keep their saved evidence.'
          : kind === 'delivery' && (event.deliveryReviews?.length ?? 0) >= 3000 ? 'The delivery review history is full. Keep its receipts intact.'
            : sending ? 'Recover interrupted receipts before finishing locally.'
              : kind === 'delivery' && !remaining ? 'Every delivery is confirmed or skipped. Keep the saved receipts.' : '';
  const root = gatewayBindingRoot(journal, event.bindingId);
  const native = event.dispatch;
  return { revision, kind, reason, canFinish: !reason, needsPrepare: ready && sending, ...(closedAt !== undefined ? { closedAt } : {}),
    source: { platform: event.input.platform, actor: event.input.actor.label, conversationId: event.input.conversationId, threadId: event.input.threadId, messageId: event.input.sourceMessageId, projectId: event.route.projectId, target: event.route.target },
    ...(event.operationId ? { operationId: event.operationId } : {}),
    ...(native ? { native: { state: native.state, conversation: native.conversation, ...(native.runId ? { runId: native.runId } : {}), ...(native.messageId ? { messageId: native.messageId } : {}), ...(native.briefId ? { briefId: native.briefId } : {}) } } : {}),
    heldRequests: kind === 'work' ? journal.events.filter((item) => item.id !== event.id && !item.workKept && !item.dismissed && !item.deliveryFinished && item.sequence <= (event.workKept?.throughSequence ?? journal.nextSequence - 1) && gatewayBindingRoot(journal, item.bindingId) === root
      && (item.status !== 'done' || item.reply?.parts.some((part) => part.status !== 'sent') || item.outgoing?.some((file) => !['sent', 'skipped'].includes(file.status)))).length : 0,
    items: entries.map(({ value, label, text }) => ({ label, ...(text !== undefined ? { text } : {}), status: value.status, ...(value.remoteId ? { remoteId: value.remoteId } : {}) })) };
}
