import crypto from 'node:crypto';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { z } from 'zod';
import type { GatewayWhatsAppCheck, GatewayWhatsAppPairing, GatewayWhatsAppSetup } from '../../shared/types.ts';
import { relaySequence, whatsAppRelayConnectionSchema, whatsAppRelayOrigin, whatsAppRelayStatusSchema } from '../../shared/gateway-whatsapp-relay.ts';
import { getGatewaySecrets, setGatewaySecrets } from '../store.ts';
import { checkGatewayDestination, getGatewayInstance } from './instances.ts';
import { checkWhatsAppAccount } from './whatsapp.ts';
import { readWhatsAppRelayStatus } from './whatsapp-recovery.ts';
import { savedWhatsAppRelayState, whatsAppReplacementRevision } from './inbox.ts';
import type { GatewayInbox } from './inbox.ts';

type PairRequest = (url: string, init: RequestInit) => Promise<Response>;
const key = z.string().regex(/^[a-f0-9]{64}$/);
const account = z.string().regex(/^[1-9]\d{0,29}$/);
const origin = z.string().max(2048).transform((value, ctx) => {
  try { return whatsAppRelayOrigin(value); } catch { ctx.addIssue({ code: 'custom', message: 'Choose the HTTPS address of the WhatsApp relay.' }); return z.NEVER; }
});
const receiptSchema: z.ZodType<GatewayWhatsAppPairing> = z.discriminatedUnion('phase', [
  z.strictObject({ phase: z.literal('requesting'), attemptId: z.uuid(), origin, businessAccountId: account, phoneNumberId: account, replacement: z.strictObject({ epoch: z.uuid(), revision: key }).optional() }),
  z.strictObject({ phase: z.literal('received'), attemptId: z.uuid(), connection: whatsAppRelayConnectionSchema, cursor: relaySequence, gap: z.boolean(), replacement: z.strictObject({ epoch: z.uuid(), revision: key }).optional() }),
]);
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
const revision = (value: GatewayWhatsAppPairing) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const reviewRevision = (instanceId: string, value: GatewayWhatsAppPairing) => value.replacement
  ? crypto.createHash('sha256').update(JSON.stringify([revision(value), whatsAppReplacementRevision(instanceId)])).digest('hex') : revision(value);

function instance(instanceId: string, paused = false) {
  const value = getGatewayInstance(instanceId);
  if (value.platform !== 'whatsapp' || (paused && value.enabled)) return fail('Pause this WhatsApp instance before changing its relay pairing.');
  return value;
}
function receipt(instanceId: string): GatewayWhatsAppPairing | undefined {
  const value = getGatewaySecrets(instanceId).whatsappPairing;
  if (value === undefined) return undefined;
  const parsed = receiptSchema.safeParse(value);
  if (!parsed.success) return fail('The saved WhatsApp pairing is unreadable. Restore it before continuing.', 503);
  return parsed.data;
}
function save(instanceId: string, value: ReturnType<typeof getGatewaySecrets>): void {
  try { setGatewaySecrets(instanceId, value); }
  catch { return fail('The WhatsApp pairing could not be saved. Check local storage before continuing.', 503); }
}

/** Presence and an opaque review revision only; no keys, account IDs or private origin. */
export function whatsAppSetup(instanceId: string): GatewayWhatsAppSetup {
  instance(instanceId); const pending = receipt(instanceId); const state = savedWhatsAppRelayState(instanceId);
  return { paired: Boolean(state?.connection), pending: pending ? { phase: pending.phase, revision: reviewRevision(instanceId, pending), ...(pending.replacement ? { replacement: true as const } : {}) } : null,
    recoveryRequired: Boolean(state?.recovery || pending?.phase === 'requesting') };
}

