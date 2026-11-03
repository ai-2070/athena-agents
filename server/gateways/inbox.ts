import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { GatewayDeliveryOutcome, GatewayDispatch, GatewayInbound, GatewayInboxEvent, GatewayInboxJournal, GatewayInstance, GatewayLocalConversation, GatewayOutgoingFile, GatewayWhatsAppIdentities, GatewayWhatsAppIntakeState, GatewayWhatsAppReceipt, GatewayWhatsAppRelayConnection, UploadedFile } from '../../shared/types.ts';
import { emit } from '../store.ts';
import { readJSON, uid, writeJSON } from '../util.ts';
import { captureGatewayRoute, getGatewayInstance, withGatewayRoute } from './instances.ts';
import type { GatewayStateAdapter } from './state.ts';
import { privateDataPath } from '../private.ts';
import type { GatewayCompletion } from './execution.ts';
import type { GatewayReconciliation } from '../../shared/types.ts';
import { gatewayAlbumCandidates, gatewayAlbumKey, gatewayCleanupCandidates } from '../../shared/gateways.ts';
import { slackChannelId, slackTimestamp, slackUserId, slackWorkspaceId } from '../../shared/gateway-slack.ts';
import { discordId } from '../../shared/gateway-discord.ts';
import { canonicalWhatsAppPhone } from '../../shared/gateway-whatsapp.ts';
import { whatsAppIdentitiesSchema, whatsAppIdentityAllowed } from './whatsapp-identities.ts';
import { whatsAppRelayConnectionSchema } from '../../shared/gateway-whatsapp-relay.ts';

const externalId = z.string().min(1).max(500);
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const relayReceipt = z.strictObject({ epoch: z.uuid(), sequence: stamp.positive(), id: z.string().regex(/^[a-f0-9]{64}$/) });
const intakeReceipt = relayReceipt.extend({ confirmed: z.boolean(), accepted: stamp.max(1000), ignored: stamp.max(1000), unmatchedSenders: stamp.max(1000) })
  .refine((value) => value.accepted + value.ignored <= 1000 && value.unmatchedSenders <= value.ignored);
const relayRecovery = z.strictObject({ at: stamp, reason: z.enum(['gap', 'cursor', 'epoch', 'installation', 'envelope']) });
const target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('brain') }),
  z.strictObject({ kind: z.literal('agent'), id: externalId }),
  z.strictObject({ kind: z.literal('team'), id: externalId }),
]);
const route = z.strictObject({ instanceId: externalId, projectId: externalId, target, generation: stamp.positive() });
const common = { conversationId: externalId, projectId: externalId, sender: z.string() };
const conversation = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('brain') }),
  z.strictObject({ ...common, kind: z.literal('agent'), agentId: externalId, chatId: externalId }),
  z.strictObject({ ...common, kind: z.literal('team'), teamId: externalId }),
]);
const dispatchSchema: z.ZodType<GatewayDispatch> = z.strictObject({
  conversation, state: z.enum(['starting', 'running', 'completed', 'needs-review']), startedAt: stamp,
  runId: externalId.optional(), messageId: externalId.optional(), briefId: externalId.optional(), briefRevision: stamp.optional(), answer: z.string().max(1000000).optional(),
  brain: z.strictObject({ answer: z.string(), delegate: z.strictObject({ kind: z.enum(['agent', 'branch']), id: externalId, name: z.string(), message: z.string(), sent: z.strictObject({ messageId: externalId.optional(), ts: stamp.optional(), chatId: externalId.optional(), runId: externalId.optional() }).optional() }).nullable() }).optional(),
});
const inboundSchema: z.ZodType<GatewayInbound> = z.strictObject({
  platform: z.enum(['telegram', 'slack', 'discord', 'whatsapp']), accountId: externalId,
  conversationId: externalId, guildId: externalId.optional(), parentConversationId: externalId.optional(), threadId: z.string().max(500), sourceEventId: externalId, sourceMessageId: externalId,
  sentAt: stamp.optional(),
  whatsappUserId: externalId.optional(),
  kind: z.enum(['message', 'edit']),
  actor: z.strictObject({ id: externalId, label: z.string().max(200), kind: z.enum(['user', 'bot', 'anonymous']) }),
  directMessage: z.boolean(), triggered: z.boolean(), text: z.string().max(65536),
  mediaGroupId: externalId.optional(),
  media: z.array(z.strictObject({
    kind: z.enum(['image', 'file', 'audio', 'video']), fileId: externalId,
    name: z.string().max(512).optional(), mimeType: z.string().max(200).optional(), size: stamp.optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  })).max(10),
});
const replyPart = z.strictObject({ text: z.string().min(1).max(3000), status: z.enum(['pending', 'sending', 'sent', 'uncertain', 'failed']), attempts: stamp, remoteId: externalId.optional(), retryAt: stamp.optional() });
const journalSchema: z.ZodType<GatewayInboxJournal> = z.strictObject({
  version: z.literal(1), nextSequence: stamp.positive(),
  whatsappRelay: z.strictObject({ epoch: z.uuid(), cursor: stamp, receipt: intakeReceipt.optional(), identities: whatsAppIdentitiesSchema.optional(),
    connection: whatsAppRelayConnectionSchema.optional(), recovery: relayRecovery.optional() }).optional(),
  retired: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100000).optional(),
  retiredAlbums: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(100000).optional(),
  retiredQuota: z.array(z.strictObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), incomingBytes: stamp, outgoingBytes: stamp })).max(100000).optional(),
  bindings: z.array(z.strictObject({ id: externalId, accountId: externalId, conversationId: externalId, guildId: externalId.optional(), parentConversationId: externalId.optional(), threadId: z.string().max(500), route, createdAt: stamp })),
  events: z.array(z.strictObject({
    id: externalId, bindingId: externalId, route, input: inboundSchema, sequence: stamp.positive(), receivedAt: stamp,
    relay: relayReceipt.extend({ confirmed: z.boolean() }).optional(),
    status: z.enum(['queued', 'waiting-files', 'running', 'done', 'needs-review']), operationId: externalId.optional(), reason: z.string().optional(),
    fileBatch: z.string().regex(/^[\w-]{1,64}$/).optional(),
    dispatch: dispatchSchema.optional(),
    reply: z.strictObject({ createdAt: stamp, reason: z.string().optional(), parts: z.array(replyPart).min(1).max(2000) }).optional(),
    notices: z.strictObject({ working: replyPart.optional(), approval: replyPart.optional() }).optional(),
    album: z.strictObject({ leaderId: externalId, memberIds: z.array(externalId).min(2).max(10).optional() }).optional(),
    albumBlocked: z.literal(true).optional(),
    reconciliation: z.strictObject({ at: stamp, state: z.enum(['tracking', 'completed', 'needs-review']) }).optional(),
    outgoing: z.array(z.strictObject({ path: z.string().min(1), name: z.string().min(1).max(180), size: stamp.positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), source: z.strictObject({ runId: externalId, agentId: externalId, chatId: externalId, workspace: z.string().min(1) }).optional(), status: z.enum(['pending', 'sending', 'sent', 'uncertain', 'failed', 'skipped']), attempts: z.array(z.strictObject({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), bytes: stamp })), remoteId: externalId.optional(), retryAt: stamp.optional(), reason: z.string().optional() })).max(10).optional(),
    files: z.array(z.strictObject({
      index: stamp, status: z.enum(['pending', 'transferring', 'saved', 'failed']),
      attempts: z.array(z.strictObject({ id: externalId, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), bytes: stamp })),
      file: z.strictObject({ path: z.string(), top: z.string(), kind: z.enum(['file', 'folder']), name: z.string(), size: stamp }).optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), reason: z.string().optional(),
    })).optional(),
  })),
});
const digest = (parts: (string | number)[]): string => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
function saveAnswer(event: GatewayInboxEvent, answer: string): void {
  if (!event.dispatch || event.reply || !answer.trim() || answer.length > 1000000) throw new Error('The gateway answer needs review.');
  const parts: string[] = [];
  for (let start = 0; start < answer.length;) {
    let end = Math.min(start + (event.input.platform === 'discord' ? 2000 : 3000), answer.length);
    if (event.input.platform === 'slack') {
      end = start; let length = 0;
      while (end < answer.length) {
        const point = answer.codePointAt(end)!; const width = point > 0xffff ? 2 : 1;
        const cost = point === 38 ? 5 : point === 60 || point === 62 ? 4 : width;
        if (length + cost > 3000) break;
        length += cost; end += width;
      }
    }
    const last = answer.charCodeAt(end - 1);
    if (end < answer.length && last >= 0xd800 && last <= 0xdbff) end--;
    parts.push(answer.slice(start, end)); start = end;
  }
  event.dispatch.state = 'completed'; event.dispatch.answer = answer;
  event.status = 'done'; delete event.reason;
  event.reply = { createdAt: Date.now(), parts: parts.map((text) => ({ text, status: 'pending', attempts: 0 })) };
}
export class GatewayFileLimitError extends Error {}
export class GatewayCleanupError extends Error {}

