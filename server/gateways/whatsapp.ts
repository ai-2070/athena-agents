import crypto from 'node:crypto';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { WhatsAppAdapter } from '@chat-adapter/whatsapp';
import type { AdapterPostableMessage, ChatInstance, Logger } from 'chat';
import { z } from 'zod';
import type { GatewayInbound, GatewayInboxEvent } from '../../shared/types.ts';
import { whatsAppMediaHash } from '../../shared/gateway-whatsapp.ts';
import { getGatewayInstance } from './instances.ts';
import { GatewayFileLimitError } from './inbox.ts';
import type { GatewayInbox } from './inbox.ts';
import type { GatewayDownloadSource } from './files.ts';
import { GatewaySetupError } from './telegram.ts';

const id = z.string().regex(/^[1-9]\d{0,29}$/);
const phone = z.object({ id, display_phone_number: z.string().max(100).optional() });
const phones = z.object({ data: z.array(phone).max(100), paging: z.object({ next: z.string().max(4096).optional(), cursors: z.object({ after: z.string().min(1).max(1000).optional() }).optional() }).optional() });
const mediaInfo = z.object({ id, messaging_product: z.literal('whatsapp'), url: z.string().max(8192), mime_type: z.string().max(200),
  file_size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: z.string().max(100) });
const quiet: Logger = { child: () => quiet, debug() {}, info() {}, warn() {}, error() {} };
const unavailable = () => new Error('This WhatsApp file could not be verified or saved. Ask the sender to resend it.');
const mime = (value: string): string => value.split(';', 1)[0].trim().toLowerCase();

function fixtureOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || value !== url.origin) throw new GatewaySetupError('Invalid WhatsApp fixture address.');
  return value;
}

/** The same CDN host families as the pinned SDK, with stricter URL and redirect checks. */
export function whatsAppMediaUrl(value: string, testOrigin?: string): string {
  let url: URL; try { url = new URL(value); } catch { throw unavailable(); }
  const local = testOrigin && url.origin === fixtureOrigin(testOrigin);
  const official = url.protocol === 'https:' && !url.port && ['graph.facebook.com', 'fbcdn.net', 'fbsbx.com'].some((host) => url.hostname === host || (host !== 'graph.facebook.com' && url.hostname.endsWith(`.${host}`)));
  if ((!local && !official) || url.username || url.password || url.href.includes('#') || url.searchParams.has('access_token')) throw unavailable();
  return url.href;
}