/** A current check, never an enable flag or stored permission to run or send. */
export async function checkWhatsAppSetup(inbox: GatewayInbox, options: { testOrigin?: string; request?: PairRequest; timeoutMs?: number } = {}): Promise<GatewayWhatsAppCheck> {
  const config = instance(inbox.instanceId, true); const setup = whatsAppSetup(config.id); const secrets = getGatewaySecrets(config.id);
  if (!setup.paired || setup.pending || !/^[a-f0-9]{64}$/.test(secrets.relayKey ?? '') || config.senderPolicy.platform !== 'whatsapp' || !config.senderPolicy.allowedPhones.length
    || !config.scope.directMessages || config.scope.conversationIds.length || config.scope.guildIds.length) return fail('Pair this paused instance, add allowed phone numbers and choose direct messages before checking setup.');
  checkGatewayDestination(config.id);
  const snapshot = JSON.stringify([config, secrets, inbox.whatsAppRelayState()]);
  const current = () => {
    if (snapshot !== JSON.stringify([instance(config.id, true), getGatewaySecrets(config.id), inbox.whatsAppRelayState()])) return fail('WhatsApp setup changed during the check. Reload and check it again.', 409);
  };
  try { await checkWhatsAppAccount(inbox, { testOrigin: options.testOrigin, timeoutMs: options.timeoutMs }); }
  catch (error) { return fail(error instanceof Error ? error.message : 'The WhatsApp account could not be checked.'); }
  current(); const remote = await readWhatsAppRelayStatus(inbox, { request: options.request, timeoutMs: options.timeoutMs }); current();
  const saved = inbox.whatsAppRelayState()!; const connection = saved.connection!;
  if (remote.installationId !== connection.installationId || remote.businessAccountId !== connection.businessAccountId || remote.phoneNumberId !== connection.phoneNumberId || remote.epoch !== connection.epoch
    || remote.queuedEvents > 10000 || remote.queuedBytes > 67108864 || (!remote.queuedEvents && remote.queuedBytes)) return fail('The relay no longer matches the saved pairing. Restore it before connecting.', 409);
  const pending = saved.receipt && !saved.receipt.confirmed;
  const reviewed = saved.gapReview && !remote.gap && remote.cursor === saved.gapReview.through;
  if (remote.cursor !== saved.cursor && !(pending && remote.cursor === saved.receipt!.sequence) && !reviewed) return fail('The relay cursor does not match the saved receipts. Review recovery before connecting.', 409);
  return { checkedAt: Date.now(), account: 'verified', relay: remote.gap || saved.recovery ? 'needs-review' : pending ? 'acknowledgement-pending' : 'ready' };
}

async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); signal.throwIfAborted(); }
  let cancel: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(new Error('Pairing timed out')); signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([promise, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}
async function exchange(origin: string, code: string, request: PairRequest, signal: AbortSignal): Promise<unknown> {
  const url = `${origin}/v1/pair`; const response = await bounded(request(url, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }), redirect: 'error', credentials: 'omit', cache: 'no-store', signal }), signal);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url) || !response.body
      || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Pairing not confirmed');
    const length = response.headers.get('content-length'); if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) throw new Error('Pairing too large');
    reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
    for (;;) { const part = await bounded(reader.read(), signal); if (part.done) break; size += part.value.byteLength; if (size > 65536) throw new Error('Pairing too large'); chunks.push(Buffer.from(part.value)); }
    const bytes = Buffer.concat(chunks); const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) throw new Error('Pairing encoding');
    return JSON.parse(text) as unknown;
  } finally { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } else void response.body?.cancel().catch(() => {}); }
}

