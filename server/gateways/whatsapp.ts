import crypto from 'node:crypto';
import path from 'node:path';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { WhatsAppAdapter, WhatsAppApiError } from '@chat-adapter/whatsapp';
import type { AdapterPostableMessage, ChatInstance, Logger } from 'chat';
import { z } from 'zod';
import type { GatewayInbound, GatewayInboxEvent, GatewayOutgoingFile } from '../../shared/types.ts';
import { whatsAppMediaHash } from '../../shared/gateway-whatsapp.ts';
import { getGatewayInstance } from './instances.ts';
import { getGatewaySecrets } from '../store.ts';
import { gatewayInputAllowed, GatewayFileLimitError } from './inbox.ts';
import type { GatewayInbox } from './inbox.ts';
import type { GatewayDownloadSource } from './files.ts';
import { GatewaySetupError } from './telegram.ts';
import { GatewaySendError } from './replies.ts';
import { verifyGatewayDocument } from './outgoing.ts';
import { whatsAppIdentityAllowed } from './whatsapp-identities.ts';

const id = z.string().regex(/^[1-9]\d{0,29}$/);
const phone = z.object({ id, display_phone_number: z.string().max(100).optional() });
const phones = z.object({
  data: z.array(phone).max(100),
  paging: z
    .object({
      next: z.string().max(4096).optional(),
      cursors: z.object({ after: z.string().min(1).max(1000).optional() }).optional(),
    })
    .optional(),
});
const mediaInfo = z.object({
  id,
  messaging_product: z.literal('whatsapp'),
  url: z.string().max(8192),
  mime_type: z.string().max(200),
  file_size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().max(100),
});
const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
const unavailable = () => new Error('This WhatsApp file could not be verified or saved. Ask the sender to resend it.');
const mime = (value: string): string => value.split(';', 1)[0].trim().toLowerCase();
const documentTypes: Record<string, string> = {
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const messageReceipt = z.object({
  messaging_product: z.literal('whatsapp'),
  contacts: z
    .array(
      z.object({
        input: z.string().max(500).optional(),
        wa_id: z.string().max(500).optional(),
        user_id: z.string().max(500).optional(),
      }),
    )
    .length(1),
  messages: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(500)
          .regex(/^[^\s\u0000-\u001f\u007f]+$/),
      }),
    )
    .length(1),
});

function fixtureOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || value !== url.origin)
    throw new GatewaySetupError('Invalid WhatsApp fixture address.');
  return value;
}

/** The same CDN host families as the pinned SDK, with stricter URL and redirect checks. */
export function whatsAppMediaUrl(value: string, testOrigin?: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unavailable();
  }
  const local = testOrigin && url.origin === fixtureOrigin(testOrigin);
  const official =
    url.protocol === 'https:' &&
    !url.port &&
    ['graph.facebook.com', 'fbcdn.net', 'fbsbx.com'].some(
      (host) => url.hostname === host || (host !== 'graph.facebook.com' && url.hostname.endsWith(`.${host}`)),
    );
  if (
    (!local && !official) ||
    url.username ||
    url.password ||
    url.href.includes('#') ||
    url.searchParams.has('access_token')
  )
    throw unavailable();
  return url.href;
}

async function aborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    throw unavailable();
  }
  let cancel: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(unavailable());
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([promise, stopped]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
      throw unavailable();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) throw unavailable();
    reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const part = await aborted(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) throw unavailable();
      chunks.push(Buffer.from(part.value));
    }
    const bytes = Buffer.concat(chunks);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw unavailable();
    return JSON.parse(text) as unknown;
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else void response.body?.cancel().catch(() => {});
  }
}

