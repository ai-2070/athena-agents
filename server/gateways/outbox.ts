import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import type { GatewayDeliveryOutcome, GatewayInboxEvent, GatewayOutboxApproval, GatewayOutboxDelivery, GatewayOutboxJournal, GatewayOutboxPreview } from '../../shared/types.ts';
import { emit, getGatewaySecrets } from '../store.ts';
import { privateDataPath } from '../private.ts';
import { readJSON, writeJSON } from '../util.ts';
import { getGatewayInstance } from './instances.ts';
import type { GatewayInbox } from './inbox.ts';
import type { GatewayStateAdapter } from './state.ts';

const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(3000).refine((value) => value.trim().length > 0 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value));
const request = z.strictObject({ instanceId: id, projectId: id, postId: id, eventId: hash, parts: z.array(text).min(1).max(100) })
  .refine((value) => value.parts.reduce((sum, part) => sum + part.length, 0) <= 100000);
const approval = request.safeExtend({ revision: hash });
const receipt = z.strictObject({ text, status: z.enum(['pending', 'sending', 'sent', 'uncertain', 'failed']), attempts: stamp,
  remoteId: z.string().min(1).max(500).regex(/^\S+$/).optional(), retryAt: stamp.optional() });
const delivery: z.ZodType<GatewayOutboxDelivery> = approval.safeExtend({ bindingId: hash, configHash: hash, sourceHash: hash,
  approvedAt: stamp, receipts: z.array(receipt).min(1).max(100), held: z.literal('destination-changed').optional() })
  .refine((value) => {
    let unfinished = false;
    return value.revision === reviewRevision(value, value.configHash, value.sourceHash)
      && value.parts.length === value.receipts.length && value.receipts.every((part, index) => {
      if (part.text !== value.parts[index] || (part.status === 'sent') !== Boolean(part.remoteId)
        || (['sending', 'sent', 'uncertain'].includes(part.status) && !part.attempts)
        || (part.retryAt !== undefined && part.status !== 'pending')) return false;
      if (unfinished && (part.status !== 'pending' || part.attempts !== 0)) return false;
      if (part.status !== 'sent') unfinished = true;
      return true;
    }) && !(value.held && value.receipts.some((part) => part.status === 'sending'));
  });
const schema: z.ZodType<GatewayOutboxJournal> = z.strictObject({ version: z.literal(1), deliveries: z.array(delivery).max(1000) })
  .refine((value) => new Set(value.deliveries.map((item) => JSON.stringify([item.projectId, item.postId]))).size === value.deliveries.length
    && value.deliveries.flatMap((item) => item.receipts).filter((part) => part.status === 'sending').length <= 1
    && value.deliveries.reduce((sum, item) => sum + item.parts.reduce((length, part) => length + part.length, 0), 0) <= 1000000);
const digest = (value: unknown): string => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function reviewRevision(value: Omit<GatewayOutboxApproval, 'revision'>, configHash: string, sourceHash: string): string {
  return digest([value.instanceId, value.projectId, value.postId, value.eventId, value.parts, configHash, sourceHash]);
}
const unfinished = (item: GatewayOutboxDelivery): boolean => item.receipts.some((part) => part.status !== 'sent');

function read(file: string, instanceId: string): GatewayOutboxJournal {
  if (!fs.existsSync(file)) return { version: 1, deliveries: [] };
  const result = schema.safeParse(readJSON(file));
  if (!result.success || result.data.deliveries.some((item) => item.instanceId !== instanceId)) {
    throw new Error('The gateway Outbox receipts are unreadable. Restore them before reconnecting.');
  }
  return result.data;
}

/** Keep the real source binding until every approved part has a confirmed receipt. */
export function gatewayOutboxProtectedBindings(instanceId: string): Set<string> {
  return new Set(read(privateDataPath('gateways-runtime', instanceId, 'outbox.json'), instanceId).deliveries.filter(unfinished).map((item) => item.bindingId));
}

export interface GatewayOutboxClaim {
  projectId: string;
  postId: string;
  index: number;
  attempt: number;
  event: GatewayInboxEvent;
  text: string;
}