/** The caller owns the paused instance and account. A one-use code is never retried. */
export async function pairWhatsApp(inbox: GatewayInbox, body: unknown, options: { request?: PairRequest; timeoutMs?: number } = {}): Promise<GatewayWhatsAppSetup> {
  const parsed = z.strictObject({ origin, businessAccountId: account, code: key, acknowledgeStart: z.literal(true) }).safeParse(body);
  if (!parsed.success) return fail('Choose the relay HTTPS address, business account and one-use pairing code, and acknowledge the new starting point.');
  const config = instance(inbox.instanceId, true); const secrets = getGatewaySecrets(config.id);
  if (!account.safeParse(config.accountId).success) return fail('Choose the numeric WhatsApp business phone ID before pairing.');
  if (receipt(config.id) || secrets.relayKey) return fail('Finish or review the saved WhatsApp pairing before starting another.', 409);
  try { inbox.assertNewWhatsAppPairing(); } catch { return fail('Use a paused WhatsApp instance with no saved pairing or conversations.', 409); }
  const pending: GatewayWhatsAppPairing = { phase: 'requesting', attemptId: crypto.randomUUID(), origin: parsed.data.origin, businessAccountId: parsed.data.businessAccountId, phoneNumberId: config.accountId };
  save(config.id, { ...secrets, whatsappPairing: pending });
  let value: unknown;
  try { value = await exchange(parsed.data.origin, parsed.data.code, options.request ?? fetch, AbortSignal.timeout(options.timeoutMs ?? 10000)); }
  catch { return fail('The pairing outcome is unknown. Do not reuse the code. Revoke the relay pairing before reviewing this attempt.', 409); }
  const result = whatsAppRelayStatusSchema.extend({ token: key }).safeParse(value);
  if (!result.success || result.data.phoneNumberId !== config.accountId || result.data.businessAccountId !== parsed.data.businessAccountId
    || result.data.queuedEvents > 10000 || result.data.queuedBytes > 67108864 || (!result.data.queuedEvents && result.data.queuedBytes)) return fail('The relay pairing response did not match this instance. Revoke it before reviewing this attempt.', 409);
  instance(config.id); const current = getGatewaySecrets(config.id);
  if (JSON.stringify(receipt(config.id)) !== JSON.stringify(pending)) return fail('The saved pairing attempt changed. Review it before continuing.', 409);
  const { installationId, businessAccountId, phoneNumberId, epoch, cursor, gap } = result.data;
  save(config.id, { ...current, relayKey: result.data.token, whatsappPairing: { phase: 'received', attemptId: pending.attemptId,
    connection: { origin: parsed.data.origin, installationId, businessAccountId, phoneNumberId, epoch }, cursor, gap: Boolean(gap) } });
  return finishWhatsAppPairing(inbox, { revision: whatsAppSetup(config.id).pending!.revision });
}

export function finishWhatsAppPairing(inbox: GatewayInbox, body: unknown): GatewayWhatsAppSetup {
  instance(inbox.instanceId, true); const parsed = z.strictObject({ revision: key, acknowledgeLoss: z.literal(true).optional() }).safeParse(body); const pending = receipt(inbox.instanceId);
  if (!parsed.success || pending?.phase !== 'received' || reviewRevision(inbox.instanceId, pending) !== parsed.data.revision || (pending.replacement && !parsed.data.acknowledgeLoss)
    || !key.safeParse(getGatewaySecrets(inbox.instanceId).relayKey).success) return fail('This saved pairing changed. Reload and review it again.', 409);
  try {
    if (pending.replacement) inbox.replaceWhatsAppRelay(pending.connection, pending.cursor, pending.gap, pending.attemptId, pending.replacement);
    else inbox.finishWhatsAppPairing(pending.connection, pending.cursor, pending.gap);
  }
  catch { return fail('The received pairing could not be bound. Keep it saved and check the paused instance and local storage.', 409); }
  const next = { ...getGatewaySecrets(inbox.instanceId) }; delete next.whatsappPairing; save(inbox.instanceId, next);
  return whatsAppSetup(inbox.instanceId);
}

