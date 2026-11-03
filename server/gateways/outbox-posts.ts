import crypto from 'node:crypto';
import { z } from 'zod';
import type { GatewayOutboxApproval, GatewayOutboxDelivery, GatewayOutboxPostPreview, GatewayOutboxProgress, OutboxPost } from '../../shared/types.ts';
import { activeProject, outbox } from '../store.ts';
import { approveGatewayOutbox, prepareGatewayOutbox } from './outbox-owner.ts';
import { gatewayOutboxReviewRevision, readGatewayOutboxDeliveries } from './outbox.ts';
import { getGatewayInstance } from './instances.ts';

const destination = z.strictObject({ instanceId: z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/), eventId: z.string().regex(/^[a-f0-9]{64}$/) });
const partsSchema = z.array(z.string().min(1).max(100000)).min(1).max(100);
export const gatewayPost = (item: Pick<OutboxPost, 'platform'>): boolean => item.platform === 'telegram' || item.platform === 'discord';
export const gatewayDraftRevision = (item: OutboxPost): string => crypto.createHash('sha256').update(JSON.stringify([activeProject().id, item.id, item.platform, item.parts, item.gateway, item.updatedAt, item.status])).digest('hex');

export type GatewayOutboxReadCache = Map<string, GatewayOutboxDelivery[] | Error>;
function receipt(item: OutboxPost, cache?: GatewayOutboxReadCache) {
  const selected = destination.safeParse(item.gateway);
  if (!selected.success) { if (item.gateway || item.gatewayApprovedRevision) throw new Error('The saved gateway destination needs recovery.'); return undefined; }
  const id = selected.data.instanceId;
  let saved = cache?.get(id);
  if (!saved) { try { saved = readGatewayOutboxDeliveries(id); } catch { saved = new Error('The gateway delivery receipts could not load.'); } cache?.set(id, saved); }
  if (saved instanceof Error) throw saved;
  return saved.find((entry) => entry.projectId === activeProject().id && entry.postId === item.id);
}

export function assertGatewayDraftMutable(item: OutboxPost): void {
  if (!gatewayPost(item)) return;
  if (receipt(item) || item.gatewayApprovedRevision || item.status === 'posting') throw new Error('This Outbox delivery is already approved. Keep its receipts and create a new draft to change the text or recipient.');
}

export function gatewayTextParts(platform: string, parts: string[]): string[] {
  const parsed = partsSchema.safeParse(parts); if (!parsed.success) throw new Error('Add bounded text parts before reviewing the gateway message.');
  const result: string[] = []; const limit = platform === 'discord' ? 2000 : 3000;
  for (const part of parsed.data) for (let start = 0; start < part.length;) {
    let end = Math.min(start + limit, part.length); const last = part.charCodeAt(end - 1);
    if (end < part.length && last >= 0xd800 && last <= 0xdbff) end--;
    result.push(part.slice(start, end)); start = end;
  }
  return result;
}

export function checkGatewayDraft(item: OutboxPost, input: unknown, parts: string[]) {
  const parsed = destination.safeParse(input); if (!parsed.success) throw new Error('Choose a gateway instance and a known conversation in this project.');
  const value = prepareGatewayOutbox(parsed.data.instanceId, activeProject().id, item.id, parsed.data.eventId, parts);
  if (value.recipient.platform !== item.platform) throw new Error('Choose an instance on the draft’s messaging platform.');
  return { selected: parsed.data, preview: value };
}

export function prepareGatewayPost(id: string, body: unknown): GatewayOutboxPostPreview {
  const item = outbox.get(id); if (!item || !gatewayPost(item)) throw new Error('Choose a Telegram or Discord Outbox draft.');
  assertGatewayDraftMutable(item);
  const parsed = z.strictObject({ gateway: destination, parts: partsSchema, draftRevision: z.string() }).safeParse(body);
  if (!parsed.success || parsed.data.draftRevision !== gatewayDraftRevision(item) || !['pending', 'failed'].includes(item.status)) throw new Error('This draft changed. Reload it before reviewing the recipient and text.');
  const parts = gatewayTextParts(item.platform, parsed.data.parts); const checked = checkGatewayDraft(item, parsed.data.gateway, parts);
  const saved = outbox.save({ ...item, parts, gateway: checked.selected, accountLabel: checked.preview.recipient.instanceName });
  return { ...checked.preview, draftRevision: gatewayDraftRevision(saved) };
}

