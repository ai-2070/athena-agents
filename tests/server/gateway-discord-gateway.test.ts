import fs from 'node:fs';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DiscordGateway,
  discordGatewayIntents,
  DiscordGatewayRetryError,
} from '../../server/gateways/discord-gateway.ts';
import { GatewaySetupError } from '../../server/gateways/telegram.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { gatewayConfig } from './gateway-fixtures.ts';
import type { GatewayDiscordState } from '../../shared/types.ts';

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
let account = 800000000000000000n;
type Wire = { op: number; d: Record<string, unknown> | number | null };
function send(socket: WebSocket, op: number, d: unknown, s?: number, t?: string): void {
  socket.send(JSON.stringify({ op, d, s, t }));
}
async function fixture() {
  const instance = saveGatewayInstance({
    ...gatewayConfig(String(account++)),
    platform: 'discord',
    senderPolicy: { platform: 'discord', allowedUserIds: [] },
    scope: { directMessages: true, conversationIds: [], guildIds: [] },
  });
  const state = new GatewayStateAdapter(instance.id);
  await state.connect();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('Missing fixture port.');
  const origin = `ws://127.0.0.1:${address.port}`;
  const clients: DiscordGateway[] = [];
  const sockets: WebSocket[] = [];
  const wire: Wire[] = [];
  const errors: Error[] = [];
  const received: { type: string; id: string; payload: unknown }[] = [];
  let interval = 200;
  let ack = true;
  let discovery = 0;
  let now = Date.now();
  let details: unknown = {
    url: origin,
    shards: 1,
    session_start_limit: { total: 1000, remaining: 999, reset_after: 10000, max_concurrency: 1 },
  };
  let intake = async (_type: string, _id: string, _payload: unknown, _signal: AbortSignal): Promise<void> => {};
  let authenticate = (socket: WebSocket, value: Wire) => {
    if (value.op === 2)
      send(
        socket,
        0,
        {
          v: 10,
          user: { id: instance.accountId, bot: true },
          session_id: 'PRIVATE_SESSION',
          resume_gateway_url: origin,
        },
        1,
        'READY',
      );
    else if (value.op === 6 && value.d && typeof value.d === 'object')
      send(socket, 0, {}, Number(value.d.seq) + 1, 'RESUMED');
  };
  server.on('connection', (socket, request) => {
    expect(request.url).toBe('/?v=10&encoding=json');
    sockets.push(socket);
    socket.on('message', (data) => {
      const value = JSON.parse(data.toString()) as Wire;
      wire.push(value);
      if (value.op === 1 && ack) send(socket, 11, null);
      if (value.op === 2 || value.op === 6) authenticate(socket, value);
    });
    send(socket, 10, { heartbeat_interval: interval });
  });
  const create = () => {
    const gateway = new DiscordGateway({
      state,
      accountId: instance.accountId,
      testOrigin: origin,
      now: () => now,
      random: () => 1,
      token: async () => 'PRIVATE_TOKEN',
      discover: async () => {
        discovery++;
        return details;
      },
      onDisconnect: (error) => errors.push(error),
      receive: async (type, id, payload, signal) => {
        received.push({ type, id, payload });
        await intake(type, id, payload, signal);
      },
    });
    clients.push(gateway);
    return gateway;
  };
  const saved = () => JSON.parse(fs.readFileSync(state.discordGatewayFile(), 'utf8')) as GatewayDiscordState;
  const start = async () => {
    const gateway = create();
    await gateway.start();
    return gateway;
  };
  closes.push(async () => {
    for (const client of clients) await client.stop();
    for (const socket of sockets) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await state.disconnect();
  });
  return {
    state,
    instance,
    server,
    sockets,
    wire,
    errors,
    received,
    origin,
    create,
    start,
    saved,
    discovery: () => discovery,
    intake: (handler: typeof intake) => {
      intake = handler;
    },
    auth: (handler: typeof authenticate) => {
      authenticate = handler;
    },
    interval: (value: number) => {
      interval = value;
    },
    ack: (value: boolean) => {
      ack = value;
    },
    details: (value: unknown) => {
      details = value;
    },
    advance: (value: number) => {
      now += value;
    },
  };
}