async function verifyAccount(
  phoneId: string,
  businessId: string,
  read: (path: string) => Promise<unknown>,
): Promise<void> {
  const own = phone.parse(await read(`/${phoneId}?fields=id,display_phone_number`));
  if (own.id !== phoneId) throw new Error('Wrong phone');
  let after: string | undefined;
  const cursors = new Set<string>();
  const seen = new Set<string>();
  let found = false;
  for (let page = 0; page < 10; page++) {
    const list = phones.parse(
      await read(
        `/${businessId}/phone_numbers?fields=id,display_phone_number&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`,
      ),
    );
    for (const item of list.data) {
      if (seen.has(item.id)) throw new Error('Repeated phone');
      seen.add(item.id);
      if (item.id === own.id) found = true;
    }
    if (found || !list.paging?.next) break;
    after = list.paging.cursors?.after;
    if (!after || cursors.has(after)) throw new Error('Invalid phone page');
    cursors.add(after);
  }
  if (!found) throw new Error('Phone not in business account');
}

/** Paused setup has its own read-only path; it never initializes or authorizes an SDK adapter. */
export async function checkWhatsAppAccount(
  inbox: GatewayInbox,
  options: { signal?: AbortSignal; testOrigin?: string; timeoutMs?: number } = {},
): Promise<void> {
  const instance = getGatewayInstance(inbox.instanceId);
  const secrets = getGatewaySecrets(instance.id);
  const relay = inbox.whatsAppRelayState();
  const connection = relay?.connection;
  const local = fixtureOrigin(options.testOrigin);
  if (
    instance.enabled ||
    instance.platform !== 'whatsapp' ||
    !connection ||
    connection.phoneNumberId !== instance.accountId ||
    secrets.whatsappPairing !== undefined ||
    !id.safeParse(instance.accountId).success ||
    !id.safeParse(connection.businessAccountId).success ||
    !secrets.accessToken ||
    secrets.accessToken.length > 4096 ||
    /[\r\n]/.test(secrets.accessToken) ||
    !secrets.signingSecret ||
    secrets.signingSecret.length < 16 ||
    secrets.signingSecret.length > 512
  )
    throw new GatewaySetupError(
      'Pause a paired WhatsApp instance and save its access token and app secret before checking setup.',
    );
  const snapshot = JSON.stringify([instance, secrets, relay]);
  const current = () => {
    if (
      snapshot !==
      JSON.stringify([getGatewayInstance(instance.id), getGatewaySecrets(instance.id), inbox.whatsAppRelayState()])
    )
      throw new GatewaySetupError('WhatsApp setup changed during the check. Reload and check it again.');
  };
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 30000),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    await verifyAccount(instance.accountId, connection.businessAccountId, async (path) => {
      current();
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
      const response = await aborted(
        fetch(`${local ?? 'https://graph.facebook.com'}/v25.0${path}`, {
          headers: { authorization: `Bearer ${secrets.accessToken}` },
          redirect: 'error',
          credentials: 'omit',
          signal: requestSignal,
        }),
        requestSignal,
      );
      try {
        if (response.status !== 200 || response.redirected) throw new Error('Account check refused');
        const value = await json(response, requestSignal);
        current();
        return value;
      } finally {
        void response.body?.cancel().catch(() => {});
      }
    });
    current();
  } catch (error) {
    if (error instanceof GatewaySetupError) throw error;
    throw new GatewaySetupError(
      'The WhatsApp token could not verify this business phone. Check its account and permissions.',
    );
  }
}

/** The SDK supplies the adapter contract; durable relay intake and bounded file I/O stay explicit. */
export class WhatsAppGatewayAdapter extends WhatsAppAdapter {
  private readonly instanceId: string;
  private readonly inbox: GatewayInbox;
  private readonly businessAccountId: string;
  private readonly testOrigin: string | undefined;
  private readonly signal: AbortSignal;
  private readonly abort = new AbortController();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly streams = new Set<() => Promise<void>>();
  private verified = false;
  private closed = false;
  private readonly now: () => number;
  private readonly deliveryAttempts = new Map<string, Set<string>>();
  private rateUntil = 0;
  private readonly relayEpoch: string;