function replayReceiptsValid(journal: GatewayInboxJournal): boolean {
  if ((journal.retired === undefined) !== (journal.retiredQuota === undefined)) return false;
  const retired = new Set(journal.retired ?? []);
  return retired.size === (journal.retired?.length ?? 0) && !journal.events.some((event) => retired.has(event.id))
    && new Set(journal.retiredQuota?.map((quota) => quota.day)).size === (journal.retiredQuota?.length ?? 0)
    && new Set(journal.retiredAlbums ?? []).size === (journal.retiredAlbums?.length ?? 0);
}

function relayReceiptsValid(journal: GatewayInboxJournal): boolean {
  const state = journal.whatsappRelay; const receipt = state?.receipt;
  if (state?.connection && (state.connection.epoch !== state.epoch || (state.identities && state.connection.businessAccountId !== state.identities.businessAccountId))) return false;
  if (receipt && (receipt.epoch !== state?.epoch || receipt.sequence !== state.cursor + (receipt.confirmed ? 0 : 1))) return false;
  return journal.events.every((event) => {
    if (event.input.platform !== 'whatsapp') return !event.relay;
    const relay = event.relay;
    if (!relay || !state || !receipt || relay.epoch !== state.epoch || (state.connection && state.connection.phoneNumberId !== event.input.accountId)) return false;
    if (relay.confirmed) return relay.sequence <= state.cursor && (relay.sequence !== receipt.sequence || relay.id === receipt.id);
    return receipt && !receipt.confirmed && relay.sequence === receipt.sequence && relay.id === receipt.id
      && ['queued', 'waiting-files', 'needs-review'].includes(event.status) && !event.operationId && !event.dispatch && !event.fileBatch && !event.reply && !event.outgoing;
  });
}
const albumDigest = (input: GatewayInbound) => digest([gatewayAlbumKey(input)!]);

function albumReceiptsValid(journal: GatewayInboxJournal): boolean {
  const byId = new Map(journal.events.map((event) => [event.id, event]));
  return journal.events.every((event) => {
    if (!event.album) return true;
    const leader = byId.get(event.album.leaderId); const ids = leader?.album?.memberIds;
    return Boolean(leader && leader.album?.leaderId === leader.id && ids?.includes(event.id) && new Set(ids).size === ids.length
      && ids.includes(leader.id) && !journal.retiredAlbums?.includes(albumDigest(leader.input))
      && ids.every((id) => {
        const item = byId.get(id);
        return item && item.album?.leaderId === leader.id && item.input.kind === 'message' && item.input.media.length && !item.albumBlocked
          && item.bindingId === leader.bindingId && gatewayAlbumKey(item.input) && gatewayAlbumKey(item.input) === gatewayAlbumKey(leader.input) && item.input.actor.id === leader.input.actor.id;
      }) && (event.id === leader.id || (event.status === 'done' && !event.operationId && !event.dispatch && !event.reply && !event.outgoing && !event.album.memberIds)));
  });
}

/** Atomic writers permit read-only diagnostics without taking the live worker's claim. */
export function gatewayInboxHistory(instanceId: string): GatewayInboxEvent[] {
  getGatewayInstance(instanceId);
  const file = privateDataPath('gateways-runtime', instanceId, 'inbox.json');
  if (!fs.existsSync(file)) return [];
  const parsed = journalSchema.safeParse(readJSON(file));
  if (!parsed.success || !replayReceiptsValid(parsed.data) || !albumReceiptsValid(parsed.data) || !relayReceiptsValid(parsed.data)) throw Object.assign(new Error('This gateway inbox is unreadable.'), { status: 503 });
  return parsed.data.events;
}

