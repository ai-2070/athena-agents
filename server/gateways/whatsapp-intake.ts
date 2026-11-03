import crypto from 'node:crypto';
import { z } from 'zod';
import type { GatewayInbound, GatewayWhatsAppIdentities, GatewayWhatsAppIntakeState, GatewayWhatsAppReceipt } from '../../shared/types.ts';
import { whatsAppSenderPhone } from '../../shared/gateway-whatsapp.ts';
import { getGatewayInstance } from './instances.ts';
import type { GatewayInbox } from './inbox.ts';
import { WhatsAppIdentities } from './whatsapp-identities.ts';
import { whatsAppRelayEnvelopeSchema } from '../../shared/gateway-whatsapp-relay.ts';

const id = z.string().min(1).max(500);
const accountId = z.string().regex(/^[1-9]\d{0,29}$/);
const media = z.object({ id, mime_type: z.string().max(200), caption: z.string().max(65536).optional(), filename: z.string().max(512).optional() });
const optionalIdentity = z.string().max(500).optional();
const timestamp = z.string().regex(/^[1-9]\d{0,12}$/);
const message = z.object({
  id, type: z.string().min(1).max(100), timestamp,
  from: optionalIdentity, from_user_id: optionalIdentity, from_parent_user_id: optionalIdentity,
  text: z.object({ body: z.string().max(65536) }).optional(),
  image: media.optional(), document: media.optional(), audio: media.optional(), voice: media.optional(), video: media.optional(),
  system: z.object({ type: z.enum(['user_changed_number', 'user_changed_user_id']), user_id: id, wa_id: optionalIdentity, parent_user_id: optionalIdentity }).optional(),
});
const identityPair = z.object({ current: optionalIdentity, previous: optionalIdentity });
// Extra provider fields are discarded, never copied into the inbox or treated as identity proof.
const webhook = z.object({ object: z.literal('whatsapp_business_account'), entry: z.array(z.object({
  id: accountId, changes: z.array(z.object({ field: z.enum(['messages', 'user_id_update']), value: z.object({
    messaging_product: z.literal('whatsapp'), metadata: z.object({ phone_number_id: accountId }),
    contacts: z.array(z.object({ wa_id: optionalIdentity, user_id: optionalIdentity, parent_user_id: optionalIdentity, profile: z.object({ name: z.string().max(200) }) })).max(1000).optional(),
    messages: z.array(message).max(1000).optional(),
    user_id_update: z.array(z.object({ timestamp: timestamp.optional(), user_id: identityPair.optional(), parent_user_id: identityPair.optional(), wa_id: optionalIdentity })).max(1000).optional(),
  }) })).min(1).max(100),
})).min(1).max(100) });

export class WhatsAppIntakeError extends Error {
  constructor() { super('The WhatsApp relay message could not be verified. Check setup before reconnecting.'); }
}

type Receipt = NonNullable<GatewayWhatsAppIntakeState['receipt']>;
/** The relay client must authenticate the ACK response; a timeout leaves the local receipt gated. */
export type WhatsAppAcknowledge = (receipt: GatewayWhatsAppReceipt) => Promise<{ epoch: string; cursor: number }>;

/** Local trust boundary, separate from the SDK's public webhook and identity alias caches. */
export class WhatsAppRelayIntake {
  private readonly instanceId: string;
  private readonly businessAccountId: string;
  private readonly appSecret: string;
  private readonly inbox: GatewayInbox;
  private busy = false;

  constructor(instanceId: string, inbox: GatewayInbox, businessAccountId: string, appSecret: string) {
    const instance = getGatewayInstance(instanceId);
    const savedBusiness = inbox.whatsAppRelayState()?.identities?.businessAccountId;
    if (instance.platform !== 'whatsapp' || inbox.instanceId !== instanceId || (savedBusiness !== undefined && savedBusiness !== businessAccountId) || !accountId.safeParse(instance.accountId).success
      || !accountId.safeParse(businessAccountId).success || appSecret.length < 16 || appSecret.length > 512) throw new WhatsAppIntakeError();
    this.instanceId = instanceId; this.inbox = inbox; this.businessAccountId = businessAccountId; this.appSecret = appSecret;
  }