  constructor(
    instanceId: string,
    inbox: GatewayInbox,
    credentials: { businessAccountId: string; accessToken: string; appSecret: string },
    options: { signal?: AbortSignal; testOrigin?: string; now?: () => number } = {},
  ) {
    const instance = getGatewayInstance(instanceId);
    const local = fixtureOrigin(options.testOrigin);
    if (
      instance.platform !== 'whatsapp' ||
      inbox.instanceId !== instanceId ||
      !id.safeParse(instance.accountId).success ||
      !id.safeParse(credentials.businessAccountId).success ||
      !credentials.accessToken ||
      credentials.accessToken.length > 4096 ||
      /[\r\n]/.test(credentials.accessToken) ||
      credentials.appSecret.length < 16 ||
      credentials.appSecret.length > 512
    )
      throw new GatewaySetupError('Check the WhatsApp phone, business account and credentials.');
    super({
      accessToken: credentials.accessToken,
      appSecret: credentials.appSecret,
      phoneNumberId: instance.accountId,
      verifyToken: '',
      userName: 'Athena',
      logger: quiet,
      apiUrl: local ?? 'https://graph.facebook.com',
      apiVersion: 'v25.0',
    });
    this.instanceId = instanceId;
    this.inbox = inbox;
    this.businessAccountId = credentials.businessAccountId;
    this.testOrigin = local;
    this.signal = AbortSignal.any([this.abort.signal, ...(options.signal ? [options.signal] : [])]);
    this.now = options.now ?? Date.now;
    this.relayEpoch = inbox.whatsAppRelayState()?.epoch ?? '';
    this.context();
  }

