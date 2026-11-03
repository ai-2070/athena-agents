import fs from 'node:fs';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import type { GatewayDiscordState } from '../../shared/types.ts';
import { discordId } from '../../shared/gateway-discord.ts';
import { readJSON, writeJSON } from '../util.ts';
import type { GatewayStateAdapter } from './state.ts';
import { GatewaySetupError } from './telegram.ts';

export const discordGatewayIntents = 1 | 512 | 4096 | 32768;
const stamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const discordGatewayDetails = z.object({ url: z.string().max(2048), shards: stamp.min(1), session_start_limit: z.object({
  total: stamp.min(1), remaining: stamp, reset_after: stamp, max_concurrency: stamp.min(1),
}) });
export const discordStateSchema = z.object({
  version: z.literal(1), accountId: z.string().refine(discordId), intents: z.literal(discordGatewayIntents),
  identifiedAt: stamp.optional(), retryAt: stamp.optional(),
  session: z.object({ id: z.string().min(1).max(512), url: z.string().max(2048), sequence: stamp }).strict().optional(),
  gap: z.object({ at: stamp, reason: z.literal('session-lost') }).strict().optional(),
  reviewedGaps: z.array(z.object({ at: stamp, gapAt: stamp, sequence: stamp, revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(1000).optional(),
}).strict().refine((value) => !value.gap || Boolean(value.session), 'A recovery gap needs its saved session.');
const journal = discordStateSchema;
const packet = z.object({ op: stamp, d: z.unknown(), s: stamp.nullable().optional(), t: z.string().min(1).max(100).nullable().optional() });
const connections = new WeakMap<GatewayStateAdapter, DiscordGateway>();
const ready = z.object({ v: z.literal(10), user: z.object({ id: z.string(), bot: z.literal(true) }), session_id: z.string().min(1).max(512), resume_gateway_url: z.string().max(2048) });

export class DiscordGatewayRetryError extends Error {
  readonly retryAt: number;
  constructor(retryAt: number) { super('Discord needs a pause before reconnecting.'); this.retryAt = retryAt; }
}
export class DiscordGatewayGapError extends GatewaySetupError {
  constructor() { super('Discord lost its saved session. Review the recovery gap before starting a new session.'); }
}

export function discordEndpoint(value: string, testOrigin?: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new GatewaySetupError('The Discord Gateway address is invalid.'); }
  const local = testOrigin && url.origin === testOrigin && url.protocol === 'ws:' && url.hostname === '127.0.0.1';
  const official = url.protocol === 'wss:' && !url.port && /^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/.test(url.hostname);
  if ((!local && !official) || url.username || url.password || url.hash || url.search || url.pathname !== '/') throw new GatewaySetupError('The Discord Gateway address is not allowed.');
  url.searchParams.set('v', '10'); url.searchParams.set('encoding', 'json'); return url.href;
}

export function readDiscordGatewayState(file: string, accountId: string, testOrigin?: string): GatewayDiscordState {
  const parsed = journal.safeParse(fs.existsSync(file) ? readJSON(file) : { version: 1, accountId, intents: discordGatewayIntents });
  if (!parsed.success || parsed.data.accountId !== accountId) throw new GatewaySetupError('Discord recovery state is unreadable. Restore it before reconnecting.');
  if (parsed.data.session) discordEndpoint(parsed.data.session.url, testOrigin);
  return parsed.data;
}

export function checkDiscordGatewayState(state: GatewayStateAdapter, accountId: string, testOrigin?: string): void {
  const saved = readDiscordGatewayState(state.discordGatewayFile(), accountId, testOrigin);
  if (saved.gap) throw new DiscordGatewayGapError();
  const retryAt = Math.max(saved.retryAt ?? 0, saved.session ? 0 : (saved.identifiedAt ?? 0) + 5000);
  if (retryAt > Date.now()) throw new DiscordGatewayRetryError(retryAt);
}

interface Options {
  state: GatewayStateAdapter;
  accountId: string;
  token: () => Promise<string>;
  discover: () => Promise<unknown>;
  receive: (type: string, eventId: string, payload: unknown, signal: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal;
  onDisconnect?: (error: Error) => void;
  /** Only local protocol fixtures may replace the fixed Discord host. Never read from instance settings. */
  testOrigin?: string;
  now?: () => number;
  random?: () => number;
}

/** One connection attempt. Its owner must drain stop() before releasing the instance claim. */
export class DiscordGateway {
  private saved: GatewayDiscordState;
  private socket: WebSocket | undefined;
  private readonly abort = new AbortController();
  private pending: Promise<void> = Promise.resolve();
  private queued = 0;
  private queuedBytes = 0;
  private received: number | null = null;
  private hello = false;
  private authenticated = false;
  private started = false;
  private stopped = false;
  private connected = false;
  private awaitingAck = false;
  private heartbeat: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private resolveStart: (() => void) | undefined;
  private rejectStart: ((error: Error) => void) | undefined;
  private readonly externalAbort = () => this.fail(new Error('The Discord connection stopped.'));

  constructor(privateOptions: Options) {
    this.options = privateOptions;
    if (!discordId(privateOptions.accountId)) throw new GatewaySetupError('The Discord bot ID is invalid.');
    this.saved = this.load();
  }
  private load(): GatewayDiscordState {
    return readDiscordGatewayState(this.options.state.discordGatewayFile(), this.options.accountId, this.options.testOrigin);
  }

  private readonly options: Options;
  get alive(): boolean { return this.connected && !this.stopped; }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private active(): void { this.abort.signal.throwIfAborted(); this.options.signal?.throwIfAborted(); }
  private save(next: GatewayDiscordState): void {
    writeJSON(this.options.state.discordGatewayFile(), journal.parse(next)); this.saved = next;
  }
  private endpoint(value: string): string {
    return discordEndpoint(value, this.options.testOrigin);
  }

  async start(): Promise<void> {
    if (this.started || this.stopped) throw new Error('This Discord connection has already been used.');
    if (connections.has(this.options.state)) throw new Error('This Discord instance already has a connection.');
    connections.set(this.options.state, this); this.started = true; this.active(); this.saved = this.load();
    if (this.saved.gap) throw new DiscordGatewayGapError();
    if ((this.saved.retryAt ?? 0) > this.now()) throw new DiscordGatewayRetryError(this.saved.retryAt!);
    let url = this.saved.session?.url;
    if (!url) {
      if (this.saved.identifiedAt !== undefined && this.now() < this.saved.identifiedAt + 5000) throw new DiscordGatewayRetryError(this.saved.identifiedAt + 5000);
      const details = discordGatewayDetails.parse(await this.options.discover()); this.active();
      if (details.shards !== 1) throw new GatewaySetupError('This Discord bot needs multiple shards, which are not supported yet.');
      if (details.session_start_limit.remaining > details.session_start_limit.total) throw new GatewaySetupError('Discord returned an invalid session allowance.');
      if (!details.session_start_limit.remaining) {
        const retryAt = this.now() + Math.max(5000, details.session_start_limit.reset_after);
        this.save({ ...this.saved, retryAt }); throw new DiscordGatewayRetryError(retryAt);
      }
      url = details.url;
    }
    const endpoint = this.endpoint(url);
    this.options.signal?.addEventListener('abort', this.externalAbort, { once: true });
    const waiting = new Promise<void>((resolve, reject) => { this.resolveStart = resolve; this.rejectStart = reject; });
    this.socket = new WebSocket(endpoint, { maxPayload: 2 * 1024 * 1024, perMessageDeflate: false, followRedirects: false, handshakeTimeout: 15000 });
    this.waitForHandshake();
    this.socket.on('message', (data, binary) => {
      if (this.stopped) return;
      try {
        if (binary) throw new Error('Unsupported Discord packet.');
        const buffer = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
        const bytes = buffer.byteLength; const parsed = packet.parse(JSON.parse(buffer.toString('utf8')) as unknown);
        this.handle(parsed, bytes);
      } catch { this.fail(new Error('Discord sent an invalid Gateway event.')); }
    });
    this.socket.on('error', () => this.fail(new Error('Discord could not keep its Gateway connection.')));
    this.socket.on('close', (code) => {
      if (this.stopped) return;
      try {
        if ([4007, 4009, 1000, 1001].includes(code)) { this.lostSession(); return; }
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) { this.fail(new GatewaySetupError('Discord refused this connection. Check the bot token, intents and shard requirements.')); return; }
        if (code === 4008) { this.retry(60000); return; }
        this.fail(new Error('Discord disconnected. Resume from the saved event.'));
      } catch { this.fail(new Error('Discord could not save its recovery state.')); }
    });
    return waiting;
  }

  private send(op: number, d: unknown): void {
    this.active(); if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Discord is not connected.');
    const text = JSON.stringify({ op, d }); if (Buffer.byteLength(text) > 4096) throw new Error('Discord authentication is too large.');
    this.socket.send(text, (error) => { if (error) this.fail(new Error('Discord could not send a Gateway packet.')); });
  }
  private beat(): void { this.send(1, this.received); this.awaitingAck = true; }
  private tick(interval: number): void {
    try {
      if (this.awaitingAck) { this.fail(new Error('Discord stopped acknowledging heartbeats. Resume from the saved event.')); return; }
      this.beat(); this.heartbeat = setTimeout(() => this.tick(interval), interval); this.heartbeat.unref();
    } catch { this.fail(new Error('Discord could not send its heartbeat.')); }
  }
  private handle(value: z.infer<typeof packet>, bytes: number): void {
    this.active();
    if (value.op === 10) {
      if (this.hello) throw new Error('Duplicate Discord hello.'); this.hello = true;
      const interval = z.object({ heartbeat_interval: stamp.min(20).max(300000) }).parse(value.d).heartbeat_interval;
      const jitter = Math.max(0, Math.min(1, (this.options.random ?? Math.random)()));
      this.heartbeat = setTimeout(() => this.tick(interval), Math.floor(interval * jitter)); this.heartbeat.unref();
      this.enqueue(async () => {
        const token = await this.options.token(); this.active();
        if (this.saved.session) {
          this.received = this.saved.session.sequence;
          this.send(6, { token, session_id: this.saved.session.id, seq: this.saved.session.sequence });
        } else {
          this.save({ ...this.saved, identifiedAt: this.now(), retryAt: undefined });
          this.send(2, { token, intents: discordGatewayIntents, properties: { os: process.platform, browser: 'Athena', device: 'Athena' }, compress: false, shard: [0, 1] });
        }
        this.authenticated = true;
      }, bytes); return;
    }
    if (!this.hello) throw new Error('Discord did not send hello.');
    if (value.op === 11) { this.awaitingAck = false; return; }
    if (value.op === 1) { this.beat(); return; }
    if (value.op === 7) { this.fail(new Error('Discord requested a reconnect. Resume from the saved event.')); return; }
    if (value.op === 9) { if (z.boolean().parse(value.d)) this.retry(5000); else this.lostSession(); return; }
    if (value.op !== 0 || !this.authenticated || value.s === null || value.s === undefined || !value.t) throw new Error('Unexpected Discord packet.');
    if (this.received !== null && value.s <= this.received) throw new Error('Discord events arrived out of order.');
    this.received = value.s;
    // Replayed intake has its own bounded REST calls; do not time it out as an idle handshake.
    if (this.deadline) clearTimeout(this.deadline);
    const sequence = value.s; const type = value.t;
    this.enqueue(async () => {
      if (type === 'READY') {
        if (this.saved.session || this.connected) throw new Error('Unexpected Discord ready.');
        const data = ready.parse(value.d); if (data.user.id !== this.options.accountId) throw new Error('Wrong Discord bot.');
        this.endpoint(data.resume_gateway_url);
        this.save({ ...this.saved, retryAt: undefined, session: { id: data.session_id, url: data.resume_gateway_url, sequence } });
        this.finishStart(); return;
      }
      if (!this.saved.session) throw new Error('Discord did not establish a session.');
      if (type === 'RESUMED') {
        if (this.connected) throw new Error('Unexpected Discord resume.');
      } else {
        const eventId = crypto.createHash('sha256').update(JSON.stringify([this.saved.session.id, sequence])).digest('hex');
        await this.options.receive(type, eventId, value.d, this.abort.signal); this.active();
      }
      this.save({ ...this.saved, retryAt: undefined, session: { ...this.saved.session, sequence } });
      if (type === 'RESUMED') this.finishStart();
    }, bytes);
  }
  private enqueue(task: () => Promise<void>, bytes: number): void {
    if (this.queued >= 32 || this.queuedBytes + bytes > 8 * 1024 * 1024) throw new Error('Discord input is too far behind.');
    this.queued++; this.queuedBytes += bytes;
    this.pending = this.pending.then(async () => { this.active(); await task(); }).catch(() => {
      this.fail(new Error('Discord could not handle or save this event. Resume from the saved event.'));
    }).finally(() => {
      this.queued--; this.queuedBytes -= bytes;
      if (!this.stopped && !this.connected && !this.queued) this.waitForHandshake();
    });
  }
  private waitForHandshake(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = setTimeout(() => this.fail(new Error('Discord did not finish connecting in time.')), 30000); this.deadline.unref();
  }
  private finishStart(): void {
    this.connected = true; if (this.deadline) clearTimeout(this.deadline);
    this.resolveStart?.(); this.resolveStart = undefined; this.rejectStart = undefined;
  }
  private retry(delay: number): void {
    const retryAt = this.now() + delay; this.save({ ...this.saved, retryAt }); this.fail(new DiscordGatewayRetryError(retryAt));
  }
  private lostSession(): void {
    if (this.saved.session) {
      this.save({ ...this.saved, gap: { at: this.now(), reason: 'session-lost' } });
      this.fail(new DiscordGatewayGapError());
    } else this.retry(5000);
  }
  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true; this.connected = false; this.abort.abort();
    if (this.heartbeat) clearTimeout(this.heartbeat); if (this.deadline) clearTimeout(this.deadline);
    this.options.signal?.removeEventListener('abort', this.externalAbort);
    // A normal close invalidates Discord's resume session. Drop TCP instead.
    this.socket?.terminate(); this.rejectStart?.(error); this.rejectStart = undefined; this.resolveStart = undefined;
    try { this.options.onDisconnect?.(error); } catch { /* The owner cannot prevent connection shutdown. */ }
  }
  async stop(): Promise<void> {
    this.fail(new Error('The Discord connection stopped.')); await this.pending;
    if (connections.get(this.options.state) === this) connections.delete(this.options.state);
  }
}