/** Only called under the worker's state claim. Browser/tool approval is wired separately. */
export class GatewayOutboxLedger {
  constructor(privateState: GatewayStateAdapter, inbox: GatewayInbox) {
    if (privateState.instanceId !== inbox.instanceId) throw new Error('The gateway Outbox instance does not match.');
    this.state = privateState; this.inbox = inbox;
    this.tokenHash = digest(getGatewaySecrets(privateState.instanceId).botToken ?? null);
  }
  private readonly state: GatewayStateAdapter;
  private readonly inbox: GatewayInbox;
  private readonly tokenHash: string;

  list(): GatewayOutboxDelivery[] { return read(this.state.outboxFile(), this.state.instanceId).deliveries; }

  private commit(journal: GatewayOutboxJournal): void {
    if (!schema.safeParse(journal).success) throw new Error('The gateway Outbox receipts cannot be saved safely.');
    try { writeJSON(this.state.outboxFile(), journal); }
    catch { throw new Error('The gateway Outbox receipts could not be saved. Check local storage.'); }
    emit('gateway-inbox', { instanceId: this.state.instanceId });
  }

  private context(projectId: string, eventId: string) {
    const event = this.inbox.outboxSource(eventId, projectId);
    const instance = getGatewayInstance(this.state.instanceId);
    if (instance.platform !== 'telegram' && instance.platform !== 'discord') throw new Error('Approved Outbox sends currently support Telegram and Discord only.');
    const botToken = getGatewaySecrets(instance.id).botToken;
    if (!botToken) throw new Error('Add this gateway instance’s bot token before reviewing its Outbox send.');
    if (digest(botToken) !== this.tokenHash) throw new Error('Reconnect this gateway after changing its credentials.');
    const configHash = digest([instance.id, instance.name, instance.platform, instance.accountId, instance.projectId, instance.target,
      instance.routeGeneration, instance.senderPolicy, instance.scope, instance.fileLimits, botToken]);
    const sourceHash = digest(this.inbox.dispatchSources(eventId).map((source) => [source.id, source.bindingId, source.route, source.input, source.sequence]));
    return { event, configHash, sourceHash, recipient: { platform: instance.platform, instanceName: instance.name, accountId: instance.accountId,
      conversationId: event.input.conversationId, threadId: event.input.threadId, sourceMessageId: event.input.sourceMessageId, sender: event.input.actor.label } };
  }

  prepare(body: unknown): GatewayOutboxPreview {
    const parsed = request.safeParse(body);
    if (!parsed.success || parsed.data.instanceId !== this.state.instanceId) throw new Error('Choose an explicit gateway instance, saved conversation and text parts.');
    const value = parsed.data; const context = this.context(value.projectId, value.eventId);
    if (context.recipient.platform === 'discord' && value.parts.some((part) => part.length > 2000)) throw new Error('Split Discord text into parts of at most 2,000 characters.');
    const revision = reviewRevision(value, context.configHash, context.sourceHash);
    return { approval: { ...value, revision }, recipient: context.recipient };
  }

  approve(body: unknown): GatewayOutboxDelivery {
    const parsed = approval.safeParse(body);
    if (!parsed.success) throw new Error('Review the exact Outbox recipient and text before approving.');
    const { revision, ...value } = parsed.data;
    if (value.instanceId !== this.state.instanceId) throw new Error('The gateway Outbox instance does not match.');
    const journal: GatewayOutboxJournal = { version: 1, deliveries: this.list() };
    const before = journal.deliveries.find((item) => item.projectId === value.projectId && item.postId === value.postId);
    if (before) {
      if (before.revision !== revision || before.eventId !== value.eventId || JSON.stringify(before.parts) !== JSON.stringify(value.parts)) {
        throw new Error('This Outbox post already has an approved delivery. Create a new draft to change its recipient or text.');
      }
      return before;
    }
    const preview = this.prepare(value);
    if (preview.approval.revision !== revision) throw new Error('The Outbox recipient, access or text changed. Review it again before approving.');
    const context = this.context(value.projectId, value.eventId);
    const item: GatewayOutboxDelivery = { ...preview.approval, bindingId: context.event.bindingId, configHash: context.configHash,
      sourceHash: context.sourceHash, approvedAt: Date.now(), receipts: value.parts.map((text) => ({ text, status: 'pending', attempts: 0 })) };
    journal.deliveries.push(item); this.commit(journal); return item;
  }

