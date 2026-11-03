import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { z } from 'zod';
import type { GatewayWhatsAppRecovery, GatewayWhatsAppRelayStatus } from '../../shared/types.ts';
import { whatsAppRelayStatusSchema } from '../../shared/gateway-whatsapp-relay.ts';
import { getGatewaySecrets } from '../store.ts';
import { getGatewayInstance } from './instances.ts';
import { gatewayWhatsAppRecovery } from './inbox.ts';
import type { GatewayInbox } from './inbox.ts';

type Request = (url: string, init: RequestInit) => Promise<Response>;
interface Options { request?: Request; timeoutMs?: number }
const fail = (message: string, status = 409): never => { throw Object.assign(new Error(message), { status }); };
function saved<T>(action: () => T): T {
  try { return action(); }
  catch (error) {
    if (error instanceof Error && 'status' in error) throw error;
    return fail('The recovery check could not be saved. Check local storage and the saved receipts before retrying.', 503);
  }
}

async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); signal.throwIfAborted(); }
  let cancel: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(new Error('Relay check timed out')); signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([promise, aborted]); } finally { signal.removeEventListener('abort', cancel); }
}

export async function readWhatsAppRelayStatus(inbox: GatewayInbox, options: Options = {}): Promise<GatewayWhatsAppRelayStatus> {
  const instance = getGatewayInstance(inbox.instanceId); const secrets = getGatewaySecrets(instance.id); const connection = inbox.whatsAppRelayState()?.connection;
  if (instance.enabled || instance.platform !== 'whatsapp' || !connection || connection.phoneNumberId !== instance.accountId || secrets.whatsappPairing !== undefined || !/^[a-f0-9]{64}$/.test(secrets.relayKey ?? '')) return fail('Pause a fully paired WhatsApp instance before checking recovery.', 400);
  const signal = AbortSignal.timeout(options.timeoutMs ?? 10000); const url = `${connection.origin}/v1/status`;
  let response: Response | undefined; let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    response = await bounded((options.request ?? fetch)(url, { headers: { authorization: `Bearer ${secrets.relayKey}` }, method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal }), signal);
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url) || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('Relay check refused');
    const length = response.headers.get('content-length'); if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) throw new Error('Relay check too large');
    reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
    for (;;) { const part = await bounded(reader.read(), signal); if (part.done) break; size += part.value.byteLength; if (size > 65536) throw new Error('Relay check too large'); chunks.push(Buffer.from(part.value)); }
    const bytes = Buffer.concat(chunks); const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) throw new Error('Relay check encoding');
    return whatsAppRelayStatusSchema.parse(JSON.parse(text) as unknown);
  } catch { return fail('The paired relay status could not be verified. Check its connection and pull key; no gap was cleared.', 503); }
  finally { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } else void response?.body?.cancel().catch(() => {}); }
}

/** These checks use only the saved origin and pull key; never claim, ACK or administer the relay. */
export async function inspectWhatsAppRecovery(inbox: GatewayInbox, options: Options = {}): Promise<GatewayWhatsAppRecovery> {
  const remote = await readWhatsAppRelayStatus(inbox, options);
  if (getGatewayInstance(inbox.instanceId).enabled) return fail('Pause this WhatsApp instance before reviewing its relay.', 400);
  return saved(() => { inbox.recover(); return inbox.observeWhatsAppGap(remote); });
}
export async function reviewWhatsAppRecovery(inbox: GatewayInbox, body: unknown, options: Options = {}): Promise<GatewayWhatsAppRecovery> {
  const parsed = z.strictObject({ revision: z.string().regex(/^[a-f0-9]{64}$/), acknowledgeGap: z.literal(true) }).safeParse(body);
  if (!parsed.success || parsed.data.revision !== gatewayWhatsAppRecovery(inbox.instanceId).gap?.revision) return fail('This gap or its saved work changed. Reload and acknowledge the current gap.');
  const remote = await readWhatsAppRelayStatus(inbox, options);
  return saved(() => inbox.reviewWhatsAppGap(remote, body));
}

/** Restore the original binding only; never accept a new installation, epoch or receipt prefix. */
export async function restoreWhatsAppRecovery(inbox: GatewayInbox, body: unknown, options: Options = {}): Promise<GatewayWhatsAppRecovery> {
  const parsed = z.strictObject({ revision: z.string().regex(/^[a-f0-9]{64}$/), acknowledgeRestore: z.literal(true) }).safeParse(body);
  if (!parsed.success || parsed.data.revision !== gatewayWhatsAppRecovery(inbox.instanceId).restoration?.revision) return fail('This connection hold changed. Reload and acknowledge its current restoration.');
  const snapshot = JSON.stringify([getGatewayInstance(inbox.instanceId), getGatewaySecrets(inbox.instanceId), inbox.whatsAppRelayState()]);
  const remote = await readWhatsAppRelayStatus(inbox, options);
  if (snapshot !== JSON.stringify([getGatewayInstance(inbox.instanceId), getGatewaySecrets(inbox.instanceId), inbox.whatsAppRelayState()])) return fail('The saved setup changed during the restoration check. Reload and review it again.');
  return saved(() => inbox.restoreWhatsAppRelay(remote, body));
}