/** Only inputs from verified transport normalizers may reach this journal. */
export function gatewayInputAllowed(instance: GatewayInstance, input: GatewayInbound): boolean {
  if (!instance.enabled || instance.platform !== input.platform || input.accountId !== instance.accountId || input.actor.kind !== 'user') return false;
  if (input.platform !== 'whatsapp' && input.whatsappUserId !== undefined) return false;
  if (input.platform !== 'discord' && (input.guildId !== undefined || input.parentConversationId !== undefined)) return false;
  if (instance.platform === 'discord') {
    if (instance.senderPolicy.platform !== 'discord' || ![input.accountId, input.actor.id, input.conversationId, input.sourceMessageId].every(discordId)
      || (input.threadId && !discordId(input.threadId)) || (input.parentConversationId && (!discordId(input.parentConversationId) || input.threadId !== input.conversationId)) || input.mediaGroupId) return false;
    if (instance.senderPolicy.allowedUserIds.length && !instance.senderPolicy.allowedUserIds.includes(input.actor.id)) return false;
    return input.directMessage ? input.guildId === undefined && input.parentConversationId === undefined && !input.threadId && instance.scope.directMessages
      : Boolean(input.guildId && discordId(input.guildId) && input.threadId && instance.scope.guildIds.includes(input.guildId)
        && (instance.scope.conversationIds.includes(input.conversationId) || (input.parentConversationId && instance.scope.conversationIds.includes(input.parentConversationId))));
  }
  if (instance.platform === 'slack') {
    if (instance.senderPolicy.platform !== 'slack' || !slackWorkspaceId.test(input.accountId) || !slackUserId.test(input.actor.id)
      || !slackChannelId.test(input.conversationId) || !slackTimestamp.test(input.sourceMessageId) || (input.threadId && !slackTimestamp.test(input.threadId))
      || (!input.directMessage && !input.threadId) || input.mediaGroupId) return false;
    if (instance.senderPolicy.allowedUserIds.length && !instance.senderPolicy.allowedUserIds.includes(input.actor.id)) return false;
    return input.directMessage ? instance.scope.directMessages : instance.scope.conversationIds.includes(input.conversationId)
      || instance.scope.conversationIds.includes(`${input.conversationId}/${input.threadId}`);
  }
  if (instance.platform === 'whatsapp') {
    return instance.senderPolicy.platform === 'whatsapp' && canonicalWhatsAppPhone(input.actor.id)
      && instance.senderPolicy.allowedPhones.includes(input.actor.id) && input.conversationId === input.actor.id
      && input.directMessage && instance.scope.directMessages && !input.threadId && !input.mediaGroupId && input.kind === 'message';
  }
  if (instance.platform !== 'telegram') return false;
  if (instance.senderPolicy.platform !== 'telegram' || input.actor.kind !== 'user' || !/^[1-9]\d*$/.test(input.actor.id)) return false;
  if (!instance.senderPolicy.allowedUserIds.includes(input.actor.id)) return false;
  if (input.directMessage) return instance.scope.directMessages;
  const scope = input.threadId ? `${input.conversationId}/${input.threadId}` : input.conversationId;
  return instance.scope.conversationIds.includes(scope);
}

/** Its SDK adapter must stay connected: both files share the same exclusive instance claim. */
export class GatewayInbox {
  private readonly state: GatewayStateAdapter;

  constructor(state: GatewayStateAdapter) { this.state = state; }

  get instanceId(): string { return this.state.instanceId; }

  private read(): GatewayInboxJournal {
    const file = this.state.inboxFile();
    if (!fs.existsSync(file)) return { version: 1, nextSequence: 1, bindings: [], events: [] };
    const parsed = journalSchema.safeParse(readJSON(file));
    if (!parsed.success) throw new Error('The gateway inbox is unreadable. Restore it before reconnecting.');
    const journal = parsed.data;
    const eventIds = new Set(journal.events.map((event) => event.id));
    if (!albumReceiptsValid(journal)) throw new Error('The gateway album receipts are inconsistent. Restore them before reconnecting.');
    if (!replayReceiptsValid(journal)) throw new Error('The gateway replay or quota receipts are inconsistent. Restore them before reconnecting.');
    if (!relayReceiptsValid(journal)) throw new Error('The gateway relay receipts are inconsistent. Restore them before reconnecting.');
    const bindings = new Map(journal.bindings.map((binding) => [binding.id, binding]));
    const sequences = new Set(journal.events.map((event) => event.sequence));
    const batches = journal.events.filter((event) => event.fileBatch).map((event) => `${event.route.projectId}/${event.fileBatch}`);
    if (new Set(batches).size !== batches.length || eventIds.size !== journal.events.length || bindings.size !== journal.bindings.length || sequences.size !== journal.events.length || journal.events.some((event, index) => {
      const binding = bindings.get(event.bindingId);
      const invalidFiles = Boolean(event.fileBatch) !== Boolean(event.files)
        || (event.files && (event.files.length !== event.input.media.length || event.files.some((file, i) => file.index !== i
          || (file.status === 'transferring' && !file.attempts.length)
          || (file.status === 'saved' && (!file.file || !file.sha256 || file.file.size !== file.attempts.at(-1)?.bytes)))))
        || (event.input.media.length > 0 && ['queued', 'running', 'done'].includes(event.status) && (!event.files || event.files.some((file) => file.status !== 'saved')));
      const invalidOutgoing = event.outgoing && (!event.dispatch || new Set(event.outgoing.map((file) => file.path)).size !== event.outgoing.length || event.outgoing.some((file) => /[\\/\x00-\x1f\x7f]/.test(file.name)
        || file.attempts.some((attempt) => attempt.bytes !== file.size)
        || (['sending', 'sent', 'uncertain'].includes(file.status) && !file.attempts.length)
        || (file.status === 'sent' && !file.remoteId)));
      return !binding || event.route.instanceId !== this.state.instanceId || JSON.stringify(binding.route) !== JSON.stringify(event.route)
        || (event.dispatch && (event.dispatch.conversation.projectId !== event.route.projectId || event.dispatch.conversation.conversationId !== event.bindingId || event.dispatch.conversation.kind !== event.route.target.kind))
        || invalidFiles || invalidOutgoing
        || binding.accountId !== event.input.accountId || binding.conversationId !== event.input.conversationId || binding.guildId !== event.input.guildId || binding.parentConversationId !== event.input.parentConversationId || binding.threadId !== event.input.threadId
        || event.sequence >= journal.nextSequence || (index > 0 && event.sequence <= journal.events[index - 1].sequence);
    })) throw new Error('The gateway inbox has inconsistent receipts. Restore it before reconnecting.');
    return journal;
  }

  private commit(journal: GatewayInboxJournal): void {
    writeJSON(this.state.inboxFile(), journal);
    emit('gateway-inbox', { instanceId: this.state.instanceId });
  }

  list(): GatewayInboxEvent[] { return this.read().events; }

  groupAlbum(eventId: string, body: unknown): { leaderId: string } {
    const parsed = z.strictObject({ eventIds: z.array(externalId).min(2).max(10) }).safeParse(body);
    if (!parsed.success) throw new Error('Choose the complete saved album.');
    const journal = this.read(); const event = journal.events.find((item) => item.id === eventId);
    const members = event ? gatewayAlbumCandidates(journal.events, event) : [];
    const chosen = new Set(parsed.data.eventIds);
    if (!event || !members.length || chosen.size !== parsed.data.eventIds.length || chosen.size !== members.length || members.some((item) => !chosen.has(item.id))
      || journal.retiredAlbums?.includes(albumDigest(event.input))) throw new Error('The album changed or is already grouped. Reload and review its source messages.');
    const limits = this.checkAccess(event).fileLimits;
    for (const item of members) this.checkAccess(item);
    if (members.some((item) => item.files?.some((file) => file.file!.size > limits.perFileBytes))
      || members.reduce((sum, item) => sum + item.input.media.length, 0) > limits.filesPerMessage
      || members.flatMap((item) => item.files ?? []).flatMap((file) => file.attempts).reduce((sum, attempt) => sum + attempt.bytes, 0) > limits.perMessageBytes) throw new Error('The complete album exceeds this instance’s file limits.');
    const leader = members[0]; const ids = members.map((item) => item.id);
    for (const item of members) { item.album = item === leader ? { leaderId: leader.id, memberIds: ids } : { leaderId: leader.id }; item.status = item === leader ? 'queued' : 'done'; delete item.reason; }
    this.commit(journal); return { leaderId: leader.id };
  }