  recover(): void {
    const journal: GatewayOutboxJournal = { version: 1, deliveries: this.list() }; let changed = false;
    for (const item of journal.deliveries) for (const part of item.receipts) if (part.status === 'sending') { part.status = 'uncertain'; changed = true; }
    if (changed) this.commit(journal);
  }

  claim(): GatewayOutboxClaim | null {
    const journal: GatewayOutboxJournal = { version: 1, deliveries: this.list() };
    if (journal.deliveries.some((item) => item.receipts.some((part) => part.status === 'sending')) || !getGatewayInstance(this.state.instanceId).enabled) return null;
    const blocked = new Set<string>();
    for (const item of journal.deliveries) {
      if (!unfinished(item) || blocked.has(item.bindingId)) continue;
      blocked.add(item.bindingId);
      const index = item.receipts.findIndex((part) => part.status !== 'sent'); const part = item.receipts[index];
      if (item.held || part.status !== 'pending' || (part.retryAt ?? 0) > Date.now()) continue;
      let event: GatewayInboxEvent;
      try {
        const context = this.context(item.projectId, item.eventId);
        if (item.configHash !== context.configHash || item.sourceHash !== context.sourceHash || item.bindingId !== context.event.bindingId) throw new Error('Changed');
        event = context.event;
      } catch {
        item.held = 'destination-changed'; this.commit(journal); continue;
      }
      if (part.attempts === Number.MAX_SAFE_INTEGER) throw new Error('The gateway Outbox attempt limit was reached.');
      part.status = 'sending'; part.attempts++; delete part.retryAt;
      this.commit(journal);
      return { projectId: item.projectId, postId: item.postId, index, attempt: part.attempts, event, text: part.text };
    }
    return null;
  }

  settle(claim: GatewayOutboxClaim, outcome: GatewayDeliveryOutcome): void {
    const journal: GatewayOutboxJournal = { version: 1, deliveries: this.list() };
    const item = journal.deliveries.find((entry) => entry.projectId === claim.projectId && entry.postId === claim.postId);
    const part = item?.receipts[claim.index];
    if (!item || item.eventId !== claim.event.id || !part || part.status !== 'sending' || part.attempts !== claim.attempt || part.text !== claim.text) {
      throw new Error('This Outbox send no longer owns the pending receipt. Reload its delivery results.');
    }
    if ('remoteId' in outcome) { part.status = 'sent'; part.remoteId = outcome.remoteId; }
    else { part.status = outcome.status; if (outcome.status === 'pending' && outcome.retryAt !== undefined) part.retryAt = outcome.retryAt; }
    this.commit(journal);
  }

  /** Checked again by the transport after asynchronous preflight and immediately before POST. */
  authorize(claim: GatewayOutboxClaim, event: GatewayInboxEvent, text: string): string {
    const item = this.list().find((entry) => entry.projectId === claim.projectId && entry.postId === claim.postId);
    const part = item?.receipts[claim.index];
    if (!item || item.held || item.eventId !== claim.event.id || !part || part.status !== 'sending'
      || part.attempts !== claim.attempt || part.text !== claim.text || text !== part.text || event.id !== item.eventId) throw new Error('This approved Outbox send is no longer current.');
    const context = this.context(item.projectId, item.eventId);
    if (item.configHash !== context.configHash || item.sourceHash !== context.sourceHash || item.bindingId !== context.event.bindingId
      || JSON.stringify(event.input) !== JSON.stringify(context.event.input) || JSON.stringify(event.route) !== JSON.stringify(context.event.route)) {
      throw new Error('The approved Outbox destination changed before delivery.');
    }
    return digest([this.state.instanceId, item.projectId, item.postId, item.eventId, 'outbox', claim.index, claim.attempt]).slice(0, 24);
  }
}