  async receive(epoch: string, value: unknown, acknowledge: WhatsAppAcknowledge): Promise<Receipt> {
    if (this.busy) throw new Error('Finish the saved WhatsApp batch before receiving another.');
    this.busy = true;
    try { return await this.accept(epoch, value, acknowledge); }
    finally { this.busy = false; }
  }

  private async accept(epoch: string, value: unknown, acknowledge: WhatsAppAcknowledge): Promise<Receipt> {
    const normalized = this.verify(value);
    if (!z.uuid().safeParse(epoch).success) throw new WhatsAppIntakeError();
    const proof = { epoch, sequence: normalized.sequence, id: normalized.id };
    const receipt = this.inbox.acceptWhatsAppRelay(proof, normalized.inputs, normalized.ignored, normalized.unmatchedSenders, normalized.identities);
    if (receipt.confirmed) return receipt;
    await this.confirm(proof, acknowledge);
    return this.inbox.whatsAppRelayState()!.receipt!;
  }

  /** Retry the saved ACK after a restart, including when the remote ACK succeeded but its reply was lost. */
  async confirmPending(acknowledge: WhatsAppAcknowledge): Promise<void> {
    if (this.busy) throw new Error('Finish the saved WhatsApp batch before confirming another.');
    this.busy = true;
    try {
      const receipt = this.inbox.whatsAppRelayState()?.receipt;
      if (!receipt || receipt.confirmed) return;
      const { epoch, sequence, id } = receipt;
      await this.confirm({ epoch, sequence, id }, acknowledge);
    } finally { this.busy = false; }
  }

  private async confirm(proof: GatewayWhatsAppReceipt, acknowledge: WhatsAppAcknowledge): Promise<void> {
    const response = await acknowledge(proof);
    if (!response || response.epoch !== proof.epoch || response.cursor !== proof.sequence) throw new Error('The relay acknowledgement does not match the saved receipt.');
    this.inbox.confirmWhatsAppRelay(proof);
  }