/** Only an unknown exchange may be abandoned, after an explicit remote revocation acknowledgement. */
export function reviewWhatsAppPairing(inbox: GatewayInbox, body: unknown): GatewayWhatsAppSetup {
  instance(inbox.instanceId, true); const parsed = z.strictObject({ revision: key, acknowledgeRemoteRevoked: z.literal(true) }).safeParse(body); const pending = receipt(inbox.instanceId);
  if (!parsed.success || pending?.phase !== 'requesting' || reviewRevision(inbox.instanceId, pending) !== parsed.data.revision) return fail('Review the current unknown pairing and revoke it at the relay before continuing.', 409);
  try { if (pending.replacement) inbox.assertWhatsAppReplacement(pending.replacement.epoch); else inbox.assertNewWhatsAppPairing(); } catch { return fail('The local pairing changed. Restore it before reviewing this attempt.', 409); }
  const next = { ...getGatewaySecrets(inbox.instanceId) }; delete next.whatsappPairing; delete next.relayKey; save(inbox.instanceId, next);
  return whatsAppSetup(inbox.instanceId);
}

/** Two local stages preserve the new key across crashes without accepting changed work silently. */
export async function replaceWhatsAppPairing(inbox: GatewayInbox, body: unknown, options: { request?: PairRequest; timeoutMs?: number } = {}): Promise<GatewayWhatsAppSetup> {
  const parsed = z.strictObject({ revision: key, origin, businessAccountId: account, code: key, acknowledgePreviousStopped: z.literal(true), acknowledgeLoss: z.literal(true) }).safeParse(body);
  if (!parsed.success) return fail('Review the stopped old relay, message loss and current saved work before choosing a replacement pairing code.');
  const config = instance(inbox.instanceId, true); const secrets = getGatewaySecrets(config.id); const saved = inbox.whatsAppRelayState();
  if (receipt(config.id) || !saved?.connection || parsed.data.revision !== whatsAppReplacementRevision(config.id)) return fail('This pairing or saved work changed. Reload before replacing the relay.', 409);
  if (parsed.data.businessAccountId !== saved.connection.businessAccountId) return fail('The replacement must use the same business account and phone.');
  try { inbox.assertWhatsAppReplacement(saved.epoch); } catch { return fail('This paused relay cannot be replaced. Check its saved binding and history.', 409); }
  const pending: GatewayWhatsAppPairing = { phase: 'requesting', attemptId: crypto.randomUUID(), origin: parsed.data.origin, businessAccountId: parsed.data.businessAccountId,
    phoneNumberId: config.accountId, replacement: { epoch: saved.epoch, revision: parsed.data.revision } };
  save(config.id, { ...secrets, whatsappPairing: pending });
  let value: unknown;
  try { value = await exchange(parsed.data.origin, parsed.data.code, options.request ?? fetch, AbortSignal.timeout(options.timeoutMs ?? 10000)); }
  catch { return fail('The replacement pairing outcome is unknown. Do not reuse the code. Revoke the new relay pairing before reviewing this attempt.', 409); }
  const result = whatsAppRelayStatusSchema.extend({ token: key }).safeParse(value);
  if (!result.success || result.data.phoneNumberId !== config.accountId || result.data.businessAccountId !== parsed.data.businessAccountId
    || result.data.queuedEvents > 10000 || result.data.queuedBytes > 67108864 || (!result.data.queuedEvents && result.data.queuedBytes)) return fail('The replacement response did not match. Revoke the new pairing before reviewing this attempt.', 409);
  const { installationId, businessAccountId, phoneNumberId, epoch, cursor, gap } = result.data;
  const connection = { origin: parsed.data.origin, installationId, businessAccountId, phoneNumberId, epoch };
  try { inbox.assertWhatsAppReplacement(saved.epoch, connection); } catch { return fail('The replacement epoch is not new or its binding changed. Revoke the new pairing before reviewing this attempt.', 409); }
  if (JSON.stringify(receipt(config.id)) !== JSON.stringify(pending)) return fail('The replacement attempt changed. Review it before continuing.', 409);
  save(config.id, { ...getGatewaySecrets(config.id), relayKey: result.data.token, whatsappPairing: { phase: 'received', attemptId: pending.attemptId, connection, cursor, gap: Boolean(gap), replacement: pending.replacement } });
  return whatsAppSetup(config.id);
}
