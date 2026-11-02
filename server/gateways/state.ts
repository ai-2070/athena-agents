import fs from 'node:fs';
import crypto from 'node:crypto';
import { Message } from 'chat';
import type { Lock, QueueEntry, SerializedMessage, StateAdapter } from 'chat';
import { z } from 'zod';
import type { GatewaySdkState } from '../../shared/types.ts';
import { privateDataPath } from '../private.ts';
import { readJSON, writeJSON } from '../util.ts';
import { claimGatewayState, gatewayStateDirectory } from './ownership.ts';

function jsonCopy<T>(value: T): T {
  const encoded = JSON.stringify(value, (_key, part: unknown) => {
    if (typeof part === 'function' || typeof part === 'symbol' || typeof part === 'bigint' || (typeof part === 'number' && !Number.isFinite(part))) {
      throw new Error('Gateway state must contain serializable data.');
    }
    return part;
  });
  if (encoded === undefined) throw new Error('Gateway state must contain serializable data.');
  return JSON.parse(encoded) as T;
}

const hash = (key: string): string => crypto.createHash('sha256').update(key).digest('hex');
const empty = (): GatewaySdkState => ({ version: 1, values: {}, lists: {}, locks: {}, subscriptions: [], queues: {} });
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const messageEnvelope = z.object({
  _type: z.literal('chat:Message'), id: z.string(), threadId: z.string(), text: z.string(),
  author: z.object({ userId: z.string(), userName: z.string(), fullName: z.string(), isBot: z.union([z.boolean(), z.literal('unknown')]), isMe: z.boolean() }),
  metadata: z.object({ dateSent: z.iso.datetime(), edited: z.boolean(), editedAt: z.iso.datetime().optional() }),
  formatted: z.object({ type: z.literal('root'), children: z.array(z.unknown()) }),
  attachments: z.array(z.object({ type: z.enum(['image', 'file', 'video', 'audio']), fetchMetadata: z.record(z.string(), z.string()).optional() })),
});
const stateSchema = z.strictObject({
  version: z.literal(1),
  values: z.record(z.string(), z.strictObject({ value: z.unknown(), expiresAt: timestamp.nullable() })),
  lists: z.record(z.string(), z.strictObject({ values: z.array(z.unknown()), expiresAt: timestamp.nullable() })),
  locks: z.record(z.string(), z.strictObject({ threadId: z.string(), token: z.string().min(1), expiresAt: timestamp })),
  subscriptions: z.array(z.string()),
  queues: z.record(z.string(), z.array(z.strictObject({
    enqueuedAt: timestamp, expiresAt: timestamp,
    message: z.custom<SerializedMessage>((value) => messageEnvelope.safeParse(value).success),
  }))),
});

function expires(ttlMs?: number): number | null {
  if (ttlMs === undefined) return null;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(Date.now() + ttlMs)) throw new Error('Invalid gateway state lifetime.');
  return Date.now() + ttlMs;
}

function prune(state: GatewaySdkState): void {
  const now = Date.now();
  for (const records of [state.values, state.lists, state.locks]) {
    for (const [key, entry] of Object.entries(records)) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) delete records[key];
    }
  }
  for (const [key, queue] of Object.entries(state.queues)) {
    const live = queue.filter((entry) => entry.expiresAt > now);
    if (live.length) state.queues[key] = live;
    else delete state.queues[key];
  }
}

/** One claimed writer per instance. Each mutation commits atomically before returning to the SDK. */
export class GatewayStateAdapter implements StateAdapter {
  private readonly instanceId: string;
  private data: GatewaySdkState | undefined;
  private release: (() => Promise<void>) | undefined;
  private opening: Promise<void> | undefined;
  private closing: Promise<void> | undefined;

  constructor(instanceId: string) {
    gatewayStateDirectory(instanceId);
    this.instanceId = instanceId;
  }

  private file(): string {
    gatewayStateDirectory(this.instanceId);
    return privateDataPath('gateways-runtime', this.instanceId, 'sdk-state.json');
  }

  connect(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Gateway state is disconnecting.'));
    if (this.data) return Promise.resolve();
    return this.opening ??= this.open().finally(() => { this.opening = undefined; });
  }

  private async open(): Promise<void> {
    const release = await claimGatewayState(this.instanceId);
    try {
      const file = this.file();
      const parsed = stateSchema.safeParse(fs.existsSync(file) ? readJSON(file) : empty());
      if (!parsed.success) {
        throw new Error('Gateway SDK state is unreadable. Restore it before reconnecting.');
      }
      const saved = parsed.data;
      prune(saved);
      writeJSON(file, saved);
      this.data = saved;
      this.release = release;
    } catch (error) {
      await release();
      throw error;
    }
  }

