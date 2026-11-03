import { TelegramAdapter } from '@chat-adapter/telegram';
import type { TelegramUpdate } from '@chat-adapter/telegram';
import type { ChatInstance, Logger } from 'chat';
import { z } from 'zod';
import type { GatewayInbound, GatewayInboxEvent, GatewayOutgoingFile } from '../../shared/types.ts';
import { verifyGatewayDocument } from './outgoing.ts';
import { getGatewayInstance } from './instances.ts';
import { gatewayInputAllowed, GatewayFileLimitError } from './inbox.ts';
import type { GatewayInbox } from './inbox.ts';
import { GatewaySendError } from './replies.ts';
import type { GatewayApprovedTextSend } from './replies.ts';
import { withGatewayRoute } from './instances.ts';
import { requireTelegramSetupReviewed } from './telegram-setup.ts';

export class GatewaySetupError extends Error {}

const updateEnvelope = z.object({ update_id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) });
const webhookInfo = z.object({ url: z.string() });
// SDK logs may contain credential-bearing URLs or denied message text. Publish our own health only.
const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };

/** The pinned SDK owns polling/backoff. Athena commits receipts before returning each fetched batch. */
export class TelegramIntakeAdapter extends TelegramAdapter {
  private readonly instanceId: string;
  private readonly inbox: GatewayInbox;
  private readonly activity: (connected: boolean) => void;
  private readonly signal: AbortSignal | undefined;
  private identityUserName: string | undefined;

  constructor(instanceId: string, inbox: GatewayInbox, botToken: string, activity: (connected: boolean) => void, options: { apiUrl?: string; signal?: AbortSignal } = {}) {
    super({
      botToken, apiUrl: options.apiUrl ?? 'https://api.telegram.org', logger: quiet, mode: 'polling', mentionOnReply: true,
      // Polling must never silently take over a bot's existing webhook.
      longPolling: { deleteWebhook: false, allowedUpdates: ['message', 'edited_message'] },
      allowedUserIds: [], secretToken: '', allowUnverifiedWebhooks: false, businessMode: false,
    });
    this.instanceId = instanceId;
    this.inbox = inbox;
    this.activity = activity;
    this.signal = options.signal;
  }

  protected override async ensureBotIdentity(): Promise<void> {
    await super.ensureBotIdentity();
    // Chat's display name must not replace the bot username used for group mentions.
    this.identityUserName ??= this.userName;
    this._userName = this.identityUserName;
  }

  override async initialize(chat: ChatInstance): Promise<void> {
    const instance = getGatewayInstance(this.instanceId);
    if (!instance.enabled || instance.platform !== 'telegram') throw new GatewaySetupError('This Telegram instance is paused.');
    try { requireTelegramSetupReviewed(this.instanceId); }
    catch { throw new GatewaySetupError('Pause this instance and check Telegram setup before connecting. Its switch receipts need review.'); }
    // SDK initialize catches identity failures; resolve explicitly so a wrong bot cannot start polling.
    await this.ensureBotIdentity();
    if (this.botUserId !== instance.accountId) throw new GatewaySetupError('The Telegram token belongs to a different bot. Check the account ID.');
    const info = webhookInfo.safeParse(await this.telegramFetch('getWebhookInfo'));
    if (!info.success) throw new GatewaySetupError('Telegram webhook setup could not be checked. Try reconnecting.');
    if (info.data.url) throw new GatewaySetupError('This bot has a webhook. Switch it to polling explicitly before connecting.');
    await super.initialize(chat);
  }