describe('Discord durable Gateway recovery', () => {
  it('identifies with explicit intents, stores private session state and resumes without another Identify', async () => {
    const f = await fixture();
    const first = await f.start();
    expect(first.alive).toBe(true);
    expect(f.wire.find((event) => event.op === 2)?.d).toMatchObject({
      token: 'PRIVATE_TOKEN',
      intents: discordGatewayIntents,
      compress: false,
      shard: [0, 1],
    });
    send(f.sockets[0], 0, { text: 'input' }, 2, 'MESSAGE_CREATE');
    await expect.poll(() => f.saved().session?.sequence).toBe(2);
    expect(JSON.stringify(f.saved())).not.toContain('PRIVATE_TOKEN');
    expect(f.received).toHaveLength(1);
    await first.stop();
    const second = await f.start();
    expect(second.alive).toBe(true);
    expect(f.discovery()).toBe(1);
    expect(f.wire.filter((event) => event.op === 2)).toHaveLength(1);
    expect(f.wire.find((event) => event.op === 6)?.d).toEqual({
      token: 'PRIVATE_TOKEN',
      session_id: 'PRIVATE_SESSION',
      seq: 2,
    });
    expect(f.saved().session?.sequence).toBe(3);
  });

  it('handles dispatches in order and keeps the resume cursor behind pending intake while heartbeat ACKs continue', async () => {
    const f = await fixture();
    f.interval(50);
    const gateway = await f.start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.intake(async () => gate);
    send(f.sockets[0], 0, { first: true }, 2, 'MESSAGE_CREATE');
    send(f.sockets[0], 0, { second: true }, 3, 'MESSAGE_UPDATE');
    await expect.poll(() => f.wire.filter((event) => event.op === 1).length).toBeGreaterThanOrEqual(2);
    expect(gateway.alive).toBe(true);
    expect(f.saved().session?.sequence).toBe(1);
    expect(f.received).toHaveLength(1);
    // Heartbeats follow Discord's last-received sequence; only Resume uses the durable cursor.
    expect(f.wire.filter((event) => event.op === 1).at(-1)?.d).toBe(3);
    release();
    await expect.poll(() => f.saved().session?.sequence).toBe(3);
    expect(f.received.map((event) => event.type)).toEqual(['MESSAGE_CREATE', 'MESSAGE_UPDATE']);
  });

  it('replays the same stable event ID after intake commits but the connection dies before its cursor write', async () => {
    const f = await fixture();
    const ids = new Set<string>();
    const gateway = await f.start();
    f.intake(async (_type, id, _payload, signal) => {
      ids.add(id);
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    send(f.sockets[0], 0, { text: 'committed' }, 2, 'MESSAGE_CREATE');
    await expect.poll(() => ids.size).toBe(1);
    await gateway.stop();
    expect(f.saved().session?.sequence).toBe(1);
    f.intake(async (_type, id) => {
      ids.add(id);
    });
    f.auth((socket, value) => {
      expect(value.op).toBe(6);
      send(socket, 0, { text: 'committed' }, 2, 'MESSAGE_CREATE');
      send(socket, 0, {}, 3, 'RESUMED');
    });
    await f.start();
    expect(f.saved().session?.sequence).toBe(3);
    expect(ids.size).toBe(1);
    expect(f.received).toHaveLength(2);
  });

  it('lets slow replay finish before RESUMED instead of treating active intake as an idle handshake', async () => {
    const f = await fixture();
    f.interval(20);
    const first = await f.start();
    await first.stop();
    const schedule = setTimeout;
    const timer = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((handler, delay, ...args) => schedule(handler, delay === 30000 ? 50 : delay, ...args));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.intake(async () => gate);
    f.auth((socket) => {
      send(socket, 0, {}, 2, 'MESSAGE_CREATE');
      send(socket, 0, {}, 3, 'RESUMED');
    });
    const second = f.create();
    const starting = second.start();
    try {
      await expect.poll(() => f.wire.filter((event) => event.op === 1).length).toBeGreaterThanOrEqual(4);
      expect(f.saved().session?.sequence).toBe(1);
      expect(f.errors).toHaveLength(1);
      release();
      await starting;
      expect(second.alive).toBe(true);
      expect(f.saved().session?.sequence).toBe(3);
    } finally {
      release();
      timer.mockRestore();
      await second.stop();
    }
  });

  it('does not advance after a failed inbox write or allow later queued work to bypass it', async () => {
    const f = await fixture();
    const gateway = await f.start();
    f.intake(async () => {
      throw new Error('PRIVATE_LOCAL_ERROR');
    });
    send(f.sockets[0], 0, {}, 2, 'MESSAGE_CREATE');
    send(f.sockets[0], 0, {}, 3, 'MESSAGE_CREATE');
    await expect.poll(() => gateway.alive).toBe(false);
    await gateway.stop();
    expect(f.saved().session?.sequence).toBe(1);
    expect(f.received).toHaveLength(1);
    expect(f.errors[0].message).not.toContain('PRIVATE_LOCAL_ERROR');
  });

  it('retains the old cursor when intake succeeds but saving the checkpoint fails', async () => {
    const f = await fixture();
    const first = await f.start();
    const committed = new Set<string>();
    f.intake(async (_type, id) => {
      committed.add(id);
    });
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (destination === f.state.discordGatewayFile()) throw new Error('PRIVATE_DISK_FAILURE');
      rename(source, destination);
    });
    try {
      send(f.sockets[0], 0, {}, 2, 'MESSAGE_CREATE');
      await expect.poll(() => first.alive).toBe(false);
      expect(committed.size).toBe(1);
      expect(f.saved().session?.sequence).toBe(1);
      expect(f.errors[0].message).not.toContain('PRIVATE_DISK_FAILURE');
    } finally {
      failure.mockRestore();
      await first.stop();
    }
    f.auth((socket) => {
      send(socket, 0, {}, 2, 'MESSAGE_CREATE');
      send(socket, 0, {}, 3, 'RESUMED');
    });
    await f.start();
    expect(committed.size).toBe(1);
    expect(f.saved().session?.sequence).toBe(3);
  });

  it('recovers a saved session after the state adapter is closed and reopened', async () => {
    const f = await fixture();
    const first = await f.start();
    await first.stop();
    await f.state.disconnect();
    await f.state.connect();
    await f.start();
    expect(f.wire.find((event) => event.op === 6)?.d).toMatchObject({ seq: 1 });
  });

  it('rejects overlapping clients even when they share the same connected state adapter', async () => {
    const f = await fixture();
    await f.start();
    await expect(f.create().start()).rejects.toThrow('already has a connection');
  });

  it('refreshes a preconstructed client and keeps its claim when an older client stops twice', async () => {
    const f = await fixture();
    const prepared = f.create();
    const first = await f.start();
    await first.stop();
    await prepared.start();
    await first.stop();
    await expect(f.create().start()).rejects.toThrow('already has a connection');
    expect(f.wire.filter((event) => event.op === 2)).toHaveLength(1);
    expect(f.wire.find((event) => event.op === 6)?.d).toMatchObject({ seq: 1 });
  });

  it('honors session start allowance and persists the retry deadline without opening a socket', async () => {
    const f = await fixture();
    f.details({
      url: f.origin,
      shards: 1,
      session_start_limit: { total: 1000, remaining: 0, reset_after: 20000, max_concurrency: 1 },
    });
    const gateway = f.create();
    await expect(gateway.start()).rejects.toBeInstanceOf(DiscordGatewayRetryError);
    await gateway.stop();
    expect(f.saved().retryAt).toBeGreaterThan(Date.now());
    await expect(f.create().start()).rejects.toBeInstanceOf(DiscordGatewayRetryError);
    expect(f.sockets).toHaveLength(0);
    expect(f.discovery()).toBe(1);
  });

  it('persists Identify spacing before sending even if READY never arrives', async () => {
    const f = await fixture();
    f.auth((socket) => socket.terminate());
    const first = f.create();
    await expect(first.start()).rejects.toThrow();
    await first.stop();
    expect(f.saved().identifiedAt).toBeDefined();
    await expect(f.create().start()).rejects.toBeInstanceOf(DiscordGatewayRetryError);
    expect(f.wire.filter((event) => event.op === 2)).toHaveLength(1);
  });

  it.each([4007, 4009, 1000, 1001])('retains a visible recovery gap after Discord close %s', async (code) => {
    const f = await fixture();
    const gateway = await f.start();
    f.sockets[0].close(code, 'PRIVATE_REASON');
    await expect.poll(() => f.saved().gap?.reason).toBe('session-lost');
    await gateway.stop();
    await expect(f.create().start()).rejects.toThrow('recovery gap');
    expect(f.saved().session?.sequence).toBe(1);
    expect(f.errors[0].message).not.toContain('PRIVATE_REASON');
    expect(f.discovery()).toBe(1);
  });

  it('stops rather than silently identifying when Invalid Session cannot resume', async () => {
    const f = await fixture();
    const gateway = await f.start();
    send(f.sockets[0], 9, false);
    await expect.poll(() => gateway.alive).toBe(false);
    await gateway.stop();
    expect(f.saved().gap?.reason).toBe('session-lost');
    await expect(f.create().start()).rejects.toThrow('recovery gap');
  });

  it.each([9, 4008])('persists the backoff for resumable Invalid Session or rate limit %s', async (op) => {
    const f = await fixture();
    const gateway = await f.start();
    if (op === 9) send(f.sockets[0], 9, true);
    else f.sockets[0].close(op);
    await expect.poll(() => gateway.alive).toBe(false);
    await gateway.stop();
    expect(f.saved().gap).toBeUndefined();
    const retry = f.create();
    await expect(retry.start()).rejects.toBeInstanceOf(DiscordGatewayRetryError);
    await retry.stop();
    f.advance(61000);
    await f.start();
    expect(f.discovery()).toBe(1);
  });

  it.each([4004, 4010, 4011, 4012, 4013, 4014])(
    'reports Discord setup failure %s without exposing provider details',
    async (code) => {
      const f = await fixture();
      const gateway = await f.start();
      f.sockets[0].close(code, 'PRIVATE_REASON');
      await expect.poll(() => gateway.alive).toBe(false);
      expect(f.errors[0]).toBeInstanceOf(GatewaySetupError);
      expect(f.errors[0].message).not.toContain('PRIVATE_REASON');
    },
  );

  it('keeps its resume cursor when Discord requests reconnect or stops heartbeat acknowledgements', async () => {
    const f = await fixture();
    f.interval(40);
    const first = await f.start();
    send(f.sockets[0], 7, null);
    await expect.poll(() => first.alive).toBe(false);
    await first.stop();
    expect(f.saved().gap).toBeUndefined();
    f.ack(false);
    const second = await f.start();
    await expect.poll(() => second.alive).toBe(false);
    expect(f.saved().session?.sequence).toBe(2);
    expect(f.errors.at(-1)?.message).toContain('heartbeats');
  });

  it('bounds queued dispatches and cancels the active intake without advancing the cursor', async () => {
    const f = await fixture();
    const gateway = await f.start();
    let canceled = false;
    f.intake(async (_type, _id, _payload, signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            canceled = true;
            resolve();
          },
          { once: true },
        );
      });
    });
    send(f.sockets[0], 0, {}, 2, 'MESSAGE_CREATE');
    await expect.poll(() => f.received.length).toBe(1);
    for (let seq = 3; seq < 40; seq++) send(f.sockets[0], 0, {}, seq, 'MESSAGE_CREATE');
    await expect.poll(() => gateway.alive).toBe(false);
    await gateway.stop();
    expect(canceled).toBe(true);
    expect(f.saved().session?.sequence).toBe(1);
    expect(f.received).toHaveLength(1);
  });

  it.each([
    '{broken',
    JSON.stringify({ op: 0, s: 1, t: 'MESSAGE_CREATE', d: {} }),
    JSON.stringify({ op: 0, s: -2, t: 'MESSAGE_CREATE', d: {} }),
  ])('rejects malformed or nonincreasing events without changing recovery: %s', async (text) => {
    const f = await fixture();
    const gateway = await f.start();
    f.sockets[0].send(text);
    await expect.poll(() => gateway.alive).toBe(false);
    expect(f.saved().session?.sequence).toBe(1);
  });

  it('bounds buffered bytes and rejects binary frames without advancing past slow intake', async () => {
    const f = await fixture();
    const first = await f.start();
    f.intake(
      async (_type, _id, _payload, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    );
    send(f.sockets[0], 0, {}, 2, 'MESSAGE_CREATE');
    await expect.poll(() => f.received.length).toBe(1);
    for (let sequence = 3; sequence < 14; sequence++)
      send(f.sockets[0], 0, 'x'.repeat(1024 * 1024), sequence, 'MESSAGE_CREATE');
    await expect.poll(() => first.alive).toBe(false);
    await first.stop();
    expect(f.saved().session?.sequence).toBe(1);
    const second = await f.start();
    f.sockets[1].send(Buffer.from('{}'));
    await expect.poll(() => second.alive).toBe(false);
    expect(f.saved().session?.sequence).toBe(2);
  });

  it('accepts Discord regional resume hosts without opening an external connection', async () => {
    const f = await fixture();
    const first = await f.start();
    await first.stop();
    fs.writeFileSync(
      f.state.discordGatewayFile(),
      JSON.stringify({ ...f.saved(), session: { ...f.saved().session, url: 'wss://gateway-us-east1-b.discord.gg/' } }),
    );
    expect(() => f.create()).not.toThrow();
  });

  it('does not replace corrupted, foreign-account or off-origin session state', async () => {
    const f = await fixture();
    const gateway = await f.start();
    await gateway.stop();
    const original = f.saved();
    for (const value of [
      '{broken',
      JSON.stringify({ ...original, accountId: '999' }),
      JSON.stringify({ ...original, session: { ...original.session, url: 'wss://steal.invalid/' } }),
    ]) {
      fs.writeFileSync(f.state.discordGatewayFile(), value);
      expect(() => f.create()).toThrow();
      expect(fs.readFileSync(f.state.discordGatewayFile(), 'utf8')).toBe(value);
    }
  });

  it.each([
    'wss://steal.invalid/',
    'wss://gateway.discord.gg.evil.invalid/',
    'wss://gateway.discord.gg/?token=secret',
    'ws://gateway.discord.gg/',
    'wss://user:secret@gateway.discord.gg/',
  ])('refuses an untrusted discovery URL %s before opening a socket', async (url) => {
    const f = await fixture();
    f.details({ url, shards: 1, session_start_limit: { total: 1, remaining: 1, reset_after: 0, max_concurrency: 1 } });
    await expect(f.create().start()).rejects.toThrow('address');
    expect(f.sockets).toHaveLength(0);
  });

  it.each(['identity', 'resume-url'])('refuses READY with the wrong %s before saving any session', async (reason) => {
    const f = await fixture();
    f.auth((socket) =>
      send(
        socket,
        0,
        {
          v: 10,
          user: { id: reason === 'identity' ? '999' : f.instance.accountId, bot: true },
          session_id: 'SECRET_SESSION',
          resume_gateway_url: reason === 'resume-url' ? 'wss://steal.invalid/' : f.origin,
        },
        1,
        'READY',
      ),
    );
    await expect(f.create().start()).rejects.toThrow();
    expect(f.saved().session).toBeUndefined();
    expect(f.received).toHaveLength(0);
  });

  it('does not start a bot that requires multiple shards', async () => {
    const f = await fixture();
    f.details({
      url: f.origin,
      shards: 2,
      session_start_limit: { total: 1, remaining: 1, reset_after: 0, max_concurrency: 1 },
    });
    await expect(f.create().start()).rejects.toThrow('multiple shards');
    expect(f.sockets).toHaveLength(0);
  });
});
