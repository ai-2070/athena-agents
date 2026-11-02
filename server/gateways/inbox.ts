import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { GatewayInbound, GatewayInboxEvent, GatewayInboxJournal, GatewayInstance, UploadedFile } from '../../shared/types.ts';
import { emit } from '../store.ts';
import { readJSON, uid, writeJSON } from '../util.ts';
import { captureGatewayRoute, getGatewayInstance, withGatewayRoute } from './instances.ts';
import type { GatewayStateAdapter } from './state.ts';

const externalId = z.string().min(1).max(500);
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('brain') }),
  z.strictObject({ kind: z.literal('agent'), id: externalId }),
  z.strictObject({ kind: z.literal('team'), id: externalId }),
]);
const route = z.strictObject({ instanceId: externalId, projectId: externalId, target, generation: stamp.positive() });
const inboundSchema: z.ZodType<GatewayInbound> = z.strictObject({
  platform: z.enum(['telegram', 'slack', 'discord', 'whatsapp']), accountId: externalId,
  conversationId: externalId, threadId: z.string().max(500), sourceEventId: externalId, sourceMessageId: externalId,
  kind: z.enum(['message', 'edit']),
  actor: z.strictObject({ id: externalId, label: z.string().max(200), kind: z.enum(['user', 'bot', 'anonymous']) }),
  directMessage: z.boolean(), triggered: z.boolean(), text: z.string().max(65536),
  mediaGroupId: externalId.optional(),
  media: z.array(z.strictObject({
    kind: z.enum(['image', 'file', 'audio', 'video']), fileId: externalId,
    name: z.string().max(512).optional(), mimeType: z.string().max(200).optional(), size: stamp.optional(),
  })).max(10),
});
const journalSchema: z.ZodType<GatewayInboxJournal> = z.strictObject({
  version: z.literal(1), nextSequence: stamp.positive(),
  bindings: z.array(z.strictObject({ id: externalId, accountId: externalId, conversationId: externalId, threadId: z.string().max(500), route, createdAt: stamp })),
  events: z.array(z.strictObject({
    id: externalId, bindingId: externalId, route, input: inboundSchema, sequence: stamp.positive(), receivedAt: stamp,
    status: z.enum(['queued', 'waiting-files', 'running', 'done', 'needs-review']), operationId: externalId.optional(), reason: z.string().optional(),
    fileBatch: z.string().regex(/^[\w-]{1,64}$/).optional(),
    files: z.array(z.strictObject({
      index: stamp, status: z.enum(['pending', 'transferring', 'saved', 'failed']),
      attempts: z.array(z.strictObject({ id: externalId, day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), bytes: stamp })),
      file: z.strictObject({ path: z.string(), top: z.string(), kind: z.enum(['file', 'folder']), name: z.string(), size: stamp }).optional(),
      sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), reason: z.string().optional(),
    })).optional(),
  })),
});
const digest = (parts: (string | number)[]): string => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export class GatewayFileLimitError extends Error {}

