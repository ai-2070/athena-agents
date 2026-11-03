import crypto from 'node:crypto';
import type { ReadableStreamDefaultReader } from 'node:stream/web';
import { z } from 'zod';
import type { GatewayWhatsAppIntakeState, GatewayWhatsAppReceipt, GatewayWhatsAppRelayConnection, GatewayWhatsAppRelayStatus } from '../../shared/types.ts';
import { relaySequence, whatsAppRelayConnectionSchema, whatsAppRelayEnvelopeSchema, whatsAppRelayStatusSchema } from '../../shared/gateway-whatsapp-relay.ts';
import { getGatewayInstance } from './instances.ts';
import type { GatewayInbox } from './inbox.ts';
import { WhatsAppIntakeError, WhatsAppRelayIntake } from './whatsapp-intake.ts';

type Recovery = NonNullable<GatewayWhatsAppIntakeState['recovery']>['reason'];
const active = new Map<string, WhatsAppRelayConsumer>();
const claimSchema = z.strictObject({ epoch: z.uuid(), lease: z.string().regex(/^[a-f0-9]{64}$/), cursor: relaySequence, expiresAt: relaySequence });
const pullSchema = whatsAppRelayStatusSchema.extend({ envelopes: z.array(whatsAppRelayEnvelopeSchema).max(20), leaseExpiresAt: relaySequence });

export class WhatsAppRelayError extends Error {
  readonly kind: 'retry' | 'setup' | 'review';
  readonly retryAt?: number;
  readonly recovery: Recovery;
  constructor(kind: WhatsAppRelayError['kind'], recovery: Recovery = 'envelope', retryAt?: number) {
    super(kind === 'review' ? 'Review the WhatsApp relay recovery before reconnecting.' : kind === 'setup' ? 'Check the WhatsApp relay pairing and pull key before reconnecting.' : 'The WhatsApp relay could not connect. It can retry safely.');
    this.kind = kind; this.recovery = recovery; this.retryAt = retryAt;
  }
}
interface Options {
  inbox: GatewayInbox;
  token: string;
  appSecret: string;
  signal?: AbortSignal;
  /** Protocol fixtures only. Never read a request function or timeout from instance settings. */
  request?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  onDisconnect?: (error: WhatsAppRelayError) => void;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); throw new WhatsAppRelayError('retry'); }
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new WhatsAppRelayError('retry')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

/** One paired consumer. It never owns a dashboard endpoint, model run or outbound Meta token. */
export class WhatsAppRelayConsumer {
  private readonly options: Options;
  private readonly connection: GatewayWhatsAppRelayConnection;
  private readonly intake: WhatsAppRelayIntake;
  private readonly abort = new AbortController();
  private readonly consumerId = crypto.randomUUID();
  private lease: string | undefined;
  private pending: Promise<number> | undefined;
  private closing: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private started = false;
  private failureValue: WhatsAppRelayError | undefined;

  constructor(options: Options) {
    this.options = { ...options };
    const connection = whatsAppRelayConnectionSchema.safeParse(options.inbox.whatsAppRelayState()?.connection);
    if (!connection.success || !/^[a-f0-9]{64}$/.test(options.token)) throw new WhatsAppRelayError('setup');
    this.connection = connection.data;
    this.intake = new WhatsAppRelayIntake(options.inbox.instanceId, options.inbox, connection.data.businessAccountId, options.appSecret);
    this.current();
  }

  private current(): GatewayWhatsAppIntakeState {
    const instance = getGatewayInstance(this.options.inbox.instanceId);
    const state = this.options.inbox.whatsAppRelayState();
    if (!instance.enabled || instance.platform !== 'whatsapp' || instance.accountId !== this.connection.phoneNumberId || !state
      || JSON.stringify(state.connection) !== JSON.stringify(this.connection)) throw new WhatsAppRelayError('setup');
    if (state.recovery) throw new WhatsAppRelayError('review', state.recovery.reason);
    return state;
  }

