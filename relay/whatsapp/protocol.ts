import { z } from 'zod';
import type { GatewayWhatsAppRelayLimits, GatewayWhatsAppRelayState } from '../../shared/types.ts';

const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const externalId = z.string().regex(/^[1-9]\d{0,29}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const stateSchema: z.ZodType<GatewayWhatsAppRelayState> = z.strictObject({
  version: z.literal(1), installationId: z.uuid(), businessAccountId: externalId, phoneNumberId: externalId, epoch: z.uuid(),
  nextSequence: stamp.positive(), cursor: stamp, lastAckId: hash.nullable(), lastReceivedAt: stamp,
  lostThrough: stamp, gapAt: stamp.nullable(), tokenHash: hash.nullable(), pairingHash: hash.nullable(), pairingExpiresAt: stamp,
  leaseHash: hash.nullable(), leaseConsumer: z.uuid().nullable(), leaseExpiresAt: stamp, deliveredThrough: stamp,
}).refine((value) => value.cursor < value.nextSequence && value.lostThrough < value.nextSequence && value.deliveredThrough < value.nextSequence && value.deliveredThrough >= value.cursor
  && (value.leaseHash === null) === (value.leaseConsumer === null));

export interface RelayEnv {
  QUEUE: DurableObjectNamespace;
  BUSINESS_ACCOUNT_ID: string;
  PHONE_NUMBER_ID: string;
  META_APP_SECRET: string;
  META_VERIFY_TOKEN: string;
  RELAY_ADMIN_KEY: string;
  RETENTION_SECONDS?: string;
  MAX_EVENTS?: string;
  MAX_BYTES?: string;
  MAX_REPLAY_IDS?: string;
}
export function configuration(env: RelayEnv): GatewayWhatsAppRelayLimits {
  const integer = (raw: string | undefined, fallback: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).parse(raw ?? fallback);
  externalId.parse(env.BUSINESS_ACCOUNT_ID); externalId.parse(env.PHONE_NUMBER_ID);
  z.string().min(16).max(512).parse(env.META_APP_SECRET); z.string().min(16).max(512).parse(env.META_VERIFY_TOKEN); z.string().min(32).max(512).parse(env.RELAY_ADMIN_KEY);
  return { bodyBytes: 1024 * 1024, queueEvents: integer(env.MAX_EVENTS, 1000, 1, 10000), queueBytes: integer(env.MAX_BYTES, 16 * 1024 * 1024, 1024, 64 * 1024 * 1024),
    replayEntries: integer(env.MAX_REPLAY_IDS, 10000, 1, 100000), retentionMs: integer(env.RETENTION_SECONDS, 259200, 60, 604800) * 1000,
    replayMs: 7 * 86400000, pairingMs: 600000, leaseMs: 60000, batchBytes: 2 * 1024 * 1024, batchEvents: 20 };
}

export class RelayError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super('The relay request could not be completed.'); this.status = status; this.code = code; }
}
export const fail = (status: number, code: string): never => { throw new RelayError(status, code); };
export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
export function errorResponse(error: unknown): Response {
  const result = error instanceof RelayError ? error : new RelayError(503, 'relay_unavailable');
  return json({ error: result.code }, result.status);
}
export async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > limit)) return fail(413, 'body_limit');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new RelayError(408, 'body_timeout')), 10000); });
  try {
    for (;;) { const part = await Promise.race([reader.read(), deadline]); if (part.done) break; total += part.value.byteLength;
      if (total > limit) return fail(413, 'body_limit'); chunks.push(part.value);
    }
    const result = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally { if (timer !== undefined) clearTimeout(timer); try { await reader.cancel(); } finally { reader.releaseLock(); } }
}
export function parseJSON(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown; } catch { return fail(400, 'invalid_json'); }
}
export async function digest(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}
export const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
export const randomKey = () => hex(crypto.getRandomValues(new Uint8Array(32)));
export function constantEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0; for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}
export async function verifyMeta(body: Uint8Array, signature: string, secret: string): Promise<boolean> {
  if (!/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.slice(7).match(/../g)!, (part) => parseInt(part, 16));
  return crypto.subtle.verify('HMAC', key, bytes, body);
}
export function base64(bytes: Uint8Array): string {
  let result = ''; for (let offset = 0; offset < bytes.length; offset += 8192) result += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(result);
}

/** A whole signed body belongs to one business phone; never disclose another phone's batch. */
export function checkAccount(body: Uint8Array, env: RelayEnv): void {
  const webhook = z.object({ object: z.literal('whatsapp_business_account'), entry: z.array(z.object({ id: externalId, changes: z.array(z.object({ field: z.enum(['messages', 'user_id_update']),
    value: z.object({ messaging_product: z.literal('whatsapp'), metadata: z.object({ phone_number_id: externalId }) }),
  })).min(1).max(100) })).min(1).max(100) }).safeParse(parseJSON(body));
  if (!webhook.success) return fail(400, 'unsupported_webhook');
  if (webhook.data.entry.some((entry) => entry.id !== env.BUSINESS_ACCOUNT_ID || entry.changes.some((change) => change.value.metadata.phone_number_id !== env.PHONE_NUMBER_ID))) return fail(503, 'account_mismatch');
}
