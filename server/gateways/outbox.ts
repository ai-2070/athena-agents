import crypto from 'node:crypto';
import fs from 'node:fs';
import { z } from 'zod';
import type {
  GatewayDeliveryOutcome,
  GatewayInboxEvent,
  GatewayInstance,
  GatewayOutboxApproval,
  GatewayOutboxDelivery,
  GatewayOutboxDeliveryReview,
  GatewayOutboxDestination,
  GatewayOutboxJournal,
  GatewayOutboxPreview,
} from '../../shared/types.ts';
import { emit, getGatewaySecrets } from '../store.ts';
import { privateDataPath } from '../private.ts';
import { readJSON, writeJSON } from '../util.ts';
import { getGatewayInstance } from './instances.ts';
import type { GatewayInbox } from './inbox.ts';
import type { GatewayStateAdapter } from './state.ts';
import { gatewayStateDirectory } from './ownership.ts';
import { gatewayRetirement } from './retirement.ts';
import type { GatewayRetiredInstance } from '../../shared/types.ts';

const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z
  .string()
  .min(1)
  .max(3000)
  .refine(
    (value) =>
      value.trim().length > 0 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value),
  );
const request = z
  .strictObject({ instanceId: id, projectId: id, postId: id, eventId: hash, parts: z.array(text).min(1).max(100) })
  .refine((value) => value.parts.reduce((sum, part) => sum + part.length, 0) <= 100000);
const approval = request.safeExtend({ revision: hash });
const receipt = z.strictObject({
  text,
  status: z.enum(['pending', 'sending', 'sent', 'uncertain', 'failed']),
  attempts: stamp,
  remoteId: z.string().min(1).max(500).regex(/^\S+$/).optional(),
  retryAt: stamp.optional(),
});
const recipient = z.strictObject({
  platform: z.enum(['telegram', 'discord']),
  instanceName: z.string().min(1).max(100),
  accountId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(500),
  threadId: z.string().max(500),
  sourceMessageId: z.string().min(1).max(500),
  sender: z.string().max(200),
});
const reviewRecord = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('confirmed'),
    at: stamp,
    revision: hash,
    index: stamp.max(99),
    attempt: stamp.positive(),
    remoteId: z.string().min(1).max(500).regex(/^\S+$/),
  }),
  z.strictObject({
    action: z.literal('retry'),
    at: stamp,
    revision: hash,
    index: stamp.max(99),
    attempt: stamp,
    from: z.enum(['pending', 'failed', 'uncertain']),
  }),
]);
const delivery: z.ZodType<GatewayOutboxDelivery> = approval
  .safeExtend({
    bindingId: hash,
    configHash: hash,
    sourceHash: hash,
    approvedAt: stamp,
    recipient,
    receipts: z.array(receipt).min(1).max(100),
    held: z.literal('destination-changed').optional(),
    closed: z.strictObject({ at: stamp, revision: hash }).optional(),
    reviewHeld: z.literal(true).optional(),
    reviews: z.array(reviewRecord).min(1).max(1000).optional(),
  })
  .refine((value) => {
    let unfinished = false;
    const { closed, ...beforeClose } = value;
    return (
      reviewReceiptsValid(value) &&
      (!closed || closed.revision === gatewayOutboxReviewRevision(beforeClose)) &&
      value.revision === reviewRevision(value, value.configHash, value.sourceHash, value.recipient) &&
      value.parts.length === value.receipts.length &&
      value.receipts.every((part, index) => {
        if (
          part.text !== value.parts[index] ||
          (part.status === 'sent') !== Boolean(part.remoteId) ||
          (['sending', 'sent', 'uncertain'].includes(part.status) && !part.attempts) ||
          (part.retryAt !== undefined && part.status !== 'pending')
        )
          return false;
        if (unfinished && (part.status !== 'pending' || part.attempts !== 0)) return false;
        if (part.status !== 'sent') unfinished = true;
        return true;
      }) &&
      !((value.held || value.closed) && value.receipts.some((part) => part.status === 'sending'))
    );
  });