/** Only Telegram has a verified raw-event normalizer so far. Other transports fail closed. */
export function gatewayInputAllowed(instance: GatewayInstance, input: GatewayInbound): boolean {
  if (!instance.enabled || instance.platform !== 'telegram' || input.platform !== 'telegram' || input.accountId !== instance.accountId) return false;
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

  private read(): GatewayInboxJournal {
    const file = this.state.inboxFile();
    if (!fs.existsSync(file)) return { version: 1, nextSequence: 1, bindings: [], events: [] };
    const parsed = journalSchema.safeParse(readJSON(file));
    if (!parsed.success) throw new Error('The gateway inbox is unreadable. Restore it before reconnecting.');
    const journal = parsed.data;
    const eventIds = new Set(journal.events.map((event) => event.id));
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
      return !binding || event.route.instanceId !== this.state.instanceId || JSON.stringify(binding.route) !== JSON.stringify(event.route)
        || invalidFiles
        || binding.accountId !== event.input.accountId || binding.conversationId !== event.input.conversationId || binding.threadId !== event.input.threadId
        || event.sequence >= journal.nextSequence || (index > 0 && event.sequence <= journal.events[index - 1].sequence);
    })) throw new Error('The gateway inbox has inconsistent receipts. Restore it before reconnecting.');
    return journal;
  }

  private commit(journal: GatewayInboxJournal): void {
    writeJSON(this.state.inboxFile(), journal);
    emit('gateway-inbox', { instanceId: this.state.instanceId });
  }

  list(): GatewayInboxEvent[] { return this.read().events; }

  checkAccess(event: GatewayInboxEvent): GatewayInstance {
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
    const budget = Math.min(instance.fileLimits.perFileBytes, instance.fileLimits.perMessageBytes - used([event], false), instance.fileLimits.dailyBytes - used(journal.events, true));
    if (index >= instance.fileLimits.filesPerMessage || budget <= 0) throw new GatewayFileLimitError('The gateway file quota is exhausted.');
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
    if (event.input.mediaGroupId) event.reason = 'Album files are saved. Group its messages before starting work.';
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
    const instance = getGatewayInstance(this.state.instanceId);
    if (!gatewayInputAllowed(instance, input)) return null;
    const journal = this.read();
    const source = [instance.id, input.accountId, input.conversationId, input.threadId, input.sourceMessageId];
    const eventId = digest([...source, input.kind, ...(input.kind === 'edit' ? [input.sourceEventId] : [])]);
    const duplicate = journal.events.find((event) => event.id === eventId);
    if (duplicate) return duplicate;
    const boundRoute = captureGatewayRoute(instance.id);
    const bindingId = digest([instance.id, input.accountId, input.conversationId, input.threadId, boundRoute.generation]);
    let binding = journal.bindings.find((item) => item.id === bindingId);
    // A new channel conversation needs a mention/reply. Topic scope is explicit and exact.
    if (!input.directMessage && !binding && !input.triggered) return null;
    const original = input.kind === 'edit' ? journal.events.find((event) => event.id === digest([...source, 'message'])) : undefined;
    if (input.kind === 'edit' && !original) return null;
    if (!input.text && !input.media.length) return null;
    if (journal.events.length >= 10000) throw new Error('The gateway inbox is full. Free space before retrying.');
    if (!binding) {
      binding = { id: bindingId, accountId: input.accountId, conversationId: input.conversationId, threadId: input.threadId, route: boundRoute, createdAt: Date.now() };
      journal.bindings.push(binding);
    }
    const event: GatewayInboxEvent = {
      id: eventId, bindingId: binding.id, route: binding.route, input, sequence: journal.nextSequence++,
      receivedAt: Date.now(), status: input.kind === 'edit' ? 'needs-review' : input.media.length ? 'waiting-files' : 'queued',
    };
    if (input.kind === 'edit') {
      event.reason = 'Message edited. Review it before starting more work.';
      if (original && (original.status === 'queued' || original.status === 'waiting-files')) { original.status = 'needs-review'; original.reason = event.reason; }
    }
    journal.events.push(event);
    this.commit(journal);
    return event;
  }

  /** A saved operation ID precedes any side effect. Earlier unresolved input blocks its conversation. */
  claimNext(): GatewayInboxEvent | null {
    const journal = this.read();
    let changed = false;
    const blocked = new Set<string>();
    for (const event of journal.events) {
      const prior = blocked.has(event.bindingId);
      if (event.status !== 'done') blocked.add(event.bindingId);
      if (event.status !== 'queued') continue;
      if (prior) continue;
      try {
        const instance = getGatewayInstance(this.state.instanceId);
        if (!gatewayInputAllowed(instance, event.input)) throw new Error('The sender or conversation is no longer allowed.');
        withGatewayRoute(event.route, () => {});
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
    if (!event || event.operationId !== operationId || event.status !== 'running') throw new Error('This gateway operation is no longer running.');
    event.status = 'done';
    this.commit(journal);
  }

  /** Interrupted work requires reconciliation with its saved operation ID, never a blind second run. */
  recover(): void {
    const journal = this.read();
    let changed = false;
    for (const event of journal.events) {
      for (const file of event.files ?? []) {
        if (file.status !== 'transferring') continue;
        file.status = 'failed'; file.reason = 'The download was interrupted. Retry it or ask the sender to resend it.';
        changed = true;
      }
      if (event.status !== 'running') continue;
      event.status = 'needs-review';
      event.reason = 'Work was interrupted. Check its saved operation before retrying.';
      changed = true;
    }
    if (changed) this.commit(journal);
  }
}