  private context(): void {
    this.signal.throwIfAborted();
    const instance = getGatewayInstance(this.instanceId);
    const relay = this.inbox.whatsAppRelayState();
    if (
      this.closed ||
      !instance.enabled ||
      instance.platform !== 'whatsapp' ||
      instance.accountId !== this.phoneNumberId ||
      !relay?.connection ||
      relay.epoch !== this.relayEpoch ||
      getGatewaySecrets(this.instanceId).whatsappPairing !== undefined ||
      relay.connection.phoneNumberId !== this.phoneNumberId ||
      relay.connection.businessAccountId !== this.businessAccountId
    )
      throw new GatewaySetupError('Check the paired WhatsApp business phone before connecting.');
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task);
    return task.finally(() => {
      this.tasks.delete(task);
    });
  }

  override initialize(chat: ChatInstance): Promise<void> {
    return this.track(this.open(chat));
  }
  private async open(chat: ChatInstance): Promise<void> {
    this.verified = false;
    try {
      this.context();
      await verifyAccount(this.phoneNumberId, this.businessAccountId, (path) => this.read(path, this.signal));
      this.context();
      await super.initialize(chat);
      this.context();
      // A new adapter never owns a send claimed before it finished connecting.
      for (const event of this.inbox.list()) {
        const keys = this.claimKeys(event);
        if (keys.length) this.deliveryAttempts.set(event.id, new Set(keys));
      }
      this.verified = true;
    } catch {
      throw new GatewaySetupError(
        'The WhatsApp token could not verify this business phone. Check its account and permissions.',
      );
    }
  }

  override async handleWebhook(_request: Request): Promise<Response> {
    return new Response('Not found', { status: 404 });
  }
  protected override async send(
    _threadId: string,
    _message: AdapterPostableMessage,
    _replyId?: string,
  ): Promise<never> {
    throw new Error('Use the saved WhatsApp reply delivery.');
  }
  protected override async graphApiRequest<T = unknown>(_path: string, _body: unknown): Promise<T> {
    throw new Error('Use the saved WhatsApp reply delivery.');
  }
  protected override async graphApiUpload<T = unknown>(_path: string, _form: FormData): Promise<T> {
    throw new Error('Use the saved WhatsApp reply delivery.');
  }
  override async downloadMedia(..._args: Parameters<WhatsAppAdapter['downloadMedia']>): Promise<never> {
    throw unavailable();
  }

  private savedDelivery(event: GatewayInboxEvent): GatewayInboxEvent {
    this.context();
    if (!this.verified) throw new GatewaySendError('failed');
    const current = this.inbox.list().find((item) => item.id === event.id);
    if (
      !current ||
      current.route.instanceId !== this.instanceId ||
      current.input.platform !== 'whatsapp' ||
      current.input.accountId !== this.phoneNumberId ||
      JSON.stringify(current.input) !== JSON.stringify(event.input) ||
      JSON.stringify(current.route) !== JSON.stringify(event.route)
    )
      throw new GatewaySendError('failed');
    this.inbox.checkAccess(current);
    return current;
  }

  private window(event: GatewayInboxEvent): void {
    const state = this.inbox.whatsAppRelayState();
    const instance = getGatewayInstance(this.instanceId);
    const now = this.now();
    const latest = this.inbox.list().reduce((last, candidate) => {
      const input = candidate.input;
      if (
        input.platform !== 'whatsapp' ||
        input.accountId !== this.phoneNumberId ||
        input.conversationId !== event.input.conversationId ||
        input.actor.id !== event.input.actor.id ||
        !candidate.relay?.confirmed ||
        candidate.relay.epoch !== state?.epoch ||
        !input.sentAt ||
        !gatewayInputAllowed(instance, input) ||
        !whatsAppIdentityAllowed(input, state?.identities)
      )
        return last;
      const at = Math.min(input.sentAt, candidate.receivedAt);
      return at <= now ? Math.max(last, at) : last;
    }, 0);
    if (!latest || !Number.isSafeInteger(now) || now - latest >= 86400000)
      throw new GatewaySendError('failed', 1000, 'whatsapp-window');
  }

  private claimKeys(event: GatewayInboxEvent): string[] {
    return [
      ...(event.reply?.parts.flatMap((part, index) =>
        part.status === 'sending' ? [`reply:${index}:${part.attempts}`] : [],
      ) ?? []),
      ...(['working', 'approval'] as const).flatMap((kind) =>
        event.notices?.[kind]?.status === 'sending' ? [`${kind}:${event.notices[kind]!.attempts}`] : [],
      ),
      ...(event.outgoing?.flatMap((file, index) =>
        file.status === 'sending' ? [`file:${index}:${file.attempts.length}`] : [],
      ) ?? []),
    ];
  }
  private claim(event: GatewayInboxEvent, text?: string, file?: GatewayOutgoingFile): string {
    if (file) {
      if (event.status !== 'done' || event.dispatch?.state !== 'completed') throw new GatewaySendError('failed');
      const index =
        event.outgoing?.findIndex(
          (item) =>
            item.status === 'sending' &&
            item.path === file.path &&
            item.name === file.name &&
            item.size === file.size &&
            item.sha256 === file.sha256 &&
            JSON.stringify(item.source) === JSON.stringify(file.source),
        ) ?? -1;
      if (index >= 0) return `file:${index}:${event.outgoing![index].attempts.length}`;
    } else {
      const index = event.reply?.parts.findIndex((part) => part.status === 'sending' && part.text === text) ?? -1;
      if (index >= 0) {
        if (event.status !== 'done' || event.dispatch?.state !== 'completed') throw new GatewaySendError('failed');
        return `reply:${index}:${event.reply!.parts[index].attempts}`;
      }
      const kind = (['working', 'approval'] as const).find(
        (kind) => event.notices?.[kind]?.status === 'sending' && event.notices[kind]!.text === text,
      );
      if (kind && event.status === 'running' && event.dispatch?.state !== 'needs-review')
        return `${kind}:${event.notices![kind]!.attempts}`;
    }
    throw new GatewaySendError('failed');
  }
  private reserve(event: GatewayInboxEvent, key: string): void {
    const events = new Map(this.inbox.list().map((item) => [item.id, item]));
    for (const [eventId, attempts] of this.deliveryAttempts) {
      const current = events.get(eventId);
      const keys = current ? this.claimKeys(current) : [];
      for (const attempt of attempts) if (!keys.includes(attempt)) attempts.delete(attempt);
      if (!attempts.size) this.deliveryAttempts.delete(eventId);
    }
    const attempts = this.deliveryAttempts.get(event.id) ?? new Set<string>();
    if (attempts.has(key)) throw new GatewaySendError('uncertain');
    attempts.add(key);
    this.deliveryAttempts.set(event.id, attempts);
  }
  private ready(
    event: GatewayInboxEvent,
    key: string,
    version: string,
    text?: string,
    file?: GatewayOutgoingFile,
  ): GatewayInboxEvent {
    const current = this.savedDelivery(event);
    if (this.claim(current, text, file) !== key || version !== this.inbox.deliveryVersion(event.id))
      throw new GatewaySendError('failed');
    this.window(current);
    if (this.rateUntil > Date.now()) throw new GatewaySendError('retry', this.rateUntil - Date.now());
    return current;
  }

  replyText(event: GatewayInboxEvent, text: string, signal: AbortSignal): Promise<string> {
    return this.track(this.deliver(event, text, signal));
  }
  replyDocument(event: GatewayInboxEvent, file: GatewayOutgoingFile, signal: AbortSignal): Promise<string> {
    return this.track(this.deliver(event, '', signal, file));
  }
  private async deliver(
    event: GatewayInboxEvent,
    text: string,
    caller: AbortSignal,
    file?: GatewayOutgoingFile,
  ): Promise<string> {
    const signal = AbortSignal.any([caller, this.signal]);
    let key: string;
    let version: string;
    let document: { id: string; filename: string } | undefined;
    try {
      signal.throwIfAborted();
      const current = this.savedDelivery(event);
      key = this.claim(current, text, file);
      version = this.inbox.deliveryVersion(event.id);
      this.reserve(current, key);
      this.ready(event, key, version, text, file);
      if (file) {
        const type = documentTypes[path.extname(file.name).toLowerCase()];
        if (!type) throw new GatewaySendError('failed', 1000, 'whatsapp-file-type');
        const bytes = await verifyGatewayDocument(current, file, signal);
        this.ready(event, key, version, text, file);
        signal.throwIfAborted();
        const form = new FormData();
        form.set('messaging_product', 'whatsapp');
        form.set('type', type);
        form.set('file', new Blob([new Uint8Array(bytes)], { type }), file.name);
        const uploaded = z
          .object({ id })
          .safeParse(await this.post(`/${this.phoneNumberId}/media`, form, signal, true));
        if (!uploaded.success) throw new GatewaySendError('failed');
        document = { id: uploaded.data.id, filename: file.name };
      } else if (!text || text.length > 3000) throw new GatewaySendError('failed');
      this.ready(event, key, version, text, file);
      signal.throwIfAborted();
    } catch (error) {
      throw error instanceof GatewaySendError ? error : new GatewaySendError('failed');
    }
    const recipient = event.input.actor.id.slice(1);
    const bsuid = event.input.whatsappUserId;
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      ...(bsuid ? { recipient: bsuid } : {}),
      context: { message_id: event.input.sourceMessageId },
      ...(document ? { type: 'document', document } : { type: 'text', text: { preview_url: false, body: text } }),
    };
    const result = messageReceipt.safeParse(await this.post(`/${this.phoneNumberId}/messages`, body, signal, false));
    if (!result.success) throw new GatewaySendError('uncertain');
    const contact = result.data.contacts[0];
    if (
      (contact.input !== undefined && contact.input !== recipient && contact.input !== bsuid) ||
      (contact.wa_id !== undefined && contact.wa_id !== recipient) ||
      (bsuid && contact.user_id !== undefined && contact.user_id !== bsuid) ||
      !(
        contact.wa_id === recipient ||
        contact.input === recipient ||
        (bsuid && (contact.user_id === bsuid || contact.input === bsuid))
      )
    )
      throw new GatewaySendError('uncertain');
    return `${this.encodeThreadId({ phoneNumberId: this.phoneNumberId, userWaId: recipient })}/${result.data.messages[0].id}`;
  }

  private async post(path: string, body: unknown, external: AbortSignal, upload: boolean): Promise<unknown> {
    try {
      this.context();
      external.throwIfAborted();
    } catch {
      throw new GatewaySendError('failed');
    }
    const signal = AbortSignal.any([this.signal, external, AbortSignal.timeout(upload ? 45000 : 30000)]);
    let response: Response | undefined;
    try {
      response = await aborted(
        fetch(`${this.graphApiUrl}${path}`, {
          method: 'POST',
          body: body instanceof FormData ? body : JSON.stringify(body),
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
          },
          redirect: 'error',
          credentials: 'omit',
          signal,
        }),
        signal,
      );
      if (response.status === 429) {
        const wait = response.headers.get('retry-after') ?? '';
        const delay = /^\d{1,6}$/.test(wait) ? Math.min(3600, Math.max(1, Number(wait))) * 1000 : 1000;
        this.rateUntil = Date.now() + delay;
        throw new GatewaySendError('retry', delay);
      }
      let value: unknown;
      try {
        value = await json(response, signal);
      } catch {
        throw new GatewaySendError(
          !response.ok && response.status >= 400 && response.status < 500 && response.status !== 408
            ? 'failed'
            : upload
              ? 'failed'
              : 'uncertain',
        );
      }
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408) {
          const error = new WhatsAppApiError('WhatsApp request refused', response.status, JSON.stringify(value));
          if (error.errorCode === 131047) throw new GatewaySendError('failed', 1000, 'whatsapp-window');
          if (error.code === 'RATE_LIMITED') {
            this.rateUntil = Date.now() + 1000;
            throw new GatewaySendError('retry', 1000);
          }
          throw new GatewaySendError('failed');
        }
        throw new GatewaySendError(upload ? 'failed' : 'uncertain');
      }
      if (response.status !== 200 || response.redirected) throw new GatewaySendError(upload ? 'failed' : 'uncertain');
      return value;
    } catch (error) {
      throw error instanceof GatewaySendError ? error : new GatewaySendError(upload ? 'failed' : 'uncertain');
    } finally {
      void response?.body?.cancel().catch(() => {});
    }
  }

  private authorize(
    event: GatewayInboxEvent,
    fileId: string,
  ): { media: GatewayInbound['media'][number]; limit: number } {
    this.context();
    if (!this.verified) throw unavailable();
    const current = this.inbox.list().find((item) => item.id === event.id);
    if (
      !current ||
      current.route.instanceId !== this.instanceId ||
      current.input.platform !== 'whatsapp' ||
      current.input.accountId !== this.phoneNumberId ||
      current.input.kind !== 'message' ||
      JSON.stringify(current.input) !== JSON.stringify(event.input) ||
      JSON.stringify(current.route) !== JSON.stringify(event.route)
    )
      throw unavailable();
    const instance = this.inbox.checkAccess(current);
    const matches = current.input.media.filter((item) => item.fileId === fileId);
    if (matches.length !== 1 || !id.safeParse(fileId).success || !matches[0].sha256 || !matches[0].mimeType)
      throw unavailable();
    const media = matches[0];
    return {
      media,
      limit: Math.min(
        instance.fileLimits.perFileBytes,
        media.kind === 'image'
          ? 5 * 1024 * 1024
          : media.kind === 'audio' || media.kind === 'video'
            ? 16 * 1024 * 1024
            : 20 * 1024 * 1024,
      ),
    };
  }

  downloadFileSource(
    fileId: string,
    maxBytes: number,
    signal: AbortSignal,
    event: GatewayInboxEvent,
  ): Promise<GatewayDownloadSource> {
    return this.track(this.download(fileId, maxBytes, signal, event));
  }
  private async download(
    fileId: string,
    maxBytes: number,
    caller: AbortSignal,
    event: GatewayInboxEvent,
  ): Promise<GatewayDownloadSource> {
    const transfer = new AbortController();
    const signal = AbortSignal.any([caller, this.signal, transfer.signal, AbortSignal.timeout(45000)]);
    let response: Response | undefined;
    try {
      const { media, limit } = this.authorize(event, fileId);
      const budget = Math.min(maxBytes, limit);
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw unavailable();
      const metadata = mediaInfo.parse(await this.read(`/${fileId}`, signal));
      const digest = whatsAppMediaHash(metadata.sha256);
      if (
        metadata.id !== fileId ||
        !digest ||
        digest !== media.sha256 ||
        mime(metadata.mime_type) !== mime(media.mimeType!) ||
        (media.size !== undefined && media.size !== metadata.file_size)
      )
        throw unavailable();
      if (metadata.file_size > budget)
        throw new GatewayFileLimitError('This WhatsApp file exceeds its download limit.');
      const url = whatsAppMediaUrl(metadata.url, this.testOrigin);
      if (metadata.file_size > Math.min(budget, this.authorize(event, fileId).limit))
        throw new GatewayFileLimitError('This WhatsApp file exceeds its download limit.');
      signal.throwIfAborted();
      response = await aborted(
        fetch(url, {
          headers: { authorization: `Bearer ${this.accessToken}`, 'accept-encoding': 'identity' },
          redirect: 'error',
          credentials: 'omit',
          signal,
        }),
        signal,
      );
      const length = response.headers.get('content-length');
      const encoding = response.headers.get('content-encoding');
      if (
        response.status !== 200 ||
        !response.body ||
        response.redirected ||
        (response.url && response.url !== url) ||
        (encoding && encoding !== 'identity') ||
        (length !== null && (!/^\d+$/.test(length) || Number(length) !== metadata.file_size)) ||
        response.headers.has('content-range') ||
        mime(response.headers.get('content-type') ?? '') !== mime(metadata.mime_type)
      )
        throw unavailable();
      this.authorize(event, fileId);
      signal.throwIfAborted();
      const reader = response.body.getReader();
      let closing: Promise<void> | undefined;
      const cancel = (): Promise<void> =>
        (closing ??= (async () => {
          transfer.abort();
          try {
            await reader.cancel();
          } catch {
            /* An interrupted response has no reusable body. */
          } finally {
            reader.releaseLock();
            this.streams.delete(cancel);
          }
        })());
      this.streams.add(cancel);
      const source = async function* (adapter: WhatsAppGatewayAdapter): AsyncGenerator<Uint8Array> {
        const hash = crypto.createHash('sha256');
        let size = 0;
        try {
          for (;;) {
            const current = adapter.authorize(event, fileId);
            signal.throwIfAborted();
            const part = await aborted(reader.read(), signal);
            if (part.done) break;
            size += part.value.byteLength;
            if (
              size > Math.min(budget, current.limit, adapter.authorize(event, fileId).limit) ||
              size > metadata.file_size
            )
              throw new GatewayFileLimitError('This WhatsApp file exceeds its download limit.');
            signal.throwIfAborted();
            hash.update(part.value);
            yield part.value;
          }
          if (size !== metadata.file_size || hash.digest('hex') !== digest) throw unavailable();
          if (size > Math.min(budget, adapter.authorize(event, fileId).limit))
            throw new GatewayFileLimitError('This WhatsApp file exceeds its download limit.');
        } catch (error) {
          if (error instanceof GatewayFileLimitError) throw error;
          throw unavailable();
        } finally {
          await cancel();
        }
      };
      return { source: source(this), declaredBytes: metadata.file_size, cancel };
    } catch (error) {
      transfer.abort();
      void response?.body?.cancel().catch(() => {});
      if (error instanceof GatewayFileLimitError) throw error;
      throw unavailable();
    }
  }

  private async read(path: string, external: AbortSignal): Promise<unknown> {
    this.context();
    const signal = AbortSignal.any([this.signal, external, AbortSignal.timeout(10000)]);
    const response = await aborted(
      fetch(`${this.graphApiUrl}${path}`, {
        headers: { authorization: `Bearer ${this.accessToken}` },
        redirect: 'error',
        credentials: 'omit',
        signal,
      }),
      signal,
    );
    try {
      if (response.status !== 200 || response.redirected) throw unavailable();
      return await json(response, signal);
    } finally {
      void response.body?.cancel().catch(() => {});
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    this.verified = false;
    this.abort.abort();
    await Promise.allSettled([...this.tasks]);
    await Promise.allSettled([...this.streams].map((cancel) => cancel()));
    this.deliveryAttempts.clear();
  }
}