export function approveGatewayPost(item: OutboxPost, body: { gatewayApproval?: GatewayOutboxApproval; draftRevision?: string } | null): OutboxPost {
  const before = receipt(item);
  if (!before && (item.gatewayApprovedRevision || item.status === 'posting')) throw new Error('Approved delivery receipts are missing. Restore them before sending again.');
  const value = body?.gatewayApproval;
  if (!value || body?.draftRevision !== gatewayDraftRevision(item) || !item.gateway || value.instanceId !== item.gateway.instanceId || value.eventId !== item.gateway.eventId
    || value.projectId !== activeProject().id || value.postId !== item.id || JSON.stringify(value.parts) !== JSON.stringify(item.parts)) throw new Error('Review this saved gateway recipient and text before approving.');
  if (item.platform !== getGatewayInstance(value.instanceId).platform || !['pending', 'failed', 'posting'].includes(item.status)) throw new Error('This gateway draft cannot be approved.');
  // Approval is durable before the sender can wake. A failed public save still has private receipts.
  approveGatewayOutbox(value);
  const saved = outbox.save({ ...item, gatewayApprovedRevision: value.revision, status: 'posting', error: null });
  return projectGatewayPost(saved);
}

export function projectGatewayPost<T extends OutboxPost>(item: T, cache?: GatewayOutboxReadCache): T {
  if (!gatewayPost(item)) return item;
  const draftRevision = gatewayDraftRevision(item);
  try {
    const entry = receipt(item, cache);
    if (!entry) {
      if (item.gatewayApprovedRevision) throw new Error('Missing receipts');
      return { ...item, gatewayDraftRevision: draftRevision };
    }
    if (entry.eventId !== item.gateway?.eventId || entry.recipient.platform !== item.platform || JSON.stringify(entry.parts) !== JSON.stringify(item.parts)) throw new Error('Changed saved draft');
    const parts = entry.receipts.map(({ status, attempts, remoteId, retryAt }) => ({ status, attempts, ...(remoteId ? { remoteId } : {}), ...(retryAt !== undefined ? { retryAt } : {}) }));
    const first = parts.find((part) => part.status !== 'sent');
    let paused = false; let removed = false; try { paused = !getGatewayInstance(entry.instanceId).enabled; } catch { removed = true; }
    const state: GatewayOutboxProgress['state'] = entry.closed ? 'closed' : !first ? 'sent' : entry.held || removed ? 'held' : first.status === 'pending' ? 'queued' : first.status;
    const progress: GatewayOutboxProgress = { state, recipient: entry.recipient, parts, approvedAt: entry.approvedAt, paused,
      ...(!entry.closed && first && !removed ? { reviewRevision: gatewayOutboxReviewRevision(entry) } : {}), ...(entry.closed ? { closedAt: entry.closed.at } : {}) };
    const error = removed && first && !entry.closed ? 'This gateway instance was removed. Its delivery receipts are kept for recovery; no further sends will run.'
      : state === 'uncertain' ? 'Delivery is uncertain. Check the messaging app before deciding whether to send a new draft.'
      : state === 'held' ? 'The source, access or gateway setup changed. This approved delivery is held.'
      : state === 'failed' ? 'Delivery failed. Confirmed parts are kept; the remaining text will not retry automatically.' : null;
    return { ...item, gatewayDraftRevision: draftRevision, gatewayProgress: progress, accountLabel: entry.recipient.instanceName,
      postIds: parts.flatMap((part) => part.remoteId ? [part.remoteId] : []), error,
      status: state === 'sent' ? 'posted' : state === 'closed' ? 'rejected' : error ? 'failed' : 'posting' };
  } catch {
    return { ...item, gatewayDraftRevision: draftRevision, status: 'failed', error: 'Gateway delivery receipts are unavailable. Restore them before making changes or sending again.',
      gatewayProgress: { state: 'unavailable', parts: [], paused: false } };
  }
}