  private receive(update: TelegramUpdate): void {
    const instance = getGatewayInstance(this.instanceId);
    if (!instance.enabled) throw new GatewaySetupError('This Telegram instance is paused.');
    const message = update.message ?? update.edited_message;
    if (!message || !message.from || message.sender_chat || message.sender_business_bot || message.business_connection_id) return;
    const sender = message.from;
    if (!Number.isSafeInteger(sender.id) || sender.id <= 0 || sender.is_bot || String(sender.id) === this.botUserId) return;
    if (!Number.isSafeInteger(message.message_id) || !Number.isSafeInteger(message.chat.id)) return;
    if (message.message_thread_id !== undefined && (!Number.isSafeInteger(message.message_thread_id) || message.message_thread_id < 1)) return;
    if (!['private', 'group', 'supergroup'].includes(message.chat.type)) return;
    const input: GatewayInbound = {
      platform: 'telegram', accountId: instance.accountId,
      conversationId: String(message.chat.id), threadId: message.message_thread_id === undefined ? '' : String(message.message_thread_id),
      sourceEventId: String(update.update_id), sourceMessageId: String(message.message_id),
      kind: update.edited_message ? 'edit' : 'message',
      actor: { id: String(sender.id), label: [sender.first_name, sender.last_name].filter(Boolean).join(' ').slice(0, 200), kind: 'user' },
      directMessage: message.chat.type === 'private', triggered: false, text: '', media: [],
      ...(message.media_group_id ? { mediaGroupId: message.media_group_id } : {}),
    };
    if (!gatewayInputAllowed(instance, input)) return;
    // Parsing supplies SDK media IDs and mention/reply detection without fetching any attachment.
    const parsed = this.parseMessage(message);
    input.text = parsed.text;
    input.triggered = parsed.isMention === true;
    input.media = parsed.attachments.map((attachment) => {
      const fileId = attachment.fetchMetadata?.fileId;
      if (!fileId) throw new Error('Telegram did not supply a durable attachment ID.');
      return { kind: attachment.type, fileId, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size };
    });
    this.inbox.accept(input);
  }

  protected override processUpdate(update: TelegramUpdate): Promise<void>[] {
    // Replay any pending SDK receipts through the same idempotent application inbox.
    this.receive(update);
    return [];
  }

