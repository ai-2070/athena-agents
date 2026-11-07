import { z } from 'zod';
import type { GatewayWhatsAppRelayEnvelope, GatewayWhatsAppRelayLimits, GatewayWhatsAppRelayState, GatewayWhatsAppRelayStatus } from '../../shared/types.ts';
import { base64, boundedBody, checkAccount, configuration, constantEqual, digest, errorResponse, fail, json, parseJSON, randomKey, stateSchema, verifyMeta } from './protocol.ts';
import type { RelayEnv } from './protocol.ts';

const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const epoch = z.uuid(); const hash = z.string().regex(/^[a-f0-9]{64}$/);
const queueName = 'whatsapp-v1';
const envelopeSchema: z.ZodType<GatewayWhatsAppRelayEnvelope> = z.object({ sequence, id: hash, receivedAt: sequence, expiresAt: sequence,
  bodyBase64: z.string(), signature: z.string(), contentType: z.string().max(200) });
const routes: Record<string, string[]> = {
  '/webhooks/meta': ['GET', 'POST'], '/health': ['GET'], '/admin/pairing': ['POST'], '/admin/revoke': ['POST'], '/admin/recovery': ['POST'],
  '/v1/pair': ['POST'], '/v1/status': ['GET'], '/v1/claim': ['POST'], '/v1/release': ['POST'], '/v1/pull': ['GET'], '/v1/ack': ['POST'],
};
interface Prepared {
  path: string;
  body: unknown;
  tokenHash: string;
  leaseHash: string;
  pairingCode?: string;
  pairingHash?: string;
  clientToken?: string;
  clientHash?: string;
  leaseToken?: string;
  newLeaseHash?: string;
  envelope?: Omit<GatewayWhatsAppRelayEnvelope, 'sequence' | 'receivedAt' | 'expiresAt'> & { bytes: number };
}

function checked<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); return result.success ? result.data : fail(400, 'invalid_request');
}
function bearer(request: Request): string {
  const value = request.headers.get('authorization') ?? ''; return /^Bearer [a-f0-9]{64}$/.test(value) ? value.slice(7) : fail(401, 'unauthorized');
}