  private live(): void {
    if (this.stopped || this.abort.signal.aborted || this.options.signal?.aborted) throw new WhatsAppRelayError('retry');
    this.current();
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) throw new WhatsAppRelayError('setup');
    this.started = true; await this.poll(); this.schedule();
  }
  private schedule(): void {
    if (this.stopped || this.failureValue) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().then(() => this.schedule()).catch(() => {});
    }, 5000); this.timer.unref();
  }
  alive(): boolean { return this.started && !this.stopped && !this.failureValue && !this.options.signal?.aborted; }
  failure(): WhatsAppRelayError | undefined { return this.failureValue; }

  poll(): Promise<number> {
    if (this.pending) return Promise.reject(new WhatsAppRelayError('retry'));
    try {
      this.live(); const owner = active.get(this.options.inbox.instanceId);
      if (owner && owner !== this) throw new WhatsAppRelayError('retry');
      active.set(this.options.inbox.instanceId, this);
    } catch (error) {
      this.failed(error instanceof WhatsAppRelayError ? error : new WhatsAppRelayError('retry'));
      return Promise.reject(this.failureValue);
    }
    return this.pending = this.drain().catch((error: unknown) => {
      let failure = error instanceof WhatsAppRelayError ? error : error instanceof WhatsAppIntakeError ? new WhatsAppRelayError('review') : new WhatsAppRelayError('retry');
      if (failure.kind === 'review') {
        try { this.options.inbox.holdWhatsAppRelay(failure.recovery); }
        catch { failure = new WhatsAppRelayError('retry'); }
      }
      this.failed(failure);
      throw failure;
    }).finally(() => { this.pending = undefined; });
  }

  private failed(error: WhatsAppRelayError): void {
    this.failureValue = error;
    if (!this.stopped && !this.options.signal?.aborted) this.options.onDisconnect?.(error);
  }

  private status(value: unknown): GatewayWhatsAppRelayStatus {
    const parsed = whatsAppRelayStatusSchema.safeParse(value);
    if (!parsed.success) throw new WhatsAppRelayError('review');
    const status = parsed.data;
    if (status.installationId !== this.connection.installationId || status.businessAccountId !== this.connection.businessAccountId || status.phoneNumberId !== this.connection.phoneNumberId) throw new WhatsAppRelayError('review', 'installation');
    if (status.epoch !== this.connection.epoch) throw new WhatsAppRelayError('review', 'epoch');
    // Lowering a relay quota must still let the already saved queue drain.
    if (status.queuedEvents > 10000 || status.queuedBytes > 67108864 || (!status.queuedEvents && status.queuedBytes)) throw new WhatsAppRelayError('review');
    if (status.gap) throw new WhatsAppRelayError('review', 'gap');
    return status;
  }

  private cursor(remote: number): void {
    const state = this.current(); const pending = state.receipt;
    if (remote !== state.cursor && !(pending && !pending.confirmed && pending.sequence === remote)) throw new WhatsAppRelayError('review', 'cursor');
  }

  private async drain(): Promise<number> {
    const status = this.status(await this.request('/v1/status')); this.live(); this.cursor(status.cursor);
    if (!this.lease) {
      const claim = claimSchema.safeParse(await this.request('/v1/claim', { epoch: this.connection.epoch, consumerId: this.consumerId }));
      this.live();
      if (!claim.success || claim.data.epoch !== this.connection.epoch || claim.data.expiresAt <= Date.now() || claim.data.expiresAt > Date.now() + 65000) throw new WhatsAppRelayError('review');
      this.lease = claim.data.lease; this.cursor(claim.data.cursor);
      if (claim.data.cursor !== status.cursor) throw new WhatsAppRelayError('review', 'cursor');
    }
    const saved = this.current();
    if (saved.receipt && !saved.receipt.confirmed && status.cursor === saved.receipt.sequence) {
      // A status cursor alone is not proof: the relay must also match the saved envelope ID.
      await this.intake.confirmPending((proof) => this.acknowledge(proof)); this.live();
    }
    const cursor = this.current().cursor;
    const raw = await this.request(`/v1/pull?epoch=${this.connection.epoch}&after=${cursor}&limit=20`, undefined, 2097152);
    this.live(); const pull = pullSchema.safeParse(raw);
    if (!pull.success) throw new WhatsAppRelayError('review');
    const { envelopes, leaseExpiresAt, ...metadata } = pull.data;
    const after = this.status(metadata);
    if (after.cursor !== cursor || envelopes.length > after.queuedEvents || leaseExpiresAt <= Date.now() || leaseExpiresAt > Date.now() + 65000
      || envelopes.some((envelope, index) => envelope.sequence !== cursor + index + 1)
      || new Set(envelopes.map((envelope) => envelope.id)).size !== envelopes.length) throw new WhatsAppRelayError('review', 'cursor');
    const pending = this.current().receipt;
    if (pending && !pending.confirmed && (!envelopes[0] || envelopes[0].id !== pending.id || envelopes[0].sequence !== pending.sequence)) throw new WhatsAppRelayError('review', 'envelope');
    for (const envelope of envelopes) {
      this.live(); await this.intake.receive(this.connection.epoch, envelope, (proof) => this.acknowledge(proof));
    }
    this.live(); this.failureValue = undefined; return envelopes.length;
  }

  private async acknowledge(proof: GatewayWhatsAppReceipt): Promise<{ epoch: string; cursor: number }> {
    this.live();
    const parsed = z.strictObject({ cursor: relaySequence }).safeParse(await this.request('/v1/ack', { epoch: proof.epoch, through: proof.sequence, eventId: proof.id }));
    this.live();
    if (!parsed.success || parsed.data.cursor !== proof.sequence || proof.epoch !== this.connection.epoch) throw new WhatsAppRelayError('review', 'cursor');
    return { epoch: this.connection.epoch, cursor: parsed.data.cursor };
  }

  private async request(path: string, body?: unknown, limit = 65536, releasing = false): Promise<unknown> {
    if (!releasing) this.live();
    const signal = releasing ? AbortSignal.timeout(2000) : AbortSignal.any([this.abort.signal, this.options.signal ?? this.abort.signal, AbortSignal.timeout(this.options.timeoutMs ?? 10000)]);
    const url = `${this.connection.origin}${path}`;
    const response = await abortable((this.options.request ?? fetch)(url, {
      method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
      headers: { authorization: `Bearer ${this.options.token}`, ...(this.lease ? { 'x-relay-lease': this.lease } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
    }), signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (response.redirected || (response.url && response.url !== url)) throw new WhatsAppRelayError('review');
      if (response.status === 401 || response.status === 403) throw new WhatsAppRelayError('setup');
      if (response.status === 410) throw new WhatsAppRelayError('review', 'gap');
      if (response.status === 429 || response.status >= 500) {
        const wait = response.headers.get('retry-after') ?? '';
        throw new WhatsAppRelayError('retry', 'envelope', Date.now() + (/^\d{1,6}$/.test(wait) ? Math.min(3600, Math.max(1, Number(wait))) * 1000 : 5000));
      }
      if (response.ok && response.status !== 200) throw new WhatsAppRelayError('review');
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw new WhatsAppRelayError('review');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) throw new WhatsAppRelayError('review');
      if (!response.body) throw new WhatsAppRelayError('review');
      reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
      for (;;) {
        const part = await abortable(reader.read(), signal); if (part.done) break;
        size += part.value.byteLength; if (size > limit) throw new WhatsAppRelayError('review'); chunks.push(Buffer.from(part.value));
      }
      const bytes = Buffer.concat(chunks); const text = bytes.toString('utf8');
      if (!Buffer.from(text).equals(bytes)) throw new WhatsAppRelayError('review');
      let value: unknown; try { value = JSON.parse(text) as unknown; } catch { throw new WhatsAppRelayError('review'); }
      if (!response.ok) {
        const code = z.object({ error: z.string().max(100) }).safeParse(value);
        if (response.status === 409 && code.success && ['already_claimed', 'lease_required'].includes(code.data.error)) {
          if (code.data.error === 'lease_required') this.lease = undefined;
          throw new WhatsAppRelayError('retry', 'envelope', Date.now() + 60000);
        }
        throw new WhatsAppRelayError('review', code.success && code.data.error === 'epoch_changed' ? 'epoch' : 'cursor');
      }
      return value;
    } finally {
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      else void response.body?.cancel().catch(() => {});
    }
  }

  stop(): Promise<void> { return this.closing ??= this.close(); }
  private async close(): Promise<void> {
    this.stopped = true; clearTimeout(this.timer); this.abort.abort();
    await this.pending?.catch(() => {});
    try { if (this.lease) await this.request('/v1/release', { epoch: this.connection.epoch }, 65536, true); }
    catch { /* An unknown release keeps the server lease until expiry; never claim around it. */ }
    finally { this.lease = undefined; if (active.get(this.options.inbox.instanceId) === this) active.delete(this.options.inbox.instanceId); }
  }
}
