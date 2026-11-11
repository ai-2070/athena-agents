import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayWhatsAppPairing } from '../../shared/types.ts';
import { getGatewaySecrets, setGatewaySecrets } from '../../server/store.ts';
import { dataPath } from '../../server/util.ts';
import {
  gatewayCredentialStatus,
  getGatewayInstance,
  removeGatewayInstance,
  saveGatewayCredentials,
  saveGatewayInstance,
  updateGatewayCredentials,
} from '../../server/gateways/instances.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import {
  finishWhatsAppPairing,
  pairWhatsApp,
  reviewWhatsAppPairing,
  whatsAppSetup,
} from '../../server/gateways/whatsapp-setup.ts';
import { whatsAppTransport } from '../../server/gateways/whatsapp-transport.ts';
import { gatewayConfig } from './gateway-fixtures.ts';

type PairRequest = (url: string, init: RequestInit) => Promise<Response>;
const ORIGIN = 'https://relay.example';
const BUSINESS = '9000000001';
const CODE = 'a'.repeat(64);
const TOKEN = 'b'.repeat(64);
const EPOCH = '00000000-0000-4000-8000-000000000001';
const INSTALLATION = '00000000-0000-4000-8000-000000000002';
const limits = {
  bodyBytes: 1048576,
  queueBytes: 16777216,
  queueEvents: 1000,
  replayEntries: 10000,
  retentionMs: 259200000,
  replayMs: 604800000,
  pairingMs: 600000,
  leaseMs: 60000,
  batchBytes: 2097152,
  batchEvents: 20,
};
const closes: (() => Promise<void>)[] = [];
let accounts = 9500000000;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture() {
  const config = {
    ...gatewayConfig(String(accounts++)),
    name: 'WhatsApp setup',
    platform: 'whatsapp',
    enabled: false,
    senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436641234567'] },
    scope: { directMessages: true, conversationIds: [], guildIds: [] },
  };
  const instance = saveGatewayInstance(config);
  saveGatewayCredentials(instance.id, { accessToken: 'PRIVATE_ACCESS_TOKEN', signingSecret: 'PRIVATE_APP_SECRET' });
  const state = new GatewayStateAdapter(instance.id);
  await state.connect();
  closes.push(() => state.disconnect());
  const inbox = new GatewayInbox(state);
  const connection = {
    origin: ORIGIN,
    installationId: INSTALLATION,
    businessAccountId: BUSINESS,
    phoneNumberId: instance.accountId,
    epoch: EPOCH,
  };
  const body = { origin: ORIGIN, businessAccountId: BUSINESS, code: CODE, acknowledgeStart: true };
  const status = {
    version: 1,
    installationId: INSTALLATION,
    businessAccountId: BUSINESS,
    phoneNumberId: instance.accountId,
    epoch: EPOCH,
    cursor: 0,
    gap: null,
    limits,
    queuedEvents: 0,
    queuedBytes: 0,
    token: TOKEN,
  };
  const calls: string[] = [];
  const request: PairRequest = async (url, init) => {
    calls.push(String(url));
    expect(String(url)).toBe(`${ORIGIN}/v1/pair`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store' });
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(JSON.parse(String(init?.body))).toEqual({ code: CODE });
    expect(getGatewaySecrets(instance.id).whatsappPairing).toMatchObject({ phase: 'requesting', origin: ORIGIN });
    expect(inbox.whatsAppRelayState()).toBeUndefined();
    return Response.json(status);
  };
  const preview = () => whatsAppSetup(instance.id);
  const received = (gap = false): GatewayWhatsAppPairing => ({
    phase: 'received',
    attemptId: crypto.randomUUID(),
    connection,
    cursor: 0,
    gap,
  });
  return { config, instance, state, inbox, connection, body, status, calls, request, preview, received };
}

describe('paused WhatsApp pairing', () => {
  it('exchanges once, pins the account and cursor, keeps keys private and leaves the instance paused', async () => {
    const f = await fixture();
    expect(f.preview()).toEqual({ paired: false, pending: null, recoveryRequired: false });
    expect(await pairWhatsApp(f.inbox, { ...f.body, origin: ORIGIN + '/' }, { request: f.request })).toEqual({
      paired: true,
      pending: null,
      recoveryRequired: false,
    });
    expect(f.inbox.whatsAppRelayState()).toEqual({ epoch: EPOCH, cursor: 0, connection: f.connection });
    expect(f.calls).toHaveLength(1);
    expect(getGatewaySecrets(f.instance.id)).toEqual({
      accessToken: 'PRIVATE_ACCESS_TOKEN',
      signingSecret: 'PRIVATE_APP_SECRET',
      relayKey: TOKEN,
    });
    expect(gatewayCredentialStatus(f.instance.id)).toEqual({ accessToken: true, signingSecret: true, relayKey: true });
    expect(getGatewayInstance(f.instance.id).enabled).toBe(false);
    const disk = fs.readFileSync(f.state.inboxFile(), 'utf8');
    for (const secret of [CODE, TOKEN, 'PRIVATE_']) expect(disk).not.toContain(secret);
    await expect(pairWhatsApp(f.inbox, f.body, { request: f.request })).rejects.toThrow('saved WhatsApp pairing');
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    'http://relay.example',
    'https://user:PRIVATE@relay.example',
    'https://relay.example/path',
    'https://relay.example?key=PRIVATE',
    'https://relay.example#PRIVATE',
  ])('refuses an unsafe origin %s before saving or sending the code', async (origin) => {
    const f = await fixture();
    await expect(pairWhatsApp(f.inbox, { ...f.body, origin }, { request: f.request })).rejects.toThrow('HTTPS');
    expect(f.calls).toEqual([]);
    expect(f.preview().pending).toBeNull();
  });

  it('requires explicit acknowledgement and refuses enabled, foreign-platform or previously bound instances', async () => {
    const f = await fixture();
    for (const body of [
      { ...f.body, acknowledgeStart: false },
      { ...f.body, extra: 'PRIVATE' },
      { ...f.body, code: 'PRIVATE' },
    ])
      await expect(pairWhatsApp(f.inbox, body, { request: f.request })).rejects.toThrow();
    saveGatewayInstance({ ...f.config, enabled: true }, f.instance.id);
    await expect(pairWhatsApp(f.inbox, f.body, { request: f.request })).rejects.toThrow('Pause');
    saveGatewayInstance(f.config, f.instance.id);
    f.inbox.bindWhatsAppRelayConnection(f.connection, 0);
    await expect(pairWhatsApp(f.inbox, f.body, { request: f.request })).rejects.toThrow('no saved pairing');
    expect(f.calls).toEqual([]);
    const telegram = saveGatewayInstance(gatewayConfig(String(accounts++)));
    expect(() => whatsAppSetup(telegram.id)).toThrow('WhatsApp');
  });

  it('rejects an invalid paused phone ID before consuming a one-use code', async () => {
    const f = await fixture();
    const instance = saveGatewayInstance({ ...f.config, accountId: `bad-phone-${accounts}` });
    const state = new GatewayStateAdapter(instance.id);
    await state.connect();
    closes.push(() => state.disconnect());
    await expect(pairWhatsApp(new GatewayInbox(state), f.body, { request: f.request })).rejects.toThrow(
      'numeric WhatsApp',
    );
    expect(f.calls).toEqual([]);
  });

  it.each([
    'network',
    '202',
    '401',
    '429',
    '503',
    'html',
    'size',
    'bytes',
    'utf8',
    'redirect',
    'account',
    'business',
    'token',
    'json',
  ])('holds an unknown %s outcome without retrying or leaking the response', async (kind) => {
    const f = await fixture();
    let count = 0;
    const request: PairRequest = async () => {
      count++;
      if (kind === 'network') throw new Error('PRIVATE_NETWORK_DETAILS');
      if (/^\d+$/.test(kind)) return Response.json({ error: 'PRIVATE_PROVIDER_DETAILS' }, { status: Number(kind) });
      if (kind === 'redirect') return Response.redirect('https://steal.example/PRIVATE', 302);
      if (kind === 'html') return new Response('PRIVATE_HTML');
      if (kind === 'size')
        return new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '65537' } });
      if (kind === 'bytes') return new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } });
      if (kind === 'utf8') return new Response(Buffer.from([255]), { headers: { 'content-type': 'application/json' } });
      if (kind === 'json') return new Response('PRIVATE_JSON', { headers: { 'content-type': 'application/json' } });
      return Response.json({
        ...f.status,
        ...(kind === 'account'
          ? { phoneNumberId: '999' }
          : kind === 'business'
            ? { businessAccountId: '999' }
            : { token: 'PRIVATE_BAD_TOKEN' }),
      });
    };
    await expect(pairWhatsApp(f.inbox, f.body, { request })).rejects.not.toThrow('PRIVATE_');
    expect(f.preview()).toMatchObject({ paired: false, pending: { phase: 'requesting' }, recoveryRequired: true });
    await expect(pairWhatsApp(f.inbox, f.body, { request })).rejects.toThrow('saved WhatsApp pairing');
    expect(count).toBe(1);
    expect(getGatewaySecrets(f.instance.id).relayKey).toBeUndefined();
    expect(JSON.stringify(getGatewaySecrets(f.instance.id))).not.toContain(CODE);
    expect(JSON.stringify(f.preview())).not.toContain(ORIGIN);
    expect(JSON.stringify(f.preview())).not.toContain(TOKEN);
  });

  it('does not exchange when the initial attempt cannot be saved', async () => {
    const f = await fixture();
    const write = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).includes('gateway-secrets.json')) throw new Error('PRIVATE_DISK');
      return write(file, ...args);
    });
    await expect(pairWhatsApp(f.inbox, f.body, { request: f.request })).rejects.toThrow('local storage');
    expect(f.calls).toEqual([]);
  });

  it('finishes a saved received key after inbox write failure and restart without another exchange', async () => {
    const f = await fixture();
    const write = fs.writeFileSync.bind(fs);
    const fault = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).includes('inbox.json')) throw new Error('PRIVATE_DISK');
      return write(file, ...args);
    });
    await expect(pairWhatsApp(f.inbox, f.body, { request: f.request })).rejects.toThrow('could not be bound');
    fault.mockRestore();
    expect(getGatewaySecrets(f.instance.id).relayKey).toBe(TOKEN);
    expect(f.preview().pending?.phase).toBe('received');
    expect(gatewayCredentialStatus(f.instance.id)).not.toHaveProperty('whatsappPairing');
    const body = { revision: f.preview().pending!.revision };
    await f.state.disconnect();
    await f.state.connect();
    expect(finishWhatsAppPairing(new GatewayInbox(f.state), body)).toEqual({
      paired: true,
      pending: null,
      recoveryRequired: false,
    });
    expect(f.calls).toHaveLength(1);
    expect(() => finishWhatsAppPairing(f.inbox, body)).toThrow('changed');
  });

  it('finishes idempotently if a crash left the exact inbox binding and received receipt', async () => {
    const f = await fixture();
    const pending = f.received(true);
    setGatewaySecrets(f.instance.id, {
      ...getGatewaySecrets(f.instance.id),
      relayKey: TOKEN,
      whatsappPairing: pending,
    });
    f.inbox.finishWhatsAppPairing(f.connection, 0, true);
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    expect(finishWhatsAppPairing(f.inbox, { revision: f.preview().pending!.revision })).toEqual({
      paired: true,
      pending: null,
      recoveryRequired: true,
    });
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
    expect(f.inbox.whatsAppRelayState()!.recovery?.reason).toBe('gap');
    expect(f.calls).toEqual([]);
  });

  it('records existing remote cursors and gaps without accepting lost messages or clearing their review', async () => {
    const f = await fixture();
    await pairWhatsApp(f.inbox, f.body, {
      request: async () => Response.json({ ...f.status, cursor: 24, gap: { at: Date.now(), through: 25 } }),
    });
    expect(f.inbox.whatsAppRelayState()).toMatchObject({ cursor: 24, recovery: { reason: 'gap' } });
    expect(f.preview().recoveryRequired).toBe(true);
  });

  it('refuses a stale revision or mismatched saved binding rather than overwriting it', async () => {
    const f = await fixture();
    setGatewaySecrets(f.instance.id, {
      ...getGatewaySecrets(f.instance.id),
      relayKey: TOKEN,
      whatsappPairing: f.received(),
    });
    expect(() => finishWhatsAppPairing(f.inbox, { revision: '0'.repeat(64) })).toThrow('changed');
    f.inbox.bindWhatsAppRelayConnection({ ...f.connection, epoch: crypto.randomUUID() }, 0);
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    expect(() => finishWhatsAppPairing(f.inbox, { revision: f.preview().pending!.revision })).toThrow(
      'could not be bound',
    );
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
  });

  it('blocks credential changes and transport startup while the returned key is still being saved', async () => {
    const f = await fixture();
    setGatewaySecrets(f.instance.id, {
      ...getGatewaySecrets(f.instance.id),
      relayKey: TOKEN,
      whatsappPairing: f.received(),
    });
    expect(() => saveGatewayCredentials(f.instance.id, {})).toThrow('pending WhatsApp pairing');
    expect(() => updateGatewayCredentials(f.instance.id, { botToken: 'new' })).toThrow('pending WhatsApp pairing');
    expect(() => whatsAppTransport(f.state, f.inbox, () => {}, new AbortController().signal)).toThrow(
      'pending WhatsApp pairing',
    );
  });

  it('requires the current unknown attempt and remote revocation acknowledgement to permit a new code', async () => {
    const f = await fixture();
    await expect(
      pairWhatsApp(f.inbox, f.body, {
        request: async () => {
          throw new Error('lost');
        },
      }),
    ).rejects.toThrow('unknown');
    const revision = f.preview().pending!.revision;
    for (const body of [
      { revision },
      { revision, acknowledgeRemoteRevoked: false },
      { revision: '0'.repeat(64), acknowledgeRemoteRevoked: true },
    ])
      expect(() => reviewWhatsAppPairing(f.inbox, body)).toThrow('revoke');
    expect(reviewWhatsAppPairing(f.inbox, { revision, acknowledgeRemoteRevoked: true })).toEqual({
      paired: false,
      pending: null,
      recoveryRequired: false,
    });
    await pairWhatsApp(f.inbox, f.body, { request: f.request });
    expect(f.calls).toHaveLength(1);
    setGatewaySecrets(f.instance.id, { ...getGatewaySecrets(f.instance.id), whatsappPairing: f.received() });
    expect(() =>
      reviewWhatsAppPairing(f.inbox, { revision: f.preview().pending!.revision, acknowledgeRemoteRevoked: true }),
    ).toThrow('unknown pairing');
  });

  it('retains the received key if the instance is enabled while the remote exchange is pending', async () => {
    const f = await fixture();
    await expect(
      pairWhatsApp(f.inbox, f.body, {
        request: async () => {
          saveGatewayInstance({ ...f.config, enabled: true }, f.instance.id);
          return Response.json(f.status);
        },
      }),
    ).rejects.toThrow('Pause');
    expect(getGatewaySecrets(f.instance.id).relayKey).toBe(TOKEN);
    expect(f.preview().pending?.phase).toBe('received');
    expect(f.inbox.whatsAppRelayState()).toBeUndefined();
  });

  it('never recreates deleted credentials when a pairing response arrives after instance deletion', async () => {
    const f = await fixture();
    await expect(
      pairWhatsApp(f.inbox, f.body, {
        request: async () => {
          removeGatewayInstance(f.instance.id);
          return Response.json(f.status);
        },
      }),
    ).rejects.toThrow('No such gateway');
    expect(getGatewaySecrets(f.instance.id)).toEqual({});
  });

  it('keeps an unknown receipt if saving the returned key fails, requiring revocation rather than another exchange', async () => {
    const f = await fixture();
    const write = fs.writeFileSync.bind(fs);
    let writes = 0;
    const fault = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).includes('gateway-secrets.json') && ++writes === 2) throw new Error('PRIVATE_DISK');
      return write(file, ...args);
    });
    await expect(pairWhatsApp(f.inbox, f.body, { request: f.request })).rejects.toThrow('local storage');
    fault.mockRestore();
    expect(f.preview().pending?.phase).toBe('requesting');
    expect(getGatewaySecrets(f.instance.id).relayKey).toBeUndefined();
    await expect(pairWhatsApp(f.inbox, f.body, { request: f.request })).rejects.toThrow('saved WhatsApp pairing');
    expect(f.calls).toHaveLength(1);
  });

  it('does not clear an unreadable pending receipt or accept private receipt fields through credential updates', async () => {
    const f = await fixture();
    expect(() => saveGatewayCredentials(f.instance.id, { whatsappPairing: f.received() })).toThrow('credentials');
    const file = dataPath('gateway-secrets.json');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const value of [null, false, { phase: 'invented' }]) {
      saved[f.instance.id] = { whatsappPairing: value };
      fs.writeFileSync(file, JSON.stringify(saved));
      expect(() => f.preview()).toThrow('unreadable');
      await expect(pairWhatsApp(f.inbox, f.body, { request: f.request })).rejects.toThrow('unreadable');
      expect(f.calls).toEqual([]);
      expect(() => saveGatewayCredentials(f.instance.id, {})).toThrow('pending WhatsApp pairing');
      expect(() => whatsAppTransport(f.state, f.inbox, () => {}, new AbortController().signal)).toThrow(
        'pending WhatsApp pairing',
      );
    }
  });

  it('bounds stalled requests and response readers, retaining an unknown attempt', async () => {
    for (const stream of [false, true]) {
      const f = await fixture();
      let cancelled = false;
      const request: PairRequest = async () =>
        stream
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(Buffer.from('{'));
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { 'content-type': 'application/json' } },
            )
          : new Promise<Response>(() => {});
      await expect(pairWhatsApp(f.inbox, f.body, { request, timeoutMs: 10 })).rejects.toThrow('unknown');
      expect(f.preview().pending?.phase).toBe('requesting');
      if (stream) expect(cancelled).toBe(true);
    }
  });

  it('takes state and account ownership through the supervisor and refuses to change a live instance', async () => {
    const f = await fixture();
    setGatewaySecrets(f.instance.id, {
      ...getGatewaySecrets(f.instance.id),
      relayKey: TOKEN,
      whatsappPairing: f.received(),
    });
    const supervisor = new GatewaySupervisor();
    closes.push(() => supervisor.stop());
    const body = { revision: f.preview().pending!.revision };
    await expect(supervisor.finishWhatsAppPairing(f.instance.id, body)).rejects.toThrow('claim');
    await f.state.disconnect();
    expect(await supervisor.finishWhatsAppPairing(f.instance.id, body)).toMatchObject({ paired: true });
    expect(supervisor.health()).toContainEqual(
      expect.objectContaining({ instanceId: f.instance.id, status: 'paused' }),
    );
    saveGatewayInstance({ ...f.config, enabled: true }, f.instance.id);
    await expect(supervisor.pairWhatsApp(f.instance.id, f.body)).rejects.toThrow('Pause');
  });
});