export class WhatsAppRelayQueue {
  private readonly ctx: DurableObjectState;
  private readonly env: RelayEnv;
  private readonly limits: GatewayWhatsAppRelayLimits;
  constructor(ctx: DurableObjectState, env: RelayEnv) {
    this.ctx = ctx; this.env = env; this.limits = configuration(env);
    ctx.storage.transactionSync(() => {
      ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS envelopes (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, received_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL, body TEXT NOT NULL, signature TEXT NOT NULL, content_type TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS envelopes_expiry ON envelopes(expires_at);
        CREATE TABLE IF NOT EXISTS replay (id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS replay_expiry ON replay(expires_at);
        CREATE TABLE IF NOT EXISTS reviews (at INTEGER NOT NULL, kind TEXT NOT NULL, through INTEGER NOT NULL);`);
      if (!ctx.storage.sql.exec('SELECT data FROM metadata WHERE id = 1').toArray().length) {
        this.write({ version: 1, installationId: crypto.randomUUID(), businessAccountId: env.BUSINESS_ACCOUNT_ID, phoneNumberId: env.PHONE_NUMBER_ID,
          epoch: crypto.randomUUID(), nextSequence: 1, cursor: 0, lastAckId: null, lastReceivedAt: 0, lostThrough: 0, gapAt: null,
          tokenHash: null, pairingHash: null, pairingExpiresAt: 0, leaseHash: null, leaseConsumer: null, leaseExpiresAt: 0, deliveredThrough: 0 });
      }
      this.read();
    });
  }
  private read(): GatewayWhatsAppRelayState {
    const row = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM metadata WHERE id = 1').one();
    const state = stateSchema.parse(JSON.parse(row.data) as unknown);
    if (state.businessAccountId !== this.env.BUSINESS_ACCOUNT_ID || state.phoneNumberId !== this.env.PHONE_NUMBER_ID) return fail(503, 'account_changed');
    return state;
  }
  private write(state: GatewayWhatsAppRelayState): void {
    this.ctx.storage.sql.exec('INSERT INTO metadata (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data', JSON.stringify(stateSchema.parse(state)));
  }
  private prune(state: GatewayWhatsAppRelayState, now: number): void {
    const expired = this.ctx.storage.sql.exec<{ through: number | null }>('SELECT MAX(sequence) AS through FROM envelopes WHERE expires_at <= ?', now).one().through;
    if (expired !== null && expired > state.cursor) { state.lostThrough = Math.max(state.lostThrough, expired); state.gapAt ??= now; }
    this.ctx.storage.sql.exec('DELETE FROM envelopes WHERE expires_at <= ?', now);
    this.ctx.storage.sql.exec('DELETE FROM replay WHERE expires_at <= ?', now);
    if (state.pairingExpiresAt <= now) { state.pairingHash = null; state.pairingExpiresAt = 0; }
    if (state.leaseExpiresAt <= now) { state.leaseHash = null; state.leaseConsumer = null; state.leaseExpiresAt = 0; state.deliveredThrough = state.cursor; }
  }
  private earliestExpiry(): number | null {
    const expires = this.ctx.storage.sql.exec<{ expires: number | null }>('SELECT MIN(expires_at) AS expires FROM (SELECT expires_at FROM envelopes UNION ALL SELECT expires_at FROM replay)').one().expires;
    const pairing = this.read().pairingExpiresAt;
    return pairing ? Math.min(expires ?? pairing, pairing) : expires;
  }
  private async schedule(extra?: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm(); const next = this.earliestExpiry();
    const candidates = [existing, next, extra].filter((value): value is number => value !== null && value !== undefined);
    if (candidates.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, Math.min(...candidates)));
  }
  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => { const state = this.read(); this.prune(state, Date.now()); this.write(state); });
      const next = this.earliestExpiry(); if (next !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
      await this.ctx.storage.sync();
    });
  }
  private summary(state: GatewayWhatsAppRelayState): GatewayWhatsAppRelayStatus {
    const count = this.ctx.storage.sql.exec<{ count: number; bytes: number }>('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM envelopes').one();
    return { version: 1, installationId: state.installationId, businessAccountId: state.businessAccountId, phoneNumberId: state.phoneNumberId, epoch: state.epoch,
      cursor: state.cursor, gap: state.cursor < state.lostThrough ? { at: state.gapAt!, through: state.lostThrough } : null,
      limits: this.limits, queuedEvents: count.count, queuedBytes: count.bytes };
  }
  private auth(state: GatewayWhatsAppRelayState, prepared: Prepared, needsLease = false): void {
    if (!state.tokenHash || !constantEqual(state.tokenHash, prepared.tokenHash)) return fail(401, 'unauthorized');
    if (needsLease && (!state.leaseHash || state.leaseExpiresAt <= Date.now() || !constantEqual(state.leaseHash, prepared.leaseHash))) return fail(409, 'lease_required');
  }
  private checkEpoch(state: GatewayWhatsAppRelayState, value: string): void {
    if (state.epoch !== value) return fail(409, 'epoch_changed');
  }
  private audit(kind: string, through: number): void {
    this.ctx.storage.sql.exec('INSERT INTO reviews (at, kind, through) VALUES (?, ?, ?)', Date.now(), kind, through);
    this.ctx.storage.sql.exec('DELETE FROM reviews WHERE rowid NOT IN (SELECT rowid FROM reviews ORDER BY rowid DESC LIMIT 100)');
  }

  private async prepare(request: Request): Promise<Prepared> {
    const url = new URL(request.url); const path = url.pathname;
    const prepared: Prepared = { path, body: {}, tokenHash: '', leaseHash: '' };
    if (path.startsWith('/admin/')) {
      const token = request.headers.get('authorization') ?? '';
      if (!constantEqual(await digest(token), await digest(`Bearer ${this.env.RELAY_ADMIN_KEY}`))) return fail(401, 'unauthorized');
    } else if (path.startsWith('/v1/') && path !== '/v1/pair') {
      prepared.tokenHash = await digest(bearer(request));
      this.auth(this.read(), prepared);
      const lease = request.headers.get('x-relay-lease') ?? '';
      prepared.leaseHash = /^[a-f0-9]{64}$/.test(lease) ? await digest(lease) : '';
    }
    if (path === '/webhooks/meta') {
      if (request.headers.get('content-encoding') && request.headers.get('content-encoding') !== 'identity') return fail(415, 'unsupported_encoding');
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail(415, 'json_required');
      if ((request.headers.get('content-type')?.length ?? 0) > 200) return fail(415, 'json_required');
      const signature = request.headers.get('x-hub-signature-256') ?? ''; const raw = await boundedBody(request, this.limits.bodyBytes);
      if (!await verifyMeta(raw, signature, this.env.META_APP_SECRET)) return fail(401, 'invalid_signature');
      checkAccount(raw, this.env); const bodyBase64 = base64(raw);
      prepared.envelope = { id: await digest(bodyBase64), bodyBase64, signature, contentType: request.headers.get('content-type')!, bytes: raw.byteLength };
    } else if (request.method === 'POST') {
      if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return fail(415, 'json_required');
      prepared.body = parseJSON(await boundedBody(request, 2048));
    }
    if (path === '/admin/pairing') { prepared.pairingCode = randomKey(); prepared.pairingHash = await digest(prepared.pairingCode); }
    if (path === '/v1/pair') {
      const { code } = checked(z.strictObject({ code: hash }), prepared.body); prepared.pairingHash = await digest(code);
      prepared.clientToken = randomKey(); prepared.clientHash = await digest(prepared.clientToken);
    }
    if (path === '/v1/claim') { prepared.leaseToken = randomKey(); prepared.newLeaseHash = await digest(prepared.leaseToken); }
    if (request.method === 'GET') {
      if (path === '/v1/pull') {
        if ([...url.searchParams.keys()].some((key) => !['epoch', 'after', 'limit'].includes(key)) || [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)) return fail(400, 'invalid_request');
        prepared.body = { epoch: url.searchParams.get('epoch'), after: url.searchParams.get('after'), limit: url.searchParams.get('limit') ?? '20' };
      } else if (url.search) return fail(400, 'invalid_request');
    }
    return prepared;
  }

  private apply(prepared: Prepared): Response {
    const state = this.read(); const now = Date.now(); const path = prepared.path;
    if (path === '/webhooks/meta') {
      if (!state.tokenHash) return fail(503, 'not_paired');
      const envelope = prepared.envelope!;
      const duplicate = this.ctx.storage.sql.exec('SELECT id FROM replay WHERE id = ?', envelope.id).toArray();
      if (duplicate.length) return json({ accepted: true });
      const count = this.summary(state);
      const replay = this.ctx.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM replay').one().count;
      if (count.queuedEvents >= this.limits.queueEvents || count.queuedBytes + envelope.bytes > this.limits.queueBytes || replay >= this.limits.replayEntries) return fail(503, 'relay_full');
      if (state.nextSequence >= Number.MAX_SAFE_INTEGER - 1) return fail(503, 'sequence_limit');
      const receivedAt = Math.max(now, state.lastReceivedAt); const sequence = state.nextSequence++;
      this.ctx.storage.sql.exec('INSERT INTO envelopes (sequence, id, received_at, expires_at, bytes, body, signature, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', sequence, envelope.id, receivedAt, receivedAt + this.limits.retentionMs, envelope.bytes, envelope.bodyBase64, envelope.signature, envelope.contentType);
      this.ctx.storage.sql.exec('INSERT INTO replay (id, sequence, expires_at) VALUES (?, ?, ?)', envelope.id, sequence, receivedAt + this.limits.replayMs);
      state.lastReceivedAt = receivedAt; this.write(state); return json({ accepted: true });
    }
    if (path === '/admin/pairing') {
      const body = checked(z.strictObject({ replacePending: z.boolean().optional() }), prepared.body);
      if (state.tokenHash || (state.pairingHash && !body.replacePending)) return fail(409, 'already_paired_or_pending');
      state.pairingHash = prepared.pairingHash!; state.pairingExpiresAt = now + this.limits.pairingMs; this.write(state);
      return json({ version: 1, code: prepared.pairingCode, expiresAt: state.pairingExpiresAt, businessAccountId: state.businessAccountId, phoneNumberId: state.phoneNumberId });
    }
    if (path === '/admin/revoke') {
      checked(z.strictObject({ acknowledgeDrop: z.literal(true) }), prepared.body);
      this.audit('revoke', state.nextSequence - 1); this.ctx.storage.sql.exec('DELETE FROM envelopes');
      state.epoch = crypto.randomUUID(); state.cursor = state.nextSequence - 1; state.lastAckId = null; state.lostThrough = state.cursor; state.gapAt = null;
      state.tokenHash = null; state.pairingHash = null; state.pairingExpiresAt = 0; state.leaseHash = null; state.leaseConsumer = null; state.leaseExpiresAt = 0; state.deliveredThrough = state.cursor;
      this.write(state); return json({ revoked: true });
    }
    if (path === '/admin/recovery') {
      const body = checked(z.strictObject({ epoch, through: sequence, acknowledgeGap: z.literal(true) }), prepared.body);
      this.checkEpoch(state, body.epoch);
      if (state.cursor >= state.lostThrough || body.through !== state.lostThrough) return fail(409, 'gap_changed');
      this.audit('gap', state.lostThrough); this.ctx.storage.sql.exec('DELETE FROM envelopes WHERE sequence <= ?', state.lostThrough); state.cursor = state.lostThrough; state.lastAckId = null; state.gapAt = null;
      state.leaseHash = null; state.leaseConsumer = null; state.leaseExpiresAt = 0; state.deliveredThrough = state.cursor;
      this.write(state); return json({ reviewed: true });
    }
    if (path === '/v1/pair') {
      if (state.tokenHash || !state.pairingHash || state.pairingExpiresAt <= now || !constantEqual(state.pairingHash, prepared.pairingHash!)) return fail(403, 'pairing_refused');
      state.tokenHash = prepared.clientHash!; state.pairingHash = null; state.pairingExpiresAt = 0; this.write(state);
      return json({ ...this.summary(state), token: prepared.clientToken });
    }
    this.auth(state, prepared);
    if (path === '/v1/status') return json(this.summary(state));
    if (path === '/v1/claim') {
      const body = checked(z.strictObject({ epoch, consumerId: z.uuid() }), prepared.body); this.checkEpoch(state, body.epoch);
      if (state.cursor < state.lostThrough) return fail(410, 'retention_gap');
      if (state.leaseHash && state.leaseExpiresAt > now) return fail(409, 'already_claimed');
      state.leaseHash = prepared.newLeaseHash!; state.leaseConsumer = body.consumerId; state.leaseExpiresAt = now + this.limits.leaseMs; state.deliveredThrough = state.cursor; this.write(state);
      return json({ epoch: state.epoch, lease: prepared.leaseToken, expiresAt: state.leaseExpiresAt, cursor: state.cursor });
    }
    this.auth(state, prepared, true);
    if (path === '/v1/release') {
      const body = checked(z.strictObject({ epoch }), prepared.body); this.checkEpoch(state, body.epoch);
      state.leaseHash = null; state.leaseConsumer = null; state.leaseExpiresAt = 0; state.deliveredThrough = state.cursor; this.write(state); return json({ released: true });
    }
    if (path === '/v1/pull') {
      const body = checked(z.strictObject({ epoch, after: z.string().regex(/^\d{1,16}$/).transform(Number).pipe(sequence), limit: z.string().regex(/^\d{1,2}$/).transform(Number).pipe(z.number().int().min(1).max(this.limits.batchEvents)) }), prepared.body);
      this.checkEpoch(state, body.epoch); if (state.cursor < state.lostThrough) return fail(410, 'retention_gap');
      if (body.after !== state.cursor) return fail(409, 'cursor_changed');
      const rows = this.ctx.storage.sql.exec(`SELECT sequence, id, received_at AS receivedAt, expires_at AS expiresAt, body AS bodyBase64, signature, content_type AS contentType FROM envelopes WHERE sequence > ? ORDER BY sequence LIMIT ?`, state.cursor, body.limit);
      const envelopes: GatewayWhatsAppRelayEnvelope[] = []; let bytes = 2048;
      for (const row of rows) { const envelope = envelopeSchema.parse(row); const size = new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
        if (bytes + size > this.limits.batchBytes) break; bytes += size; envelopes.push(envelope);
      }
      state.deliveredThrough = Math.max(state.deliveredThrough, envelopes.at(-1)?.sequence ?? state.cursor); state.leaseExpiresAt = now + this.limits.leaseMs; this.write(state);
      return json({ ...this.summary(state), envelopes, leaseExpiresAt: state.leaseExpiresAt });
    }
    if (path === '/v1/ack') {
      const body = checked(z.strictObject({ epoch, through: sequence, eventId: hash }), prepared.body); this.checkEpoch(state, body.epoch);
      if (state.cursor < state.lostThrough) return fail(410, 'retention_gap');
      if (body.through === state.cursor && state.lastAckId === body.eventId) { state.leaseExpiresAt = now + this.limits.leaseMs; this.write(state); return json({ cursor: state.cursor }); }
      if (body.through <= state.cursor || body.through > state.deliveredThrough) return fail(409, 'ack_not_delivered');
      const delivered = this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM envelopes WHERE sequence = ?', body.through).toArray()[0];
      if (!delivered || delivered.id !== body.eventId) return fail(409, 'ack_not_delivered');
      this.ctx.storage.sql.exec('DELETE FROM envelopes WHERE sequence <= ?', body.through);
      state.cursor = body.through; state.lastAckId = body.eventId; state.leaseExpiresAt = now + this.limits.leaseMs; this.write(state); return json({ cursor: state.cursor });
    }
    return fail(404, 'not_found');
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const prepared = await this.prepare(request);
      return await this.ctx.blockConcurrencyWhile(async () => {
        try {
          // Install the cleanup alarm before accepting data, including if the process dies after commit.
          const extra = prepared.envelope ? Date.now() + this.limits.retentionMs : prepared.pairingCode ? Date.now() + this.limits.pairingMs : undefined;
          await this.schedule(extra);
          this.ctx.storage.transactionSync(() => { const state = this.read(); this.prune(state, Date.now()); this.write(state); });
          const response = this.ctx.storage.transactionSync(() => this.apply(prepared));
          await this.ctx.storage.sync(); return response;
        } catch (error) { return errorResponse(error); }
      });
    } catch (error) { return errorResponse(error); }
  }
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    try {
      configuration(env); const url = new URL(request.url);
      if (url.protocol !== 'https:') return fail(400, 'https_required');
      if (!routes[url.pathname]) return fail(404, 'not_found');
      if (!routes[url.pathname].includes(request.method)) return fail(405, 'method_not_allowed');
      if (request.headers.has('origin') || request.headers.get('sec-fetch-site') === 'cross-site') return fail(403, 'browser_request_refused');
      if (url.pathname === '/health') return json({ ok: true, version: 1 });
      if (url.pathname === '/webhooks/meta' && request.method === 'GET') {
        if (url.searchParams.get('hub.mode') !== 'subscribe' || !constantEqual(await digest(url.searchParams.get('hub.verify_token') ?? ''), await digest(env.META_VERIFY_TOKEN))) return fail(403, 'verification_refused');
        const challenge = url.searchParams.get('hub.challenge') ?? ''; if (!/^\d{1,512}$/.test(challenge)) return fail(400, 'invalid_challenge');
        return new Response(challenge, { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
      }
      if (url.pathname !== '/v1/pull' && url.search) return fail(400, 'invalid_request');
      return await env.QUEUE.getByName(queueName).fetch(request);
    } catch (error) { return errorResponse(error); }
  },
} satisfies ExportedHandler<RelayEnv>;