const schema: z.ZodType<GatewayOutboxJournal> = z
  .strictObject({ version: z.literal(1), deliveries: z.array(delivery).max(1000) })
  .refine(
    (value) =>
      new Set(value.deliveries.map((item) => JSON.stringify([item.projectId, item.postId]))).size ===
        value.deliveries.length &&
      value.deliveries.flatMap((item) => item.receipts).filter((part) => part.status === 'sending').length <= 1 &&
      value.deliveries.reduce((sum, item) => sum + item.parts.reduce((length, part) => length + part.length, 0), 0) <=
        1000000,
  );
const digest = (value: unknown): string =>
  crypto
    .createHash('sha256')
    .update(
      JSON.stringify(value, (_key, part: unknown) =>
        part && typeof part === 'object' && !Array.isArray(part)
          ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
          : part,
      ),
    )
    .digest('hex');
function reviewRevision(
  value: Omit<GatewayOutboxApproval, 'revision'>,
  configHash: string,
  sourceHash: string,
  recipient: GatewayOutboxPreview['recipient'],
): string {
  return digest([
    value.instanceId,
    value.projectId,
    value.postId,
    value.eventId,
    value.parts,
    configHash,
    sourceHash,
    recipient,
  ]);
}
const unfinished = (item: GatewayOutboxDelivery): boolean =>
  !item.closed && item.receipts.some((part) => part.status !== 'sent');
export const gatewayOutboxReviewRevision = (item: GatewayOutboxDelivery): string => digest(item);

function reviewReceiptsValid(item: GatewayOutboxDelivery): boolean {
  const reviews = item.reviews ?? [];
  const confirmed = new Set<number>();
  const attempts = new Map<number, number>();
  if (new Set(reviews.map((review) => review.revision)).size !== reviews.length) return false;
  for (const [index, review] of reviews.entries()) {
    const part = item.receipts[review.index];
    const previous = reviews[index - 1];
    if (!part || review.attempt > part.attempts || (previous && previous.index > review.index)) return false;
    if (review.action === 'confirmed') {
      if (
        confirmed.has(review.index) ||
        part.status !== 'sent' ||
        part.remoteId !== review.remoteId ||
        part.attempts !== review.attempt
      )
        return false;
      confirmed.add(review.index);
    } else {
      if (
        confirmed.has(review.index) ||
        (attempts.has(review.index) && attempts.get(review.index)! >= review.attempt) ||
        (review.from === 'uncertain' && !review.attempt) ||
        (review.from === 'pending' &&
          (review.attempt !== 0 || previous?.action !== 'confirmed' || previous.index >= review.index))
      )
        return false;
      attempts.set(review.index, review.attempt);
    }
  }
  const needsHold = reviews.at(-1)?.action === 'confirmed' && item.receipts.some((part) => part.status !== 'sent');
  return Boolean(item.reviewHeld) === needsHold;
}