  private sources(journal: GatewayInboxJournal, event: GatewayInboxEvent): GatewayInboxEvent[] {
    if (!event.input.mediaGroupId) return [event];
    if (event.album?.leaderId !== event.id || !event.album.memberIds) throw new Error('Group the complete album before starting work.');
    const members = event.album.memberIds.map((id) => journal.events.find((item) => item.id === id)!);
    if (journal.events.some((item) => (gatewayAlbumKey(item.input) === gatewayAlbumKey(event.input) && (item.albumBlocked || !event.album!.memberIds!.includes(item.id)))
      || (item.input.kind === 'edit' && item.input.accountId === event.input.accountId && item.input.conversationId === event.input.conversationId
        && item.input.threadId === event.input.threadId && members.some((source) => source.input.sourceMessageId === item.input.sourceMessageId)))) throw new Error('The album changed after grouping. Review it before continuing.');
    for (const item of members) this.checkAccess(item);
    return members;
  }

  private holdSource(event: GatewayInboxEvent, reason: string): void {
    if (['queued', 'waiting-files', 'running'].includes(event.status)) {
      event.status = 'needs-review'; event.reason = reason;
      if (event.dispatch) event.dispatch.state = 'needs-review';
    }
    if (event.reply?.parts.some((part) => part.status !== 'sent')) {
      for (const part of event.reply.parts) if (part.status === 'pending') part.status = 'failed';
      event.reply.reason = reason;
    }
    for (const file of event.outgoing ?? []) if (file.status === 'pending') { file.status = 'failed'; file.reason = reason; }
  }

  holdInput(eventId: string, reason: string): void {
    const journal = this.read(); const event = journal.events.find((item) => item.id === eventId);
    if (!event) throw new Error('No such gateway message.');
    this.holdSource(event, reason); this.commit(journal);
  }

  private sourceChanged(journal: GatewayInboxJournal, event: GatewayInboxEvent): boolean {
    try {
      const sources = this.sources(journal, event);
      return journal.events.some((item) => item.input.kind === 'edit' && sources.some((source) => source.input.accountId === item.input.accountId
        && source.input.conversationId === item.input.conversationId && source.input.threadId === item.input.threadId && source.input.sourceMessageId === item.input.sourceMessageId));
    } catch { return true; }
  }

  dispatchSources(eventId: string): GatewayInboxEvent[] {
    const journal = this.read(); const event = journal.events.find((item) => item.id === eventId);
    if (!event) throw new Error('No such gateway message.');
    return this.sources(journal, event);
  }

  /** Detect source changes during asynchronous transport checks without overriding an explicit retry. */
  deliveryVersion(eventId: string): string {
    const journal = this.read(); const event = journal.events.find((item) => item.id === eventId);
    if (!event) throw new Error('No such gateway message.');
    const ids = new Set(event.album?.memberIds ?? [event.id]);
    const sources = journal.events.filter((item) => ids.has(item.id));
    const changes = journal.events.filter((item) => (event.input.mediaGroupId && gatewayAlbumKey(item.input) === gatewayAlbumKey(event.input) && !ids.has(item.id))
      || (item.input.kind === 'edit' && sources.some((source) => source.input.accountId === item.input.accountId && source.input.conversationId === item.input.conversationId
        && source.input.threadId === item.input.threadId && source.input.sourceMessageId === item.input.sourceMessageId))).map((item) => item.id);
    return JSON.stringify([event.status, event.operationId, changes]);
  }

  cleanup(body: unknown): { removed: number } {
    const parsed = z.strictObject({ before: stamp, eventIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(10000) }).safeParse(body);
    if (!parsed.success) throw new GatewayCleanupError('Choose a valid cleanup selection and date.');
    const { before, eventIds } = parsed.data;
    if (before > Date.now() || new Set(eventIds).size !== eventIds.length) throw new GatewayCleanupError('Choose a valid cleanup selection and date.');
    const journal = this.read(); const eligible = new Map(gatewayCleanupCandidates(journal.events, before).map((event) => [event.id, event]));
    if (eventIds.some((id) => !eligible.has(id))) throw new GatewayCleanupError('Some receipts are no longer eligible. Reload the inbox before cleaning up.');
    const selected = new Set(eventIds);
    if (eventIds.some((id) => { const item = eligible.get(id)!; const leader = item.album && eligible.get(item.album.leaderId); return item.album && (!leader?.album?.memberIds || leader.album.memberIds.some((member) => !selected.has(member))); })) throw new GatewayCleanupError('Remove a completed album’s receipts together.');
    if ((journal.retired?.length ?? 0) + eventIds.length > 100000) throw new GatewayCleanupError('The replay-protection store is full. Cleanup cannot remove its protection.');
    const quotas = new Map((journal.retiredQuota ?? []).map((quota) => [quota.day, { ...quota }]));
    for (const id of eventIds) {
      const event = eligible.get(id)!;
      for (const [direction, attempts] of [
        ['incomingBytes', (event.files ?? []).flatMap((file) => file.attempts)],
        ['outgoingBytes', (event.outgoing ?? []).flatMap((file) => file.attempts)],
      ] as const) for (const attempt of attempts) {
        const quota = quotas.get(attempt.day) ?? { day: attempt.day, incomingBytes: 0, outgoingBytes: 0 };
        quota[direction] += attempt.bytes;
        if (!Number.isSafeInteger(quota[direction])) throw new GatewayCleanupError('The saved byte accounting cannot be compacted safely.');
        quotas.set(attempt.day, quota);
      }
    }
    if (quotas.size > 100000) throw new GatewayCleanupError('The byte accounting store is full. No receipts were removed.');
    const albums = new Set(journal.retiredAlbums ?? []);
    for (const id of eventIds) { const item = eligible.get(id)!; if (item.album?.leaderId === item.id) albums.add(albumDigest(item.input)); }
    if (albums.size > 100000) throw new GatewayCleanupError('The album replay-protection store is full. No receipts were removed.');
    journal.retiredAlbums = [...albums];
    journal.retired = [...(journal.retired ?? []), ...eventIds];
    journal.retiredQuota = [...quotas.values()];
    journal.events = journal.events.filter((event) => !selected.has(event.id));
    this.commit(journal);
    return { removed: eventIds.length };
  }