  async replyText(event: GatewayInboxEvent, text: string, signal: AbortSignal, approved?: GatewayApprovedTextSend): Promise<string> {
    const instance = getGatewayInstance(this.instanceId);
    if (event.route.instanceId !== this.instanceId || !gatewayInputAllowed(instance, event.input) || event.input.accountId !== this.botUserId) throw new GatewaySendError('failed');
    withGatewayRoute(event.route, () => {});
    if (!text || text.length > 3000 || !/^-?\d+$/.test(event.input.conversationId) || !/^\d+$/.test(event.input.sourceMessageId)) throw new GatewaySendError('failed');
    try { approved?.authorize(event, text); }
    catch { throw new GatewaySendError('failed'); }
    try {
      // Plain text avoids formatter expansion, truncation and fallback posts with ambiguous outcomes.
      const result = z.object({ message_id: z.number().int().positive(), chat: z.object({ id: z.number().int() }) }).parse(await this.telegramFetch('sendMessage', {
        chat_id: event.input.conversationId, text,
        ...(event.input.threadId ? { message_thread_id: Number(event.input.threadId) } : {}),
        reply_parameters: { message_id: Number(event.input.sourceMessageId) },
        link_preview_options: { is_disabled: true },
      }, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) }));
      if (String(result.chat.id) !== event.input.conversationId) throw new GatewaySendError('uncertain');
      return this.encodeMessageId(event.input.conversationId, result.message_id);
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        if (error.code === 'RATE_LIMITED') {
          const seconds = 'retryAfter' in error && typeof error.retryAfter === 'number' && Number.isFinite(error.retryAfter) ? error.retryAfter : 1;
          throw new GatewaySendError('retry', Math.ceil(Math.max(1, seconds) * 1000));
        }
        if (['AUTH_FAILED', 'PERMISSION_DENIED', 'NOT_FOUND', 'VALIDATION_ERROR'].includes(String(error.code))) throw new GatewaySendError('failed');
      }
      throw new GatewaySendError('uncertain');
    }
  }

  async replyDocument(event: GatewayInboxEvent, file: GatewayOutgoingFile, signal: AbortSignal): Promise<string> {
    let bytes: Buffer;
    try { bytes = await verifyGatewayDocument(event, file, signal); }
    catch { throw new GatewaySendError('failed'); }
    const instance = getGatewayInstance(this.instanceId);
    if (event.route.instanceId !== this.instanceId || !gatewayInputAllowed(instance, event.input) || event.input.accountId !== this.botUserId) throw new GatewaySendError('failed');
    withGatewayRoute(event.route, () => {});
    const form = new FormData();
    form.set('chat_id', event.input.conversationId);
    if (event.input.threadId) form.set('message_thread_id', event.input.threadId);
    form.set('reply_parameters', JSON.stringify({ message_id: Number(event.input.sourceMessageId) }));
    form.set('document', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), file.name);
    try {
      // One SDK request per file: no media groups, formatter fallback or hidden resend.
      const result = z.object({ message_id: z.number().int().positive(), chat: z.object({ id: z.number().int() }) }).parse(await this.telegramFetch('sendDocument', form, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) }));
      if (String(result.chat.id) !== event.input.conversationId) throw new GatewaySendError('uncertain');
      return this.encodeMessageId(event.input.conversationId, result.message_id);
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        if (error.code === 'RATE_LIMITED') {
          const seconds = 'retryAfter' in error && typeof error.retryAfter === 'number' && Number.isFinite(error.retryAfter) ? error.retryAfter : 1;
          throw new GatewaySendError('retry', Math.ceil(Math.max(1, seconds) * 1000));
        }
        if (['AUTH_FAILED', 'PERMISSION_DENIED', 'NOT_FOUND', 'VALIDATION_ERROR'].includes(String(error.code))) throw new GatewaySendError('failed');
      }
      throw new GatewaySendError('uncertain');
    }
  }

  /** Unlike the SDK's buffered helper, this exposes a bounded stream and refuses redirects. */
  async downloadFileSource(fileId: string, maxBytes: number, signal: AbortSignal): Promise<{ source: AsyncIterable<Uint8Array>; declaredBytes: number; cancel(): Promise<void> }> {
    const combined = AbortSignal.any([signal, AbortSignal.timeout(45000), ...(this.signal ? [this.signal] : [])]);
    const metadata = z.object({ file_path: z.string().min(1), file_size: z.number().int().nonnegative().optional() }).parse(await this.telegramFetch('getFile', { file_id: fileId }, { signal: combined }));
    const parts = metadata.file_path.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || /[\\\u0000-\u001f?#:%]/.test(part))) throw new Error('Telegram returned an unsafe file path.');
    if ((metadata.file_size ?? 0) > maxBytes) throw new GatewayFileLimitError('This Telegram file exceeds its download limit.');
    const token = encodeURIComponent(await this.resolveBotToken()).replace(/%3A/gi, ':');
    const response = await fetch(`${this.apiBaseUrl}/file/bot${token}/${parts.map(encodeURIComponent).join('/')}`, { signal: combined, redirect: 'error' });
    const declaredBytes = Number(response.headers.get('content-length') || metadata.file_size || 0);
    if (!response.ok || !response.body || !Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maxBytes) {
      await response.body?.cancel();
      if (declaredBytes > maxBytes) throw new GatewayFileLimitError('This Telegram file exceeds its download limit.');
      throw new Error('This Telegram file could not be downloaded within its limit.');
    }
    const body = response.body;
    async function* source(): AsyncGenerator<Uint8Array> {
      const reader = body.getReader();
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > maxBytes) throw new GatewayFileLimitError('This Telegram file exceeds its download limit.');
          yield chunk.value;
        }
      } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
    }
    return { source: source(), declaredBytes, cancel: () => body.cancel() };
  }

  protected override async telegramFetch<TResult>(method: string, payload?: Record<string, unknown> | FormData, request?: { signal?: AbortSignal }): Promise<TResult> {
    try {
      const signals = [AbortSignal.timeout(method === 'getUpdates' ? 45000 : 15000)];
      if (request?.signal) signals.push(request.signal);
      if (this.signal) signals.push(this.signal);
      const result = await super.telegramFetch<TResult>(method, payload, { signal: AbortSignal.any(signals) });
      if (method !== 'getUpdates') return result;
      if (!Array.isArray(result)) throw new Error('Telegram returned an invalid update batch.');
      const acknowledged = result.map((value: unknown) => {
        const envelope = updateEnvelope.parse(value);
        this.receive(value as TelegramUpdate);
        // The SDK can advance its cursor without retaining raw denied or duplicate message bodies.
        return { update_id: envelope.update_id };
      });
      this.activity(true);
      return acknowledged as TResult;
    } catch (error) {
      if (!request?.signal?.aborted && !this.signal?.aborted) this.activity(false);
      throw error;
    }
  }
}