/** Saved metadata only. A retry rechecks live local access under exclusive ownership at POST. */
export function gatewayOutboxDeliveryReview(
  instance: GatewayInstance | undefined,
  item: GatewayOutboxDelivery,
  retired?: GatewayRetiredInstance,
): GatewayOutboxDeliveryReview {
  const paused = Boolean(instance && !instance.enabled);
  const sending = item.receipts.some((part) => part.status === 'sending');
  const nextIndex = item.receipts.findIndex((part) => part.status !== 'sent');
  const next = item.receipts[nextIndex];
  const room = (item.reviews?.length ?? 0) < 1000;
  if (!instance) {
    const matches =
      retired?.id === item.instanceId &&
      retired.accountId === item.recipient.accountId &&
      retired.platform === item.recipient.platform;
    const ready = Boolean(retired?.completedAt !== undefined && matches && !item.closed);
    const reason = item.closed
      ? 'Delivery was finished locally and cannot be reopened.'
      : !retired
        ? 'This instance was removed. Restore its removal record before finishing delivery locally.'
        : !matches
          ? 'The saved recipient does not match the removed instance. Restore its original receipts.'
          : retired.completedAt === undefined
            ? 'Finish removing this instance before changing its Outbox receipts.'
            : sending
              ? 'Recover interrupted receipts before finishing delivery locally.'
              : nextIndex < 0
                ? 'Every part is confirmed.'
                : '';
    return {
      revision: retired ? retiredOutboxRevision(retired, item) : gatewayOutboxReviewRevision(item),
      recipient: item.recipient,
      paused: false,
      removed: true,
      reason,
      needsPrepare: ready && sending,
      canFinish: ready && !sending && nextIndex >= 0,
      canRetry: false,
      retryReason: 'The removed connection stays blocked. Its approved parts cannot be retried here.',
      ...(nextIndex >= 0 ? { nextIndex } : {}),
      reviewHeld: Boolean(item.reviewHeld),
      ...(item.closed ? { closedAt: item.closed.at } : {}),
      parts: item.receipts.map((part, index) => {
        const review = item.reviews?.find((record) => record.action === 'confirmed' && record.index === index);
        return {
          text: part.text,
          status: part.status,
          attempts: part.attempts,
          ...(part.remoteId ? { remoteId: part.remoteId } : {}),
          canConfirm: false,
          ...(review ? { confirmedAt: review.at } : {}),
        };
      }),
    };
  }
  const reason = !instance
    ? 'This gateway instance was removed. Its receipts are kept for recovery.'
    : !paused
      ? 'Pause this gateway before reviewing delivery.'
      : item.closed
        ? 'Delivery was finished locally and cannot be reopened.'
        : sending
          ? 'Recover interrupted receipts before reviewing their outcome.'
          : nextIndex < 0
            ? 'Every part is confirmed.'
            : !room
              ? 'The delivery review history is full. Keep its receipts intact.'
              : '';
  const ready = paused && !item.closed && !sending && room;
  const retryReason =
    reason ||
    (item.held
      ? 'The original gateway setup or source changed. Keep this delivery local and review a new draft.'
      : next?.status === 'pending' && !item.reviewHeld
        ? 'The remaining parts are already queued. Enable this instance to continue under its original approval.'
        : next?.status === 'pending' && (next.retryAt ?? 0) > Date.now()
          ? 'Wait for the saved provider retry time before continuing.'
          : '');
  return {
    revision: gatewayOutboxReviewRevision(item),
    recipient: item.recipient,
    paused,
    reason,
    needsPrepare: paused && !item.closed && sending,
    canFinish: paused && !item.closed && !sending && nextIndex >= 0,
    canRetry: ready && nextIndex >= 0 && !retryReason,
    retryReason,
    ...(nextIndex >= 0 ? { nextIndex } : {}),
    reviewHeld: Boolean(item.reviewHeld),
    ...(item.closed ? { closedAt: item.closed.at } : {}),
    parts: item.receipts.map((part, index) => {
      const review = item.reviews?.find((record) => record.action === 'confirmed' && record.index === index);
      return {
        text: part.text,
        status: part.status,
        attempts: part.attempts,
        ...(part.remoteId ? { remoteId: part.remoteId } : {}),
        canConfirm: ready && part.status === 'uncertain' && part.attempts > 0,
        ...(review ? { confirmedAt: review.at } : {}),
      };
    }),
  };
}

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
  return new Set(
    readGatewayOutboxDeliveries(instanceId)
      .filter(unfinished)
      .map((item) => item.bindingId),
  );
}

export function readGatewayOutboxDeliveries(instanceId: string): GatewayOutboxDelivery[] {
  gatewayStateDirectory(instanceId);
  return read(privateDataPath('gateways-runtime', instanceId, 'outbox.json'), instanceId).deliveries;
}

const retiredOutboxRevision = (retired: GatewayRetiredInstance, item: GatewayOutboxDelivery): string =>
  digest(['retired-outbox-finish-v1', retired, item]);