async function aborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw unavailable(); }
  let cancel: () => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { cancel = () => reject(unavailable()); signal.addEventListener('abort', cancel, { once: true }); });
  try { return await Promise.race([promise, stopped]); } finally { signal.removeEventListener('abort', cancel); }
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

  constructor(instanceId: string, inbox: GatewayInbox, credentials: { businessAccountId: string; accessToken: string; appSecret: string }, options: { signal?: AbortSignal; testOrigin?: string } = {}) {
    const instance = getGatewayInstance(instanceId); const local = fixtureOrigin(options.testOrigin);
    if (instance.platform !== 'whatsapp' || inbox.instanceId !== instanceId || !id.safeParse(instance.accountId).success || !id.safeParse(credentials.businessAccountId).success
      || !credentials.accessToken || credentials.accessToken.length > 4096 || /[\r\n]/.test(credentials.accessToken) || credentials.appSecret.length < 16 || credentials.appSecret.length > 512) throw new GatewaySetupError('Check the WhatsApp phone, business account and credentials.');
    super({ accessToken: credentials.accessToken, appSecret: credentials.appSecret, phoneNumberId: instance.accountId, verifyToken: '', userName: 'Athena', logger: quiet,
      apiUrl: local ?? 'https://graph.facebook.com', apiVersion: 'v25.0' });
    this.instanceId = instanceId; this.inbox = inbox; this.businessAccountId = credentials.businessAccountId; this.testOrigin = local;
    this.signal = AbortSignal.any([this.abort.signal, ...(options.signal ? [options.signal] : [])]);
    this.context();
  }

  private context(): void {
    this.signal.throwIfAborted();
    const instance = getGatewayInstance(this.instanceId); const relay = this.inbox.whatsAppRelayState();
    if (this.closed || !instance.enabled || instance.platform !== 'whatsapp' || instance.accountId !== this.phoneNumberId
      || !relay?.connection || relay.connection.phoneNumberId !== this.phoneNumberId || relay.connection.businessAccountId !== this.businessAccountId) throw new GatewaySetupError('Check the paired WhatsApp business phone before connecting.');
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task); return task.finally(() => { this.tasks.delete(task); });
  }

  override initialize(chat: ChatInstance): Promise<void> {
    return this.track(this.open(chat));
  }
  private async open(chat: ChatInstance): Promise<void> {
    this.verified = false;
    try {
      this.context(); const own = phone.parse(await this.read(`/${this.phoneNumberId}?fields=id,display_phone_number`, this.signal));
      if (own.id !== this.phoneNumberId) throw new Error('Wrong phone');
      let after: string | undefined; const cursors = new Set<string>(); const seen = new Set<string>(); let found = false;
      for (let page = 0; page < 10; page++) {
        const list = phones.parse(await this.read(`/${this.businessAccountId}/phone_numbers?fields=id,display_phone_number&limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`, this.signal));
        for (const item of list.data) {
          if (seen.has(item.id)) throw new Error('Repeated phone'); seen.add(item.id);
          if (item.id === own.id) found = true;
        }
        if (found || !list.paging?.next) break;
        after = list.paging.cursors?.after;
        if (!after || cursors.has(after)) throw new Error('Invalid phone page'); cursors.add(after);
      }
      if (!found) throw new Error('Phone not in business account');
      this.context(); await super.initialize(chat); this.context(); this.verified = true;
    } catch { throw new GatewaySetupError('The WhatsApp token could not verify this business phone. Check its account and permissions.'); }
  }

  override async handleWebhook(_request: Request): Promise<Response> { return new Response('Not found', { status: 404 }); }
  protected override async send(_threadId: string, _message: AdapterPostableMessage, _replyId?: string): Promise<never> { throw new Error('Use the saved WhatsApp reply delivery.'); }
  protected override async graphApiRequest<T = unknown>(_path: string, _body: unknown): Promise<T> { throw new Error('Use the saved WhatsApp reply delivery.'); }
  protected override async graphApiUpload<T = unknown>(_path: string, _form: FormData): Promise<T> { throw new Error('Use the saved WhatsApp reply delivery.'); }
  override async downloadMedia(..._args: Parameters<WhatsAppAdapter['downloadMedia']>): Promise<never> { throw unavailable(); }

  private authorize(event: GatewayInboxEvent, fileId: string): { media: GatewayInbound['media'][number]; limit: number } {
    this.context(); if (!this.verified) throw unavailable();
    const current = this.inbox.list().find((item) => item.id === event.id);
    if (!current || current.route.instanceId !== this.instanceId || current.input.platform !== 'whatsapp' || current.input.accountId !== this.phoneNumberId
      || current.input.kind !== 'message' || JSON.stringify(current.input) !== JSON.stringify(event.input) || JSON.stringify(current.route) !== JSON.stringify(event.route)) throw unavailable();
    const instance = this.inbox.checkAccess(current); const matches = current.input.media.filter((item) => item.fileId === fileId);
    if (matches.length !== 1 || !id.safeParse(fileId).success || !matches[0].sha256 || !matches[0].mimeType) throw unavailable();
    const media = matches[0];
    return { media, limit: Math.min(instance.fileLimits.perFileBytes, media.kind === 'image' ? 5 * 1024 * 1024 : media.kind === 'audio' || media.kind === 'video' ? 16 * 1024 * 1024 : 20 * 1024 * 1024) };
  }

  downloadFileSource(fileId: string, maxBytes: number, signal: AbortSignal, event: GatewayInboxEvent): Promise<GatewayDownloadSource> {
    return this.track(this.download(fileId, maxBytes, signal, event));
  }
  private async download(fileId: string, maxBytes: number, caller: AbortSignal, event: GatewayInboxEvent): Promise<GatewayDownloadSource> {
    const transfer = new AbortController(); const signal = AbortSignal.any([caller, this.signal, transfer.signal, AbortSignal.timeout(45000)]);
    let response: Response | undefined;
    try {
      const { media, limit } = this.authorize(event, fileId); const budget = Math.min(maxBytes, limit);
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw unavailable();
      const metadata = mediaInfo.parse(await this.read(`/${fileId}`, signal));
      const digest = whatsAppMediaHash(metadata.sha256);
      if (metadata.id !== fileId || !digest || digest !== media.sha256 || mime(metadata.mime_type) !== mime(media.mimeType!) || (media.size !== undefined && media.size !== metadata.file_size)) throw unavailable();
      if (metadata.file_size > budget) throw new GatewayFileLimitError('This WhatsApp file exceeds its download limit.');
      const url = whatsAppMediaUrl(metadata.url, this.testOrigin);
      if (metadata.file_size > Math.min(budget, this.authorize(event, fileId).limit)) throw new GatewayFileLimitError('This WhatsApp file exceeds its download limit.');
      signal.throwIfAborted();
      response = await aborted(fetch(url, { headers: { authorization: `Bearer ${this.accessToken}`, 'accept-encoding': 'identity' }, redirect: 'error', credentials: 'omit', signal }), signal);
      const length = response.headers.get('content-length'); const encoding = response.headers.get('content-encoding');
      if (response.status !== 200 || !response.body || response.redirected || (response.url && response.url !== url) || (encoding && encoding !== 'identity')
        || (length !== null && (!/^\d+$/.test(length) || Number(length) !== metadata.file_size)) || response.headers.has('content-range')
        || mime(response.headers.get('content-type') ?? '') !== mime(metadata.mime_type)) throw unavailable();
      this.authorize(event, fileId); signal.throwIfAborted();
      const reader = response.body.getReader(); let closing: Promise<void> | undefined;
      const cancel = (): Promise<void> => closing ??= (async () => {
        transfer.abort(); try { await reader.cancel(); } catch { /* An interrupted response has no reusable body. */ }
        finally { reader.releaseLock(); this.streams.delete(cancel); }
      })();
      this.streams.add(cancel);
      const source = async function* (adapter: WhatsAppGatewayAdapter): AsyncGenerator<Uint8Array> {
        const hash = crypto.createHash('sha256'); let size = 0;
        try {
          for (;;) {
            const current = adapter.authorize(event, fileId); signal.throwIfAborted(); const part = await aborted(reader.read(), signal);
            if (part.done) break;
            size += part.value.byteLength;
            if (size > Math.min(budget, current.limit, adapter.authorize(event, fileId).limit) || size > metadata.file_size) throw new GatewayFileLimitError('This WhatsApp file exceeds its download limit.');
            signal.throwIfAborted(); hash.update(part.value); yield part.value;
          }
          if (size !== metadata.file_size || hash.digest('hex') !== digest) throw unavailable();
          if (size > Math.min(budget, adapter.authorize(event, fileId).limit)) throw new GatewayFileLimitError('This WhatsApp file exceeds its download limit.');
        } catch (error) { if (error instanceof GatewayFileLimitError) throw error; throw unavailable(); }
        finally { await cancel(); }
      };
      return { source: source(this), declaredBytes: metadata.file_size, cancel };
    } catch (error) {
      transfer.abort(); void response?.body?.cancel().catch(() => {});
      if (error instanceof GatewayFileLimitError) throw error;
      throw unavailable();
    }
  }

  private async read(path: string, external: AbortSignal): Promise<unknown> {
    this.context(); const signal = AbortSignal.any([this.signal, external, AbortSignal.timeout(10000)]);
    const response = await aborted(fetch(`${this.graphApiUrl}${path}`, { headers: { authorization: `Bearer ${this.accessToken}` }, redirect: 'error', credentials: 'omit', signal }), signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (response.status !== 200 || !response.body || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw unavailable();
      const length = response.headers.get('content-length'); if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) throw unavailable();
      reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
      for (;;) { const part = await aborted(reader.read(), signal); if (part.done) break; size += part.value.byteLength; if (size > 65536) throw unavailable(); chunks.push(Buffer.from(part.value)); }
      this.context(); const bytes = Buffer.concat(chunks); const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) throw unavailable();
      return JSON.parse(text) as unknown;
    } finally { if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } else void response.body?.cancel().catch(() => {}); }
  }

  async disconnect(): Promise<void> {
    this.closed = true; this.verified = false; this.abort.abort();
    await Promise.allSettled([...this.tasks]); await Promise.allSettled([...this.streams].map((cancel) => cancel()));
  }
}
