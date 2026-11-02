import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { GatewayInbound, GatewayInboxEvent, GatewayInboxJournal, GatewayInstance } from '../../shared/types.ts';
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
  })),
});
const digest = (parts: (string | number)[]): string => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');

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
    if (eventIds.size !== journal.events.length || bindings.size !== journal.bindings.length || sequences.size !== journal.events.length || journal.events.some((event, index) => {
      const binding = bindings.get(event.bindingId);
      return !binding || event.route.instanceId !== this.state.instanceId || JSON.stringify(binding.route) !== JSON.stringify(event.route)
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
      if (event.status !== 'running') continue;
      event.status = 'needs-review';
      event.reason = 'Work was interrupted. Check its saved operation before retrying.';
      changed = true;
    }
    if (changed) this.commit(journal);
  }
}
