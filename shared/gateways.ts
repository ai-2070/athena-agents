import type { GatewayInbound, GatewayInboxEvent, GatewayPlatform } from './types.ts';

export const gatewayPlatformAvailable = (platform: GatewayPlatform): boolean => platform === 'telegram' || platform === 'slack' || platform === 'discord';

export const gatewayAlbumKey = (input: GatewayInbound): string | null => input.mediaGroupId
  ? JSON.stringify([input.accountId, input.conversationId, input.threadId, input.mediaGroupId]) : null;

/** Explicit grouping only: a quiet interval is not proof that an album is complete. */
export function gatewayAlbumCandidates(events: GatewayInboxEvent[], event: GatewayInboxEvent): GatewayInboxEvent[] {
  const key = gatewayAlbumKey(event.input);
  if (!key) return [];
  const members = events.filter((item) => item.input.kind === 'message' && gatewayAlbumKey(item.input) === key);
  if (members.length < 2 || members.length > 10 || members.some((item) => item.album || item.albumBlocked || item.status !== 'needs-review'
    || item.operationId || item.reply || item.input.actor.id !== event.input.actor.id || item.bindingId !== event.bindingId
    || !item.input.media.length || item.files?.length !== item.input.media.length || item.files.some((file) => file.status !== 'saved'))
    || events.some((item) => item.input.kind === 'edit' && (gatewayAlbumKey(item.input) === key || members.some((source) => source.input.accountId === item.input.accountId
      && source.input.conversationId === item.input.conversationId && source.input.threadId === item.input.threadId && source.input.sourceMessageId === item.input.sourceMessageId)))) return [];
  return members.sort((a, b) => a.sequence - b.sequence);
}

/** Advisory notices do not hold work; model holds and unresolved deliveries need review. */
export function gatewayNeedsReview(event: GatewayInboxEvent): boolean {
  if (event.dismissed) return false;
  const unresolved = (status: string) => status === 'failed' || status === 'uncertain';
  return event.status === 'needs-review' || Boolean(event.files?.some((file) => file.status === 'failed')
    || event.reply?.parts.some((part) => unresolved(part.status)) || event.outgoing?.some((file) => unresolved(file.status)));
}

/** An operation reservation is already ambiguous, even without a dispatch receipt. */
export function gatewayRequestUnstarted(event: GatewayInboxEvent): boolean {
  return !event.operationId && !event.dispatch && !event.reply && !event.outgoing?.length && !event.notices
    && !event.input.mediaGroupId && !event.album;
}

function settled(event: GatewayInboxEvent): boolean {
  if (event.dismissed) return true;
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
  const albums = new Set(unresolved.map((event) => gatewayAlbumKey(event.input)).filter((key) => key !== null));
  const eligible = events.filter((event) => event.receivedAt < before && settled(event) && !bindings.has(event.bindingId) && !sources.has(source(event))
    && !albums.has(gatewayAlbumKey(event.input) ?? ''));
  const ids = new Set(eligible.map((event) => event.id));
  return eligible.filter((event) => !event.album || events.find((item) => item.id === event.album!.leaderId)?.album?.memberIds?.every((id) => ids.has(id)));
}
