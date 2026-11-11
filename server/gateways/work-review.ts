import crypto from 'node:crypto';
import type { GatewayInboxEvent, GatewayInboxJournal, GatewayInstance, GatewayWorkReview } from '../../shared/types.ts';

export const workBindingId = (root: string, revision: string): string =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify([root, revision]))
    .digest('hex');

export const gatewayBindingRoot = (journal: GatewayInboxJournal, id: string): string =>
  journal.bindings.find((item) => item.id === id)?.rootId ?? id;

/** Action order is independent of the original request's position in the inbox. */
export function latestWorkReview(journal: GatewayInboxJournal, bindingId: string): GatewayInboxEvent['workKept'] {
  const roots = new Map(journal.bindings.map((item) => [item.id, item.rootId ?? item.id]));
  const root = roots.get(bindingId) ?? bindingId;
  let latest: GatewayInboxEvent['workKept'];
  for (const event of journal.events)
    if (event.workKept && roots.get(event.bindingId) === root && (!latest || event.workKept.serial > latest.serial))
      latest = event.workKept;
  return latest;
}

export const gatewayWorkUnfinished = (event: GatewayInboxEvent): boolean =>
  Boolean(event.operationId) &&
  !event.reply &&
  !event.dismissed &&
  !event.deliveryFinished &&
  ['running', 'needs-review'].includes(event.status) &&
  event.input.kind === 'message' &&
  (!event.input.mediaGroupId || event.album?.leaderId === event.id);
export const gatewayWorkInFlight = (event: GatewayInboxEvent): boolean =>
  Boolean(
    event.files?.some((file) => file.status === 'transferring') ||
    event.outgoing?.some((file) => file.status === 'sending') ||
    Object.values(event.notices ?? {}).some((notice) => notice.status === 'sending'),
  );

export function workReceiptsValid(journal: GatewayInboxJournal): boolean {
  const bindings = new Map(journal.bindings.map((item) => [item.id, item]));
  const reviews = journal.events.filter((event) => event.workKept);
  if (
    bindings.size !== journal.bindings.length ||
    new Set(reviews.map((event) => event.workKept!.serial)).size !== reviews.length ||
    new Set(reviews.map((event) => event.workKept!.revision)).size !== reviews.length ||
    reviews.some(
      (event) =>
        event.workKept!.serial > reviews.length ||
        !gatewayWorkUnfinished(event) ||
        gatewayWorkInFlight(event) ||
        event.workKept!.throughSequence < event.sequence ||
        event.workKept!.throughSequence >= journal.nextSequence,
    )
  )
    return false;
  const branches = new Map(
    reviews.map((event) => [
      workBindingId(bindings.get(event.bindingId)?.rootId ?? event.bindingId, event.workKept!.revision),
      event,
    ]),
  );
  return (
    journal.bindings.every((binding) => {
      if (!binding.rootId) return true;
      const root = bindings.get(binding.rootId);
      const review = branches.get(binding.id);
      return (
        root &&
        !root.rootId &&
        root.id !== binding.id &&
        review &&
        root.accountId === binding.accountId &&
        root.conversationId === binding.conversationId &&
        (bindings.get(review.bindingId)?.rootId ?? review.bindingId) === root.id &&
        root.threadId === binding.threadId &&
        root.guildId === binding.guildId &&
        root.parentConversationId === binding.parentConversationId &&
        JSON.stringify(root.route) === JSON.stringify(binding.route)
      );
    }) &&
    journal.events.every(
      (event) =>
        !bindings.get(event.bindingId)?.rootId ||
        Boolean(
          branches.get(event.bindingId) && event.sequence > branches.get(event.bindingId)!.workKept!.throughSequence,
        ),
    )
  );
}

/** This reads saved gateway receipts, never infers the current native run outcome. */
export function workReview(
  instance: GatewayInstance,
  journal: GatewayInboxJournal,
  event: GatewayInboxEvent,
  revision: string,
): GatewayWorkReview {
  const roots = new Map(journal.bindings.map((item) => [item.id, item.rootId ?? item.id]));
  const root = roots.get(event.bindingId);
  const eligible = gatewayWorkUnfinished(event);
  const sending = gatewayWorkInFlight(event);
  const reason = instance.enabled
    ? 'Pause this gateway before reviewing saved work.'
    : event.workKept
      ? 'This request is kept in Athena. It cannot be tracked, replied to or restarted by this gateway.'
      : !eligible
        ? 'Only a reserved or started request without a saved final reply can be kept in Athena. Review completed delivery separately.'
        : sending
          ? 'Recover interrupted receipts before keeping this work in Athena.'
          : '';
  const native = event.dispatch;
  return {
    revision,
    reason,
    canKeep: !reason,
    needsPrepare: !instance.enabled && !event.workKept && eligible && sending,
    ...(event.workKept ? { keptAt: event.workKept.at } : {}),
    heldRequests: journal.events.filter(
      (item) =>
        item.id !== event.id &&
        !item.workKept &&
        !item.dismissed &&
        !item.deliveryFinished &&
        item.sequence <= (event.workKept?.throughSequence ?? journal.nextSequence - 1) &&
        roots.get(item.bindingId) === root &&
        (item.status !== 'done' ||
          item.reply?.parts.some((part) => part.status !== 'sent') ||
          item.outgoing?.some((file) => !['sent', 'skipped'].includes(file.status))),
    ).length,
    source: {
      platform: event.input.platform,
      actor: event.input.actor.label,
      conversationId: event.input.conversationId,
      threadId: event.input.threadId,
      messageId: event.input.sourceMessageId,
      projectId: event.route.projectId,
      target: event.route.target,
    },
    ...(event.operationId ? { operationId: event.operationId } : {}),
    ...(native
      ? {
          native: {
            state: native.state,
            conversation: native.conversation,
            ...(native.runId ? { runId: native.runId } : {}),
            ...(native.messageId ? { messageId: native.messageId } : {}),
            ...(native.briefId ? { briefId: native.briefId } : {}),
          },
        }
      : {}),
  };
}
