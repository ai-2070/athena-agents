import type { GatewayDeliveryReview, GatewayDeliveryTarget, GatewayInboxEvent, GatewayInstance, GatewayOutgoingFile, GatewayReplyPart } from '../../shared/types.ts';

export const deliveryTargetKey = (target: GatewayDeliveryTarget): string => JSON.stringify([target.kind, target.kind === 'notice' ? target.notice : target.index]);
export const completedGatewayDelivery = (event: GatewayInboxEvent): boolean => event.status === 'done' && event.dispatch?.state === 'completed' && Boolean(event.operationId && event.reply)
  && event.input.kind === 'message' && (!event.album || event.album.leaderId === event.id);

export function deliveryEntries(event: GatewayInboxEvent): { target: GatewayDeliveryTarget; value: GatewayReplyPart | GatewayOutgoingFile; label: string; text?: string }[] {
  return [
    ...(event.reply?.parts.map((value, index) => ({ target: { kind: 'text' as const, index }, value, label: `Text part ${index + 1}`, text: value.text })) ?? []),
    ...(event.outgoing?.map((value, index) => ({ target: { kind: 'file' as const, index }, value, label: value.name })) ?? []),
    ...(['working', 'approval'] as const).flatMap((notice) => {
      const value = event.notices?.[notice]; return value ? [{ target: { kind: 'notice' as const, notice }, value, label: notice === 'working' ? 'Working notice' : 'Approval notice', text: value.text }] : [];
    }),
  ];
}

/** Local attestations never contact a provider or authorize a send. */
export function deliveryReview(instance: GatewayInstance, event: GatewayInboxEvent, revision: string): GatewayDeliveryReview {
  const entries = deliveryEntries(event);
  const sending = entries.some((item) => item.value.status === 'sending');
  const remaining = event.reply?.parts.some((part) => part.status !== 'sent') || event.outgoing?.some((file) => !['sent', 'skipped'].includes(file.status));
  const uncertain = entries.some((item) => item.value.status === 'uncertain' && (Array.isArray(item.value.attempts) ? item.value.attempts.length : item.value.attempts) > 0);
  const reason = instance.enabled ? 'Pause this gateway before reviewing delivery.' : event.deliveryFinished ? 'Delivery was finished locally. This receipt cannot send or reopen delivery.'
    : !completedGatewayDelivery(event) ? 'Only a completed saved answer can have its delivery reviewed. Check native work separately.'
      : (event.deliveryReviews?.length ?? 0) >= 3000 ? 'The delivery review history is full. Keep its receipts intact before continuing.'
        : sending ? 'Recover interrupted receipts before reviewing their outcome.' : !remaining && !uncertain ? 'No unresolved delivery needs review.' : '';
  const needsPrepare = !instance.enabled && !event.deliveryFinished && completedGatewayDelivery(event) && sending && (event.deliveryReviews?.length ?? 0) < 3000;
  return { revision, reason, needsPrepare, canFinish: !reason && Boolean(remaining), ...(event.deliveryFinished ? { closedAt: event.deliveryFinished.at } : {}),
    source: { platform: event.input.platform, actor: event.input.actor.label, conversationId: event.input.conversationId, threadId: event.input.threadId, messageId: event.input.sourceMessageId, projectId: event.route.projectId, target: event.route.target },
    items: entries.map(({ target, value, label, text }) => {
      const attempts = Array.isArray(value.attempts) ? value.attempts.length : value.attempts;
      const review = event.deliveryReviews?.findLast((item) => item.action === 'confirmed' && deliveryTargetKey(item.target) === deliveryTargetKey(target));
      return { target, label, ...(text !== undefined ? { text } : {}), status: value.status, ...(value.remoteId ? { remoteId: value.remoteId } : {}),
        canConfirm: !reason && value.status === 'uncertain' && attempts > 0, ...(review ? { confirmedAt: review.at } : {}) };
    }) };
}