  disconnect(): Promise<void> {
    return this.closing ??= this.close().finally(() => { this.closing = undefined; });
  }

  private async close(): Promise<void> {
    try { await this.opening; } finally {
      this.data = undefined;
      const release = this.release;
      this.release = undefined;
      await release?.();
    }
  }

  private snapshot(): GatewaySdkState {
    if (!this.data || this.closing) throw new Error('Gateway state is not connected.');
    this.file();
    const copy = jsonCopy(this.data);
    prune(copy);
    return copy;
  }

  private change<T>(fn: (state: GatewaySdkState) => T): T {
    const next = this.snapshot();
    const result = fn(next);
    writeJSON(this.file(), next);
    this.data = next;
    return result;
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.snapshot().values[hash(key)];
    return entry ? entry.value as T : null;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const entry = { value: jsonCopy(value), expiresAt: expires(ttlMs) };
    this.change((state) => { state.values[hash(key)] = entry; });
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    const entry = { value: jsonCopy(value), expiresAt: expires(ttlMs) };
    return this.change((state) => {
      const field = hash(key);
      if (Object.hasOwn(state.values, field)) return false;
      state.values[field] = entry;
      return true;
    });
  }

  async delete(key: string): Promise<void> {
    this.change((state) => { delete state.values[hash(key)]; delete state.lists[hash(key)]; });
  }

  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }): Promise<void> {
    const part = jsonCopy(value);
    const expiry = expires(options?.ttlMs);
    const max = options?.maxLength;
    if (max !== undefined && (!Number.isSafeInteger(max) || max < 1)) throw new Error('Invalid gateway list limit.');
    this.change((state) => {
      const field = hash(key);
      const values = [...(state.lists[field]?.values ?? []), part];
      state.lists[field] = { values: max === undefined ? values : values.slice(-max), expiresAt: expiry };
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    return (this.snapshot().lists[hash(key)]?.values ?? []) as T[];
  }

  async subscribe(threadId: string): Promise<void> {
    this.change((state) => { if (!state.subscriptions.includes(threadId)) state.subscriptions.push(threadId); });
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.change((state) => { state.subscriptions = state.subscriptions.filter((id) => id !== threadId); });
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return this.snapshot().subscriptions.includes(threadId);
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const expiresAt = expires(ttlMs)!;
    return this.change((state) => {
      const field = hash(threadId);
      if (state.locks[field]) return null;
      const lock = { threadId, token: crypto.randomUUID(), expiresAt };
      state.locks[field] = { ...lock };
      return lock;
    });
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const expiresAt = expires(ttlMs)!;
    return this.change((state) => {
      const current = state.locks[hash(lock.threadId)];
      if (!current || current.token !== lock.token) return false;
      current.expiresAt = expiresAt;
      return true;
    });
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.change((state) => {
      const field = hash(lock.threadId);
      if (state.locks[field]?.token === lock.token) delete state.locks[field];
    });
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.change((state) => { delete state.locks[hash(threadId)]; });
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) throw new Error('Invalid gateway queue limit.');
    if (!Number.isSafeInteger(entry.enqueuedAt) || !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt <= Date.now()) throw new Error('Invalid gateway queue lifetime.');
    const stored = jsonCopy({ enqueuedAt: entry.enqueuedAt, expiresAt: entry.expiresAt, message: entry.message.toJSON() });
    return this.change((state) => {
      const field = hash(threadId);
      const queue = state.queues[field] ?? [];
      // Refuse capacity exhaustion; durable input must not be silently dropped.
      if (queue.length >= maxSize) throw new Error('The gateway SDK queue is full. Retry this message.');
      queue.push(stored);
      state.queues[field] = queue;
      return queue.length;
    });
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    return this.change((state) => {
      const field = hash(threadId);
      const stored = state.queues[field]?.[0];
      if (!stored) return null;
      const entry = { enqueuedAt: stored.enqueuedAt, expiresAt: stored.expiresAt, message: Message.fromJSON(stored.message) };
      state.queues[field].shift();
      if (!state.queues[field].length) delete state.queues[field];
      return entry;
    });
  }

  async queueDepth(threadId: string): Promise<number> {
    return this.snapshot().queues[hash(threadId)]?.length ?? 0;
  }
}