  beginDispatch(eventId: string, operationId: string, local: GatewayLocalConversation): GatewayInboxEvent {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event || event.status !== 'running' || event.operationId !== operationId || event.dispatch) throw new Error('This gateway input already has an operation.');
    this.checkAccess(event);
    this.sources(journal, event);
    if (local.conversationId !== event.bindingId || local.projectId !== event.route.projectId || local.kind !== event.route.target.kind) throw new Error('The gateway conversation changed.');
    event.dispatch = { conversation: local, state: 'starting', startedAt: Date.now(), ...(local.kind === 'agent' ? { runId: operationId } : local.kind === 'team' ? { messageId: operationId } : {}) };
    this.commit(journal);
    return event;
  }

  recordDispatch(eventId: string, operationId: string, result: Pick<GatewayDispatch, 'runId' | 'messageId' | 'briefId' | 'briefRevision' | 'brain'>): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event?.dispatch || event.status !== 'running' || event.operationId !== operationId) throw new Error('This gateway operation is no longer active.');
    event.dispatch = { ...event.dispatch, ...result, state: 'running' };
    this.commit(journal);
  }

  review(eventId: string, reason = 'This work needs review in Athena before continuing.'): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event) throw new Error('No such gateway message.');
    event.status = 'needs-review'; event.reason = reason;
    if (event.dispatch) event.dispatch.state = 'needs-review';
    if (event.reconciliation?.state === 'tracking') event.reconciliation = { at: Date.now(), state: 'needs-review' };
    this.commit(journal);
  }

  finishDispatch(eventId: string, operationId: string, answer: string): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event?.dispatch || event.status !== 'running' || event.operationId !== operationId) throw new Error('This gateway operation is no longer active.');
    this.checkAccess(event);
    this.sources(journal, event);
    saveAnswer(event, answer);
    if (event.reconciliation?.state === 'tracking') event.reconciliation = { at: Date.now(), state: 'completed' };
    this.commit(journal);
  }

  private heldOperation(journal: GatewayInboxJournal, eventId: string): GatewayInboxEvent {
    const event = journal.events.find((item) => item.id === eventId);
    if (!event || event.status !== 'needs-review' || !event.dispatch || !event.operationId || event.reply) throw new Error('This message has no held operation to check.');
    this.checkAccess(event);
    const sources = this.sources(journal, event);
    if (event.input.kind !== 'message' || journal.events.some((item) => item.input.kind === 'edit'
      && item.input.accountId === event.input.accountId && item.input.conversationId === event.input.conversationId
      && item.input.threadId === event.input.threadId && sources.some((source) => source.input.sourceMessageId === item.input.sourceMessageId))) throw new Error('This source message changed or needs grouping. It cannot be reconciled automatically.');
    return event;
  }

  reconciliationCandidate(eventId: string): GatewayInboxEvent { return this.heldOperation(this.read(), eventId); }

  settleReconciliation(eventId: string, operationId: string, result: GatewayCompletion): GatewayReconciliation {
    const journal = this.read(); const event = this.heldOperation(journal, eventId);
    if (event.operationId !== operationId) throw new Error('The saved operation changed.');
    const state = result.state === 'pending' ? 'tracking' : result.state;
    if (result.state === 'completed') saveAnswer(event, result.answer);
    else if (result.state === 'pending') { event.status = 'running'; event.dispatch!.state = 'running'; delete event.reason; }
    event.reconciliation = { at: Date.now(), state };
    this.commit(journal);
    return event.reconciliation;
  }

  claimReply(): { event: GatewayInboxEvent; index: number } | null {
    const journal = this.read();
    const blocked = new Set<string>();
    for (const event of journal.events) {
      if (blocked.has(event.bindingId)) continue;
      const index = event.reply?.parts.findIndex((part) => part.status !== 'sent') ?? -1;
      if (event.status !== 'done' || index >= 0 || event.outgoing?.some((file) => !['sent', 'skipped'].includes(file.status))) blocked.add(event.bindingId);
      if (index < 0 || !event.reply) continue;
      const part = event.reply.parts[index];
      if (part.status !== 'pending' || (part.retryAt ?? 0) > Date.now()) continue;
      try { this.checkAccess(event); }
      catch {
        part.status = 'failed'; event.reply.reason = 'Access or the destination changed. This reply was not sent.';
        this.commit(journal); continue;
      }
      part.status = 'sending'; part.attempts++;
      this.commit(journal);
      return { event, index };
    }
    return null;
  }

  selectOutgoing(eventId: string, files: Pick<GatewayOutgoingFile, 'path' | 'name' | 'size' | 'sha256' | 'source'>[]): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event?.dispatch || !['running', 'done'].includes(event.status) || journal.events.some((item) => item.bindingId === event.bindingId && item.sequence > event.sequence && item.dispatch)) throw new Error('Select files for the current gateway assignment.');
    const instance = this.checkAccess(event);
    if (!files.length || files.length > instance.fileLimits.filesPerMessage || files.some((file) => file.size > instance.fileLimits.perFileBytes) || files.reduce((sum, file) => sum + file.size, 0) > instance.fileLimits.perMessageBytes) throw new Error('These files exceed this gateway’s limits.');
    if (event.outgoing) {
      if (JSON.stringify(event.outgoing.map(({ path, name, size, sha256, source }) => ({ path, name, size, sha256, ...(source ? { source } : {}) }))) === JSON.stringify(files)) return;
      throw new Error('Files were already selected for this assignment.');
    }
    event.outgoing = files.map((file) => ({ ...file, status: 'pending', attempts: [] }));
    this.commit(journal);
  }

  claimOutgoing(): { event: GatewayInboxEvent; index: number } | null {
    const journal = this.read();
    const blocked = new Set<string>();
    let changed = false;
    for (const event of journal.events) {
      if (blocked.has(event.bindingId)) continue;
      const index = event.outgoing?.findIndex((file) => !['sent', 'skipped'].includes(file.status)) ?? -1;
      if (event.status !== 'done' || event.reply?.parts.some((part) => part.status !== 'sent') || index >= 0) blocked.add(event.bindingId);
      if (event.status !== 'done' || !event.reply?.parts.every((part) => part.status === 'sent') || index < 0) continue;
      const file = event.outgoing![index];
      if (file.status !== 'pending' || (file.retryAt ?? 0) > Date.now()) continue;
      try {
        const instance = this.checkAccess(event);
        const day = new Date().toISOString().slice(0, 10);
        const used = (events: GatewayInboxEvent[], today: boolean) => events.flatMap((item) => item.outgoing ?? []).flatMap((item) => item.attempts).reduce((sum, attempt) => sum + (!today || attempt.day === day ? attempt.bytes : 0), 0);
        const retired = journal.retiredQuota?.find((quota) => quota.day === day)?.outgoingBytes ?? 0;
        if (index >= instance.fileLimits.filesPerMessage || file.size > instance.fileLimits.perFileBytes || used([event], false) + file.size > instance.fileLimits.perMessageBytes || used(journal.events, true) + retired + file.size > instance.fileLimits.dailyBytes) throw new Error('quota');
        file.attempts.push({ day, bytes: file.size });
        file.status = 'sending'; delete file.reason;
        this.commit(journal);
        return { event, index };
      } catch {
        file.status = 'failed'; file.reason = 'Check access, destination and file limits before retrying.'; changed = true;
      }
    }
    if (changed) this.commit(journal);
    return null;
  }

  settleOutgoing(eventId: string, index: number, outcome: GatewayDeliveryOutcome): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    const file = event?.outgoing?.[index];
    if (!file || file.status !== 'sending') throw new Error('This file is no longer sending.');
    if ('remoteId' in outcome) { file.status = 'sent'; file.remoteId = outcome.remoteId; delete file.retryAt; delete file.reason; }
    else {
      file.status = outcome.status; file.retryAt = outcome.retryAt;
      file.reason = outcome.status === 'uncertain' ? 'Delivery uncertain. Check the messaging app before explicitly retrying.' : outcome.status === 'failed' ? 'The file could not be sent. Check its location, contents and setup.' : 'The platform asked this file to wait before retrying.';
      if (outcome.status === 'failed' && outcome.reason === 'whatsapp-window') file.reason = 'The WhatsApp reply window closed. Ask the sender to message again, then retry in Athena.';
      if (outcome.status === 'failed' && outcome.reason === 'whatsapp-file-type') file.reason = 'WhatsApp can send PDF, plain text and Office documents here. Choose a supported file.';
      if (file.status === 'pending' && this.sourceChanged(journal, event!)) { file.status = 'failed'; file.reason = 'The source changed during delivery. Review it before explicitly retrying.'; }
    }
    this.commit(journal);
  }

  changeOutgoing(eventId: string, index: number, action: 'retry' | 'skip'): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    const file = event?.outgoing?.[index];
    if (!event || !file || !['pending', 'failed', 'uncertain'].includes(file.status)) throw new Error('This file cannot be changed.');
    if (action === 'retry') {
      this.checkAccess(event);
      if (file.status === 'pending') throw new Error('This file is already waiting to send.');
    }
    file.status = action === 'skip' ? 'skipped' : 'pending'; delete file.retryAt; delete file.reason;
    this.commit(journal);
  }

  queueNotice(eventId: string, kind: 'working' | 'approval'): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event?.dispatch || event.status !== 'running' || event.notices?.[kind] || (kind === 'working' && event.notices?.approval)) return;
    this.checkAccess(event);
    event.notices ??= {};
    event.notices[kind] = { text: kind === 'working' ? 'Working on it in Athena.' : 'Needs approval in Athena.', status: 'pending', attempts: 0 };
    this.commit(journal);
  }

  claimNotice(eligible: (event: GatewayInboxEvent, kind: 'working' | 'approval') => boolean = () => true): { event: GatewayInboxEvent; kind: 'working' | 'approval' } | null {
    const journal = this.read();
    let changed = false;
    for (const event of journal.events) {
      for (const kind of ['approval', 'working'] as const) {
        const notice = event.notices?.[kind];
        if (!notice || notice.status !== 'pending') continue;
        let allowed = event.status === 'running';
        try { this.checkAccess(event); allowed = allowed && eligible(event, kind); } catch { allowed = false; }
        if (!allowed || (kind === 'working' && event.notices?.approval)) { notice.status = 'failed'; changed = true; continue; }
        if ((notice.retryAt ?? 0) > Date.now()) continue;
        notice.status = 'sending'; notice.attempts++;
        this.commit(journal);
        return { event, kind };
      }
    }
    if (changed) this.commit(journal);
    return null;
  }

  settleNotice(eventId: string, kind: 'working' | 'approval', outcome: GatewayDeliveryOutcome): void {
    const journal = this.read();
    const notice = journal.events.find((item) => item.id === eventId)?.notices?.[kind];
    if (!notice || notice.status !== 'sending') throw new Error('This gateway notice is no longer sending.');
    if ('remoteId' in outcome) { notice.status = 'sent'; notice.remoteId = outcome.remoteId; delete notice.retryAt; }
    else { notice.status = outcome.status; notice.retryAt = outcome.retryAt; }
    this.commit(journal);
  }

  settleReply(eventId: string, index: number, outcome: GatewayDeliveryOutcome): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    const part = event?.reply?.parts[index];
    if (!part || part.status !== 'sending') throw new Error('This gateway reply is no longer sending.');
    if ('remoteId' in outcome) { part.status = 'sent'; part.remoteId = outcome.remoteId; delete part.retryAt; }
    else {
      part.status = outcome.status; part.retryAt = outcome.retryAt;
      event!.reply!.reason = outcome.status === 'uncertain' ? 'Delivery uncertain. Check the messaging app before explicitly retrying.' : outcome.status === 'failed' ? 'The reply could not be sent. Check setup before retrying.' : 'The platform asked this reply to wait before retrying.';
      if (outcome.status === 'failed' && outcome.reason === 'whatsapp-window') event!.reply!.reason = 'The WhatsApp reply window closed. Ask the sender to message again, then retry in Athena.';
      if (part.status === 'pending' && this.sourceChanged(journal, event!)) { part.status = 'failed'; event!.reply!.reason = 'The source changed during delivery. Review it before explicitly retrying.'; }
    }
    if (event!.reply!.parts.every((item) => item.status === 'sent')) delete event!.reply!.reason;
    this.commit(journal);
  }

  retryReply(eventId: string): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event?.reply) throw new Error('No saved reply for this message.');
    this.checkAccess(event);
    const part = event.reply.parts.find((item) => item.status !== 'sent');
    if (!part || !['failed', 'uncertain'].includes(part.status)) throw new Error('This reply is not waiting for an explicit retry.');
    part.status = 'pending'; delete part.retryAt; delete event.reply.reason;
    this.commit(journal);
  }

  checkAccess(event: GatewayInboxEvent): GatewayInstance {
    if (event.input.platform === 'whatsapp' && !event.relay?.confirmed) throw new Error('Wait for the relay acknowledgement before starting work.');
    if (event.input.platform === 'whatsapp') {
      const state = this.read().whatsappRelay;
      if (state?.recovery) throw new Error('Review the WhatsApp relay recovery before continuing.');
      if (!whatsAppIdentityAllowed(event.input, state?.identities)) throw new Error('This WhatsApp identity changed. Review the sender before continuing.');
    }
    const instance = getGatewayInstance(this.state.instanceId);
    if (!gatewayInputAllowed(instance, event.input)) throw new Error('This sender or conversation is no longer allowed.');
    withGatewayRoute(event.route, () => {});
    return instance;
  }

  prepareFiles(eventId: string, createBatch: () => string): GatewayInboxEvent {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event || event.status !== 'waiting-files') throw new Error('This message is not waiting for files.');
    this.checkAccess(event);
    if (!event.fileBatch) {
      event.fileBatch = withGatewayRoute(event.route, createBatch);
      event.files = event.input.media.map((_media, index) => ({ index, status: 'pending', attempts: [] }));
      this.commit(journal);
    }
    return event;
  }

  beginTransfer(eventId: string, index: number): { id: string; budget: number } {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event || event.status !== 'waiting-files') throw new Error('This message is not waiting for files.');
    const instance = this.checkAccess(event);
    const file = event.files?.find((item) => item.index === index);
    if (!file || file.status !== 'pending') throw new Error('This file is not waiting to download.');
    const day = new Date().toISOString().slice(0, 10);
    const used = (events: GatewayInboxEvent[], today: boolean) => events.flatMap((item) => item.files ?? []).flatMap((item) => item.attempts).reduce((sum, attempt) => sum + (!today || attempt.day === day ? attempt.bytes : 0), 0);
    const retired = journal.retiredQuota?.find((quota) => quota.day === day)?.incomingBytes ?? 0;
    const group = event.input.mediaGroupId ? journal.events.filter((item) => item.input.kind === 'message' && gatewayAlbumKey(item.input) === gatewayAlbumKey(event.input)) : [event];
    const budget = Math.min(instance.fileLimits.perFileBytes, instance.fileLimits.perMessageBytes - used(group, false), instance.fileLimits.dailyBytes - used(journal.events, true) - retired);
    if (index >= instance.fileLimits.filesPerMessage || group.reduce((sum, item) => sum + item.input.media.length, 0) > instance.fileLimits.filesPerMessage || budget <= 0) throw new GatewayFileLimitError('The gateway file quota is exhausted.');
    const id = uid('gateway-file-');
    // Reserve before network I/O; failed or interrupted attempts keep their reservation.
    file.attempts.push({ id, day, bytes: budget });
    file.status = 'transferring';
    this.commit(journal);
    return { id, budget };
  }

  finishTransfer(eventId: string, index: number, attemptId: string, saved: UploadedFile, sha256: string): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    const file = event?.files?.find((item) => item.index === index);
    const attempt = file?.attempts.at(-1);
    if (!file || file.status !== 'transferring' || !attempt || attempt.id !== attemptId || saved.size > attempt.bytes) throw new Error('This file transfer is no longer active.');
    file.status = 'saved'; file.file = saved; file.sha256 = sha256; delete file.reason;
    attempt.bytes = saved.size;
    this.commit(journal);
  }

  failFile(eventId: string, index: number, reason: 'download' | 'limit' | 'changed' = 'download'): void {
    const journal = this.read();
    const file = journal.events.find((item) => item.id === eventId)?.files?.find((item) => item.index === index);
    if (!file) throw new Error('No such gateway file.');
    file.status = 'failed';
    file.reason = reason === 'limit' ? 'This file exceeds the file, message or daily limit. Check the limits before retrying.'
      : reason === 'changed' ? 'The saved file changed or is missing. Retry it or ask the sender to resend it.'
      : 'This file could not be saved or verified. Retry it or ask the sender to resend it.';
    this.commit(journal);
  }

  holdFiles(eventId: string): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event || event.status !== 'waiting-files') return;
    event.status = 'needs-review';
    event.reason = 'The destination or access changed while saving files. Review this message.';
    this.commit(journal);
  }

  filesReady(eventId: string): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event || event.status !== 'waiting-files' || !event.files?.length || event.files.length !== event.input.media.length || event.files.some((file) => file.status !== 'saved')) throw new Error('This message still has missing files.');
    this.checkAccess(event);
    event.status = event.input.mediaGroupId ? 'needs-review' : 'queued';
    if (event.input.mediaGroupId) event.reason = 'Album files are saved. Review all parts and group them in this inbox.';
    this.commit(journal);
  }

  retryFiles(eventId: string): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event || event.status !== 'waiting-files') throw new Error('This message is not waiting for files.');
    this.checkAccess(event);
    for (const file of event.files ?? []) if (file.status === 'failed') { file.status = 'pending'; delete file.reason; }
    this.commit(journal);
  }

  /** Returns only after the binding and deduplicated input are durably stored. Never fetches media. */
  accept(value: unknown): GatewayInboxEvent | null {
    const input = inboundSchema.parse(value);
    if (input.platform === 'whatsapp') throw new Error('WhatsApp messages need a verified relay receipt.');
    const journal = this.read(); const before = journal.nextSequence;
    const event = this.record(journal, input);
    if (journal.nextSequence !== before) this.commit(journal);
    return event;
  }

  /** Bind once to the paired relay's epoch and existing acknowledgement cursor. */
  bindWhatsAppRelay(epoch: string, cursor: number): void {
    const value = z.strictObject({ epoch: z.uuid(), cursor: stamp }).parse({ epoch, cursor });
    if (getGatewayInstance(this.state.instanceId).platform !== 'whatsapp') throw new Error('Choose a WhatsApp instance.');
    const journal = this.read();
    if (journal.whatsappRelay) {
      if (journal.whatsappRelay.epoch !== epoch || journal.whatsappRelay.cursor !== cursor) throw new Error('The relay cursor changed. Review recovery before reconnecting.');
      return;
    }
    journal.whatsappRelay = value; this.commit(journal);
  }

  whatsAppRelayState(): GatewayWhatsAppIntakeState | undefined { return this.read().whatsappRelay; }

  /** Explicit pairing only. A later status response must never reset this saved binding or cursor. */
  bindWhatsAppRelayConnection(value: GatewayWhatsAppRelayConnection, cursor: number): void {
    const connection = whatsAppRelayConnectionSchema.parse(value); const journal = this.read();
    const instance = getGatewayInstance(this.state.instanceId);
    if (instance.platform !== 'whatsapp' || instance.accountId !== connection.phoneNumberId || !stamp.safeParse(cursor).success) throw new Error('Choose the paired WhatsApp phone.');
    const state = journal.whatsappRelay;
    if (state && (state.epoch !== connection.epoch || state.cursor !== cursor || state.recovery || (state.identities && state.identities.businessAccountId !== connection.businessAccountId)
      || (state.connection && JSON.stringify(state.connection) !== JSON.stringify(connection)))) throw new Error('The relay pairing changed. Review recovery before reconnecting.');
    journal.whatsappRelay = { ...(state ?? { epoch: connection.epoch, cursor }), connection };
    this.commit(journal);
  }

  holdWhatsAppRelay(reason: NonNullable<GatewayWhatsAppIntakeState['recovery']>['reason']): void {
    const journal = this.read(); const state = journal.whatsappRelay;
    if (!state) throw new Error('Pair the WhatsApp relay before reviewing recovery.');
    if (state.recovery) return;
    state.recovery = relayRecovery.parse({ at: Date.now(), reason });
    for (const event of journal.events) this.holdSource(event, 'Review the WhatsApp relay recovery before continuing.');
    this.commit(journal);
  }

  /** All normalized messages, pinned routes and the batch outcome commit before remote ACK. */
  acceptWhatsAppRelay(value: GatewayWhatsAppReceipt, inputs: unknown[], ignored = 0, unmatchedSenders = 0, identities?: GatewayWhatsAppIdentities): NonNullable<GatewayWhatsAppIntakeState['receipt']> {
    const receipt = relayReceipt.parse(value);
    const parsed = z.array(inboundSchema).max(1000).parse(inputs);
    const counts = z.strictObject({ ignored: stamp.max(1000), unmatchedSenders: stamp.max(1000) }).parse({ ignored, unmatchedSenders });
    const journal = this.read(); const state = journal.whatsappRelay;
    if (state?.recovery) throw new Error('Review the WhatsApp relay recovery before continuing.');
    if (!state || state.epoch !== receipt.epoch || getGatewayInstance(this.state.instanceId).platform !== 'whatsapp'
      || parsed.some((input) => input.platform !== 'whatsapp')) throw new Error('This message belongs to another relay.');
    if (state.receipt?.sequence === receipt.sequence && state.receipt.id === receipt.id) return state.receipt;
    if (state.receipt?.confirmed === false || receipt.sequence !== state.cursor + 1) throw new Error('Confirm the saved relay receipt before accepting another batch.');
    if (identities) {
      const saved = whatsAppIdentitiesSchema.parse(identities);
      if (state.identities && state.identities.businessAccountId !== saved.businessAccountId) throw new Error('The WhatsApp business account changed. Review setup before reconnecting.');
      state.identities = saved;
    }
    let accepted = 0;
    for (const input of parsed) {
      const event = whatsAppIdentityAllowed(input, state.identities) ? this.record(journal, input, { ...receipt, confirmed: false }) : null;
      if (event) accepted++; else counts.ignored++;
    }
    for (const event of journal.events) if (!whatsAppIdentityAllowed(event.input, state.identities)) this.holdSource(event, 'This WhatsApp identity changed. Review the sender before continuing.');
    state.receipt = intakeReceipt.parse({ ...receipt, confirmed: false, accepted, ...counts });
    this.commit(journal); return state.receipt;
  }

  /** Call only after an authenticated relay response confirms this exact prefix. */
  confirmWhatsAppRelay(value: GatewayWhatsAppReceipt): void {
    const proof = relayReceipt.parse(value); const journal = this.read();
    const state = journal.whatsappRelay; const receipt = state?.receipt;
    if (state?.recovery) throw new Error('Review the WhatsApp relay recovery before continuing.');
    if (!state || !receipt || receipt.epoch !== proof.epoch || receipt.sequence !== proof.sequence || receipt.id !== proof.id) throw new Error('The relay acknowledgement does not match the saved receipt.');
    if (receipt.confirmed) return;
    for (const event of journal.events) if (event.relay && event.relay.epoch === proof.epoch && event.relay.sequence === proof.sequence && event.relay.id === proof.id) event.relay.confirmed = true;
    state.cursor = proof.sequence; receipt.confirmed = true; this.commit(journal);
  }

  private record(journal: GatewayInboxJournal, input: GatewayInbound, relay?: GatewayInboxEvent['relay']): GatewayInboxEvent | null {
    const instance = getGatewayInstance(this.state.instanceId);
    if (!gatewayInputAllowed(instance, input)) return null;
    const source = [instance.id, input.accountId, input.conversationId, input.threadId, input.sourceMessageId];
    if (input.platform === 'discord') source.push(input.guildId ?? '');
    const eventId = digest([...source, input.kind, ...(input.kind === 'edit' ? [input.sourceEventId] : [])]);
    if (journal.retired?.includes(eventId)) return null;
    const duplicate = journal.events.find((event) => event.id === eventId);
    if (duplicate) return duplicate;
    const boundRoute = captureGatewayRoute(instance.id);
    const bindingId = digest([instance.id, input.accountId, input.conversationId, input.threadId, boundRoute.generation, ...(input.platform === 'discord' ? [input.guildId ?? ''] : [])]);
    let binding = journal.bindings.find((item) => item.id === bindingId);
    // A new channel conversation needs a mention/reply. Topic scope is explicit and exact.
    if (!input.directMessage && !binding && !input.triggered) return null;
    const original = input.kind === 'edit' ? journal.events.find((event) => event.id === digest([...source, 'message'])) : undefined;
    if (input.kind === 'edit' && !original) return null;
    if (input.kind === 'message' && !input.text && !input.media.length) return null;
    if (journal.events.length >= 10000) throw new Error('The gateway inbox is full. Free space before retrying.');
    if (!binding) {
      binding = { id: bindingId, accountId: input.accountId, conversationId: input.conversationId, ...(input.guildId ? { guildId: input.guildId } : {}), ...(input.parentConversationId ? { parentConversationId: input.parentConversationId } : {}), threadId: input.threadId, route: boundRoute, createdAt: Date.now() };
      journal.bindings.push(binding);
    }
    const event: GatewayInboxEvent = {
      id: eventId, bindingId: binding.id, route: binding.route, input, sequence: journal.nextSequence++,
      receivedAt: Date.now(), status: input.kind === 'edit' ? 'needs-review' : input.media.length ? 'waiting-files' : 'queued',
      ...(relay ? { relay } : {}),
    };
    const leader = input.mediaGroupId ? journal.events.find((item) => item.album?.leaderId === item.id && gatewayAlbumKey(item.input) === gatewayAlbumKey(input)) : undefined;
    if (input.kind === 'message' && input.mediaGroupId && (leader || journal.retiredAlbums?.includes(albumDigest(input)))) {
      event.status = 'needs-review'; event.albumBlocked = true;
      event.reason = 'Another album part arrived after grouping. Review it and the original assignment in Athena. No second assignment was started.';
      if (leader) this.holdSource(leader, event.reason);
    }
    if (input.kind === 'edit') {
      event.reason = 'Message edited. Review it before starting more work.';
      const assignment = original?.album ? journal.events.find((item) => item.id === original.album!.leaderId) : original;
      if (assignment) this.holdSource(assignment, 'The source message changed. Review this work before explicitly retrying delivery.');
    }
    journal.events.push(event);
    return event;
  }

  /** A saved operation ID precedes any side effect. Earlier unresolved input blocks its conversation. */
  claimNext(): GatewayInboxEvent | null {
    const journal = this.read();
    let changed = false;
    const blocked = new Set<string>();
    for (const event of journal.events) {
      const prior = blocked.has(event.bindingId);
      if (event.status !== 'done' || event.reply?.parts.some((part) => part.status !== 'sent') || event.outgoing?.some((file) => !['sent', 'skipped'].includes(file.status))) blocked.add(event.bindingId);
      if (event.status !== 'queued') continue;
      if (prior) continue;
      if (event.input.platform === 'whatsapp' && !event.relay?.confirmed) continue;
      try {
        this.checkAccess(event);
      } catch {
        event.status = 'needs-review';
        event.reason = 'Access or the destination changed. Review this message before retrying.';
        changed = true;
        continue;
      }
      event.status = 'running';
      event.operationId = uid('gateway-operation-');
      this.commit(journal);
      return event;
    }
    if (changed) this.commit(journal);
    return null;
  }

  complete(eventId: string, operationId: string): void {
    const journal = this.read();
    const event = journal.events.find((item) => item.id === eventId);
    if (!event || event.operationId !== operationId || event.status !== 'running' || event.dispatch) throw new Error('This gateway operation is no longer running.');
    event.status = 'done';
    this.commit(journal);
  }

  /** Interrupted work requires reconciliation with its saved operation ID, never a blind second run. */
  recover(): void {
    const journal = this.read();
    let changed = false;
    for (const event of journal.events) {
      for (const file of event.outgoing ?? []) {
        if (file.status !== 'sending') continue;
        file.status = 'uncertain'; file.reason = 'Delivery was interrupted. Check the messaging app before explicitly retrying.'; changed = true;
      }
      for (const notice of Object.values(event.notices ?? {})) {
        if (notice.status !== 'sending') continue;
        notice.status = 'uncertain'; changed = true;
      }
      for (const file of event.files ?? []) {
        if (file.status !== 'transferring') continue;
        file.status = 'failed'; file.reason = 'The download was interrupted. Retry it or ask the sender to resend it.';
        changed = true;
      }
      for (const part of event.reply?.parts ?? []) {
        if (part.status !== 'sending') continue;
        part.status = 'uncertain'; event.reply!.reason = 'Delivery was interrupted. Check the messaging app before explicitly retrying.'; changed = true;
      }
      if (event.status !== 'running') continue;
      if (event.dispatch) continue;
      event.status = 'needs-review';
      event.reason = 'Work was interrupted. Check its saved operation before retrying.';
      changed = true;
    }
    if (changed) this.commit(journal);
  }
}