  private verify(value: unknown): { sequence: number; id: string; inputs: GatewayInbound[]; ignored: number; unmatchedSenders: number; identities: GatewayWhatsAppIdentities } {
    try {
      const envelope = whatsAppRelayEnvelopeSchema.parse(value); const body = Buffer.from(envelope.bodyBase64, 'base64');
      if (body.length > 1024 * 1024 || body.toString('base64') !== envelope.bodyBase64 || envelope.expiresAt <= envelope.receivedAt
        || crypto.createHash('sha256').update(envelope.bodyBase64).digest('hex') !== envelope.id) throw new WhatsAppIntakeError();
      const signature = Buffer.from(envelope.signature.slice(7), 'hex');
      const expected = crypto.createHmac('sha256', this.appSecret).update(body).digest();
      if (!crypto.timingSafeEqual(signature, expected)) throw new WhatsAppIntakeError();
      // Reject invalid UTF-8 instead of silently changing the original signed input.
      const text = body.toString('utf8'); if (!Buffer.from(text).equals(body)) throw new WhatsAppIntakeError();
      const payload = webhook.parse(JSON.parse(text) as unknown); const instance = getGatewayInstance(this.instanceId);
      if (payload.entry.some((entry) => entry.id !== this.businessAccountId || entry.changes.some((change) => change.value.metadata.phone_number_id !== instance.accountId))) throw new WhatsAppIntakeError();
      const identities = new WhatsAppIdentities(this.businessAccountId, this.inbox.whatsAppRelayState()?.identities);
      const inputs: GatewayInbound[] = []; let ignored = 0; let unmatchedSenders = 0; let count = 0;
      const sentAt = (value: string | undefined): number => {
        const at = Number(value) * 1000;
        if (!Number.isSafeInteger(at) || at <= 0 || at > Date.now() + 300000) throw new WhatsAppIntakeError();
        return at;
      };
      for (const entry of payload.entry) for (const change of entry.changes) {
        if (change.field === 'user_id_update') {
          if (!change.value.user_id_update?.length || change.value.messages?.length) throw new WhatsAppIntakeError();
          for (const update of change.value.user_id_update) {
            if (++count > 1000) throw new WhatsAppIntakeError();
            identities.rotate(update.user_id?.previous || undefined, update.user_id?.current || undefined, whatsAppSenderPhone(update.wa_id), sentAt(update.timestamp), {
              previousParent: update.parent_user_id?.previous || undefined, currentParent: update.parent_user_id?.current || undefined,
            });
            ignored++;
          }
          continue;
        }
        if (change.value.user_id_update?.length) throw new WhatsAppIntakeError();
        for (const raw of change.value.messages ?? []) {
          if (++count > 1000) throw new WhatsAppIntakeError();
          const at = sentAt(raw.timestamp);
          if (raw.type === 'system') {
            if (raw.system) identities.rotate(raw.from_user_id || undefined, raw.system.user_id, whatsAppSenderPhone(raw.system.wa_id), at, {
              oldPhone: whatsAppSenderPhone(raw.from), previousParent: raw.from_parent_user_id || undefined, currentParent: raw.system.parent_user_id || undefined,
            });
            ignored++; continue;
          }
          if (!['text', 'image', 'document', 'audio', 'voice', 'video'].includes(raw.type)) { ignored++; continue; }
          // Contacts can prove a phone only when tied to this exact sender. Never use the first contact.
          const contacts = change.value.contacts?.filter((item) => raw.from_user_id ? item.user_id === raw.from_user_id : raw.from && item.wa_id === raw.from) ?? [];
          const contact = contacts.length === 1 ? contacts[0] : undefined;
          const userId = raw.from_user_id || contact?.user_id || undefined;
          const directPhone = whatsAppSenderPhone(raw.from); const contactPhone = whatsAppSenderPhone(contact?.wa_id);
          const conflict = contacts.length > 1 || Boolean(directPhone && contactPhone && directPhone !== contactPhone)
            || Boolean(raw.from && !directPhone) || Boolean(raw.from_parent_user_id && contact?.parent_user_id && raw.from_parent_user_id !== contact.parent_user_id);
          if (conflict) identities.conflict(userId, at);
          const phone = conflict ? null : identities.resolve(userId, directPhone ?? contactPhone, at, raw.from_parent_user_id || contact?.parent_user_id || undefined);
          if (!phone) { ignored++; unmatchedSenders++; continue; }
          const input: GatewayInbound = {
            platform: 'whatsapp', accountId: instance.accountId, conversationId: phone, threadId: '',
            sourceEventId: envelope.id, sourceMessageId: raw.id, sentAt: at, ...(userId ? { whatsappUserId: userId } : {}), kind: 'message',
            actor: { id: phone, label: contact?.profile.name || phone, kind: 'user' },
            directMessage: true, triggered: false, text: '', media: [],
          };
          if (raw.type === 'text' && raw.text) input.text = raw.text.body;
          else {
            const attachment = raw.type === 'image' ? raw.image : raw.type === 'document' ? raw.document : raw.type === 'audio' ? raw.audio : raw.type === 'voice' ? raw.voice : raw.type === 'video' ? raw.video : undefined;
            if (!attachment) { ignored++; continue; }
            input.text = attachment.caption ?? '';
            input.media = [{ kind: raw.type === 'document' ? 'file' : raw.type === 'voice' ? 'audio' : raw.type as 'image' | 'audio' | 'video',
              fileId: attachment.id, mimeType: attachment.mime_type, ...(attachment.filename ? { name: attachment.filename } : {}) }];
          }
          inputs.push(input);
        }
      }
      return { sequence: envelope.sequence, id: envelope.id, inputs, ignored, unmatchedSenders, identities: identities.state };
    } catch { throw new WhatsAppIntakeError(); }
  }
}