function commit(file: string, instanceId: string, journal: GatewayOutboxJournal): void {
  if (!schema.safeParse(journal).success) throw new Error('The gateway Outbox receipts cannot be saved safely.');
  try {
    writeJSON(file, journal);
  } catch {
    throw new Error('The gateway Outbox receipts could not be saved. Check local storage.');
  }
  emit('gateway-inbox', { instanceId });
}

/** The caller holds both claims; no SDK, credentials or native inbox is opened. */
export function reviewRetiredGatewayOutbox(
  instanceId: string,
  projectId: string,
  postId: string,
  body: unknown,
  prepare: boolean,
): void {
  const retired = gatewayRetirement(instanceId);
  if (!retired) throw Object.assign(new Error('No such removed gateway instance.'), { status: 404 });
  const file = privateDataPath('gateways-runtime', instanceId, 'outbox.json');
  const journal = read(file, instanceId);
  const item = journal.deliveries.find((entry) => entry.projectId === projectId && entry.postId === postId);
  if (!item) throw Object.assign(new Error('No such saved Outbox delivery.'), { status: 404 });
  const parsed = (
    prepare
      ? z.strictObject({ revision: hash })
      : z.strictObject({ revision: hash, acknowledgeNoSend: z.literal(true) })
  ).safeParse(body);
  const preview = gatewayOutboxDeliveryReview(undefined, item, retired);
  if (
    !parsed.success ||
    parsed.data.revision !== preview.revision ||
    (prepare ? !preview.needsPrepare : !preview.canFinish)
  )
    throw Object.assign(
      new Error(preview.reason || 'The Outbox receipts or removal record changed. Reload and review them again.'),
      { status: 409 },
    );
  if (prepare) {
    for (const part of item.receipts) if (part.status === 'sending') part.status = 'uncertain';
  } else item.closed = { at: Date.now(), revision: gatewayOutboxReviewRevision(item) };
  commit(file, instanceId, journal);
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
    this.state = privateState;
    this.inbox = inbox;
    this.tokenHash = digest(getGatewaySecrets(privateState.instanceId).botToken ?? null);
  }
  private readonly state: GatewayStateAdapter;
  private readonly inbox: GatewayInbox;
  private readonly tokenHash: string;

  list(): GatewayOutboxDelivery[] {
    return read(this.state.outboxFile(), this.state.instanceId).deliveries;
  }

  private commit(journal: GatewayOutboxJournal): void {
    commit(this.state.outboxFile(), this.state.instanceId, journal);
  }

  private context(projectId: string, eventId: string, pausedReview = false) {
    const { event, sources } = this.inbox.outboxEvidence(eventId, projectId, pausedReview);
    const instance = getGatewayInstance(this.state.instanceId);
    if (instance.platform !== 'telegram' && instance.platform !== 'discord')
      throw new Error('Approved Outbox sends currently support Telegram and Discord only.');
    const botToken = getGatewaySecrets(instance.id).botToken;
    if (!botToken) throw new Error('Add this gateway instance’s bot token before reviewing its Outbox send.');
    if (digest(botToken) !== this.tokenHash) throw new Error('Reconnect this gateway after changing its credentials.');
    const configHash = digest([
      instance.id,
      instance.name,
      instance.platform,
      instance.accountId,
      instance.projectId,
      instance.target,
      instance.routeGeneration,
      instance.senderPolicy,
      instance.scope,
      instance.fileLimits,
      botToken,
    ]);
    const sourceHash = digest(
      sources.map((source) => [source.id, source.bindingId, source.route, source.input, source.sequence]),
    );
    return {
      event,
      configHash,
      sourceHash,
      recipient: {
        platform: instance.platform,
        instanceName: instance.name,
        accountId: instance.accountId,
        conversationId: event.input.conversationId,
        threadId: event.input.threadId,
        sourceMessageId: event.input.sourceMessageId,
        sender: event.input.actor.label,
      },
    };
  }

  prepare(body: unknown): GatewayOutboxPreview {
    const parsed = request.safeParse(body);
    if (!parsed.success || parsed.data.instanceId !== this.state.instanceId)
      throw new Error('Choose an explicit gateway instance, saved conversation and text parts.');
    const value = parsed.data;
    const context = this.context(value.projectId, value.eventId);
    if (context.recipient.platform === 'discord' && value.parts.some((part) => part.length > 2000))
      throw new Error('Split Discord text into parts of at most 2,000 characters.');
    const revision = reviewRevision(value, context.configHash, context.sourceHash, context.recipient);
    return { approval: { ...value, revision }, recipient: context.recipient };
  }

  destinations(projectId: string): GatewayOutboxDestination[] {
    const result: GatewayOutboxDestination[] = [];
    const seen = new Set<string>();
    for (const event of this.inbox.list().reverse()) {
      if (event.route.projectId !== projectId || seen.has(event.bindingId) || event.status !== 'done') continue;
      try {
        const context = this.context(projectId, event.id);
        result.push({ instanceId: this.state.instanceId, eventId: event.id, recipient: context.recipient });
        seen.add(event.bindingId);
      } catch {
        continue;
      }
      if (result.length >= 1000) break;
    }
    return result;
  }

  approve(body: unknown): GatewayOutboxDelivery {
    const parsed = approval.safeParse(body);
    if (!parsed.success) throw new Error('Review the exact Outbox recipient and text before approving.');
    const { revision, ...value } = parsed.data;
    if (value.instanceId !== this.state.instanceId) throw new Error('The gateway Outbox instance does not match.');
    const journal: GatewayOutboxJournal = { version: 1, deliveries: this.list() };
    const before = journal.deliveries.find(
      (item) => item.projectId === value.projectId && item.postId === value.postId,
    );
    if (before) {
      if (
        before.revision !== revision ||
        before.eventId !== value.eventId ||
        JSON.stringify(before.parts) !== JSON.stringify(value.parts)
      ) {
        throw new Error(
          'This Outbox post already has an approved delivery. Create a new draft to change its recipient or text.',
        );
      }
      return before;
    }
    const preview = this.prepare(value);
    if (preview.approval.revision !== revision)
      throw new Error('The Outbox recipient, access or text changed. Review it again before approving.');
    const context = this.context(value.projectId, value.eventId);
    const item: GatewayOutboxDelivery = {
      ...preview.approval,
      recipient: context.recipient,
      bindingId: context.event.bindingId,
      configHash: context.configHash,
      sourceHash: context.sourceHash,
      approvedAt: Date.now(),
      receipts: value.parts.map((text) => ({ text, status: 'pending', attempts: 0 })),
    };
    journal.deliveries.push(item);
    this.commit(journal);
    return item;
  }

  recover(target?: { projectId: string; postId: string }): void {
    const journal: GatewayOutboxJournal = { version: 1, deliveries: this.list() };
    let changed = false;
    for (const item of journal.deliveries) {
      if (target && (item.projectId !== target.projectId || item.postId !== target.postId)) continue;
      for (const part of item.receipts)
        if (part.status === 'sending') {
          part.status = 'uncertain';
          changed = true;
        }
    }
    if (changed) this.commit(journal);
  }

  review(projectId: string, postId: string, body: unknown): void {
    const parsed = z
      .discriminatedUnion('action', [
        z.strictObject({
          action: z.literal('confirm'),
          revision: hash,
          index: stamp.max(99),
          remoteId: z.string().trim().min(1).max(500).regex(/^\S+$/),
          acknowledgeChecked: z.literal(true),
        }),
        z.strictObject({
          action: z.literal('retry'),
          revision: hash,
          index: stamp.max(99),
          acknowledgeRemaining: z.literal(true),
          acknowledgePossibleDuplicate: z.boolean().optional(),
        }),
      ])
      .safeParse(body);
    const instance = getGatewayInstance(this.state.instanceId);
    if (instance.enabled)
      throw Object.assign(new Error('Pause this gateway before reviewing an Outbox delivery.'), { status: 400 });
    const journal: GatewayOutboxJournal = { version: 1, deliveries: this.list() };
    const item = journal.deliveries.find((entry) => entry.projectId === projectId && entry.postId === postId);
    if (!item) throw Object.assign(new Error('No such saved Outbox delivery.'), { status: 404 });
    const preview = gatewayOutboxDeliveryReview(instance, item);
    if (!parsed.success || parsed.data.revision !== preview.revision || preview.reason)
      throw Object.assign(new Error(preview.reason || 'The delivery receipts changed. Reload and review them again.'), {
        status: 409,
      });
    const value = parsed.data;
    const part = item.receipts[value.index];
    const at = Date.now();
    if (value.action === 'confirm') {
      if (
        !preview.parts[value.index]?.canConfirm ||
        item.receipts.some((other, index) => index !== value.index && other.remoteId === value.remoteId)
      )
        throw Object.assign(
          new Error('Only an attempted uncertain part with its own messaging app ID can be confirmed.'),
          { status: 409 },
        );
      item.reviews = [
        ...(item.reviews ?? []),
        {
          action: 'confirmed',
          at,
          revision: value.revision,
          index: value.index,
          attempt: part.attempts,
          remoteId: value.remoteId,
        },
      ];
      part.status = 'sent';
      part.remoteId = value.remoteId;
      delete part.retryAt;
      if (item.receipts.some((receipt) => receipt.status !== 'sent')) item.reviewHeld = true;
      else delete item.reviewHeld;
    } else {
      if (
        !preview.canRetry ||
        preview.nextIndex !== value.index ||
        (part.attempts > 0 && value.acknowledgePossibleDuplicate !== true)
      )
        throw Object.assign(
          new Error(
            preview.retryReason ||
              'Review the first remaining part and acknowledge possible duplicate delivery before retrying.',
          ),
          { status: 409 },
        );
      let context: ReturnType<GatewayOutboxLedger['context']>;
      try {
        context = this.context(projectId, item.eventId, true);
      } catch {
        throw Object.assign(
          new Error(
            'The original gateway setup, access or source changed. Keep this delivery local and review a new draft.',
          ),
          { status: 409 },
        );
      }
      if (
        context.configHash !== item.configHash ||
        context.sourceHash !== item.sourceHash ||
        context.event.bindingId !== item.bindingId
      )
        throw Object.assign(
          new Error('The original gateway setup or source changed. Keep this delivery local and review a new draft.'),
          { status: 409 },
        );
      const from = part.status;
      if (from !== 'pending' && from !== 'failed' && from !== 'uncertain')
        throw new Error('The selected part cannot be retried.');
      item.reviews = [
        ...(item.reviews ?? []),
        { action: 'retry', at, revision: value.revision, index: value.index, attempt: part.attempts, from },
      ];
      part.status = 'pending';
      delete part.retryAt;
      delete item.reviewHeld;
    }
    this.commit(journal);
  }

  finishLocal(projectId: string, postId: string, body: unknown): void {
    const parsed = z.strictObject({ revision: hash, acknowledgeNoSend: z.literal(true) }).safeParse(body);
    const instance = getGatewayInstance(this.state.instanceId);
    if (instance.enabled)
      throw Object.assign(new Error('Pause this gateway before finishing an Outbox delivery locally.'), {
        status: 400,
      });
    const journal: GatewayOutboxJournal = { version: 1, deliveries: this.list() };
    const item = journal.deliveries.find((entry) => entry.projectId === projectId && entry.postId === postId);
    if (
      !parsed.success ||
      !item ||
      !unfinished(item) ||
      item.receipts.some((part) => part.status === 'sending') ||
      parsed.data.revision !== gatewayOutboxReviewRevision(item)
    ) {
      throw Object.assign(new Error('The Outbox receipts changed. Reload them before finishing delivery locally.'), {
        status: 409,
      });
    }
    item.closed = { at: Date.now(), revision: parsed.data.revision };
    this.commit(journal);
  }

  claim(): GatewayOutboxClaim | null {
    const journal: GatewayOutboxJournal = { version: 1, deliveries: this.list() };
    if (
      journal.deliveries.some((item) => item.receipts.some((part) => part.status === 'sending')) ||
      !getGatewayInstance(this.state.instanceId).enabled
    )
      return null;
    const blocked = new Set<string>();
    for (const item of journal.deliveries) {
      if (!unfinished(item) || blocked.has(item.bindingId)) continue;
      blocked.add(item.bindingId);
      const index = item.receipts.findIndex((part) => part.status !== 'sent');
      const part = item.receipts[index];
      if (item.held || item.reviewHeld || part.status !== 'pending' || (part.retryAt ?? 0) > Date.now()) continue;
      let event: GatewayInboxEvent;
      try {
        const context = this.context(item.projectId, item.eventId);
        if (
          item.configHash !== context.configHash ||
          item.sourceHash !== context.sourceHash ||
          item.bindingId !== context.event.bindingId
        )
          throw new Error('Changed');
        event = context.event;
      } catch {
        item.held = 'destination-changed';
        this.commit(journal);
        continue;
      }
      if (part.attempts === Number.MAX_SAFE_INTEGER) throw new Error('The gateway Outbox attempt limit was reached.');
      part.status = 'sending';
      part.attempts++;
      delete part.retryAt;
      this.commit(journal);
      return { projectId: item.projectId, postId: item.postId, index, attempt: part.attempts, event, text: part.text };
    }
    return null;
  }

  settle(claim: GatewayOutboxClaim, outcome: GatewayDeliveryOutcome): void {
    const journal: GatewayOutboxJournal = { version: 1, deliveries: this.list() };
    const item = journal.deliveries.find(
      (entry) => entry.projectId === claim.projectId && entry.postId === claim.postId,
    );
    const part = item?.receipts[claim.index];
    if (
      !item ||
      item.eventId !== claim.event.id ||
      !part ||
      part.status !== 'sending' ||
      part.attempts !== claim.attempt ||
      part.text !== claim.text
    ) {
      throw new Error('This Outbox send no longer owns the pending receipt. Reload its delivery results.');
    }
    if ('remoteId' in outcome) {
      part.status = 'sent';
      part.remoteId = outcome.remoteId;
    } else {
      part.status = outcome.status;
      if (outcome.status === 'pending' && outcome.retryAt !== undefined) part.retryAt = outcome.retryAt;
    }
    this.commit(journal);
  }

  /** Checked again by the transport after asynchronous preflight and immediately before POST. */
  authorize(claim: GatewayOutboxClaim, event: GatewayInboxEvent, text: string): string {
    const item = this.list().find((entry) => entry.projectId === claim.projectId && entry.postId === claim.postId);
    const part = item?.receipts[claim.index];
    if (
      !item ||
      item.held ||
      item.reviewHeld ||
      item.closed ||
      item.eventId !== claim.event.id ||
      !part ||
      part.status !== 'sending' ||
      part.attempts !== claim.attempt ||
      part.text !== claim.text ||
      text !== part.text ||
      event.id !== item.eventId
    )
      throw new Error('This approved Outbox send is no longer current.');
    const context = this.context(item.projectId, item.eventId);
    if (
      item.configHash !== context.configHash ||
      item.sourceHash !== context.sourceHash ||
      item.bindingId !== context.event.bindingId ||
      JSON.stringify(event.input) !== JSON.stringify(context.event.input) ||
      JSON.stringify(event.route) !== JSON.stringify(context.event.route)
    ) {
      throw new Error('The approved Outbox destination changed before delivery.');
    }
    return digest([
      this.state.instanceId,
      item.projectId,
      item.postId,
      item.eventId,
      'outbox',
      claim.index,
      claim.attempt,
    ]).slice(0, 24);
  }
}
