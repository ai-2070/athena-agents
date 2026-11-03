import { z } from 'zod';
import type { GatewayWhatsAppRelayConnection, GatewayWhatsAppRelayEnvelope, GatewayWhatsAppRelayLimits } from './types.ts';

export const relaySequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const account = z.string().regex(/^[1-9]\d{0,29}$/);
export function whatsAppRelayOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Choose the HTTPS address of the paired WhatsApp relay.'); }
  if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.href !== `${url.origin}/`) throw new Error('Choose the HTTPS address of the paired WhatsApp relay.');
  return url.origin;
}
export const whatsAppRelayConnectionSchema: z.ZodType<GatewayWhatsAppRelayConnection> = z.strictObject({
  origin: z.string().max(2048).refine((value) => { try { return whatsAppRelayOrigin(value) === value; } catch { return false; } }),
  installationId: z.uuid(), businessAccountId: account, phoneNumberId: account, epoch: z.uuid(),
});
export const whatsAppRelayEnvelopeSchema: z.ZodType<GatewayWhatsAppRelayEnvelope> = z.strictObject({
  sequence: relaySequence.positive(), id: z.string().regex(/^[a-f0-9]{64}$/), receivedAt: relaySequence, expiresAt: relaySequence,
  bodyBase64: z.string().min(4).max(1398104), signature: z.string().regex(/^sha256=[a-f0-9]{64}$/),
  contentType: z.string().max(200).regex(/^application\/json(?:\s*;\s*charset=utf-8)?$/i),
}).refine((value) => value.receivedAt < value.expiresAt);
export const whatsAppRelayLimitsSchema: z.ZodType<GatewayWhatsAppRelayLimits> = z.strictObject({
  bodyBytes: z.literal(1048576), queueBytes: relaySequence.min(1024).max(67108864), queueEvents: relaySequence.min(1).max(10000),
  replayEntries: relaySequence.min(1).max(100000), retentionMs: relaySequence.min(60000).max(604800000), replayMs: z.literal(604800000),
  pairingMs: z.literal(600000), leaseMs: z.literal(60000), batchBytes: z.literal(2097152), batchEvents: z.literal(20),
});
export const whatsAppRelayStatusSchema = z.strictObject({
  version: z.literal(1), installationId: z.uuid(), businessAccountId: account, phoneNumberId: account, epoch: z.uuid(), cursor: relaySequence,
  gap: z.strictObject({ at: relaySequence, through: relaySequence }).nullable(), limits: whatsAppRelayLimitsSchema,
  queuedEvents: relaySequence, queuedBytes: relaySequence,
});
