import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayWhatsAppRelayStatus } from '../../shared/types.ts';
import { agents, getGatewaySecrets } from '../../server/store.ts';
import { checkWhatsAppSetup } from '../../server/gateways/whatsapp-setup.ts';
import { checkWhatsAppAccount } from '../../server/gateways/whatsapp.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { saveGatewayCredentials, saveGatewayInstance, updateGatewayCredentials } from '../../server/gateways/instances.ts';
import { gatewayConfig } from './gateway-fixtures.ts';

const BUSINESS = '9000000001'; const TOKEN = 'PRIVATE_META_ACCESS'; const SECRET = 'PRIVATE_META_APP_SECRET'; const PULL = 'a'.repeat(64);
const EPOCH = '00000000-0000-4000-8000-000000000001'; const INSTALLATION = '00000000-0000-4000-8000-000000000002';
const limits = { bodyBytes: 1048576, queueBytes: 16777216, queueEvents: 1000, replayEntries: 10000, retentionMs: 259200000, replayMs: 604800000, pairingMs: 600000, leaseMs: 60000, batchBytes: 2097152, batchEvents: 20 };
const closes: (() => Promise<void>)[] = []; let accounts = 9800000000;
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function fixture() {
  const config = { ...gatewayConfig(String(accounts++)), name: 'WhatsApp check', platform: 'whatsapp', enabled: false,
    senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436641234567'] }, scope: { directMessages: true, conversationIds: [], guildIds: [] } };
  const instance = saveGatewayInstance(config); saveGatewayCredentials(instance.id, { accessToken: TOKEN, signingSecret: SECRET, relayKey: PULL });
  const state = new GatewayStateAdapter(instance.id); await state.connect(); const inbox = new GatewayInbox(state);
  inbox.bindWhatsAppRelayConnection({ origin: 'https://relay.example', installationId: INSTALLATION, businessAccountId: BUSINESS, phoneNumberId: instance.accountId, epoch: EPOCH }, 0);
  const remote: GatewayWhatsAppRelayStatus = { version: 1, installationId: INSTALLATION, businessAccountId: BUSINESS, phoneNumberId: instance.accountId, epoch: EPOCH, cursor: 0, gap: null, limits, queuedEvents: 0, queuedBytes: 0 };
  const calls: string[] = []; const errors: unknown[] = []; let hook: (() => void) | undefined;
  let status = 200; let raw: string | undefined; let wrongPhone = false; let stalled = false; let paging: 'none' | 'cycle' | 'many' = 'none';
  const server = http.createServer((req, res) => {
    try {
      expect(req.method).toBe('GET'); expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`); const url = new URL(req.url ?? '/', 'http://fixture'); calls.push(`meta:${url.pathname}`); hook?.();
      let body: unknown = { id: wrongPhone ? '999' : instance.accountId };
      if (url.pathname === `/v25.0/${BUSINESS}/phone_numbers`) {
        body = paging === 'none' ? { data: [{ id: instance.accountId }] } : { data: [], paging: { next: 'https://steal.example/PRIVATE', cursors: { after: paging === 'cycle' ? 'same' : String(calls.length) } } };
      } else expect(url.pathname).toBe(`/v25.0/${instance.accountId}`);
      res.writeHead(status, { 'content-type': 'application/json' });
      if (stalled) { res.flushHeaders(); return; }
      res.end(raw ?? JSON.stringify(body));
    } catch (error) { errors.push(error); res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
  const testOrigin = `http://127.0.0.1:${address.port}`;
  const request = async (url: string, init: RequestInit) => { calls.push('relay:status'); expect(url).toBe('https://relay.example/v1/status'); expect(init).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store' }); expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${PULL}`); expect(init.body).toBeUndefined(); return Response.json(remote); };
  closes.push(async () => { await state.disconnect(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); expect(errors).toEqual([]); });
  return { config, instance, state, inbox, remote, calls, testOrigin, request, check: () => checkWhatsAppSetup(inbox, { testOrigin, request }),
    fault: (value: { status?: number; raw?: string; wrongPhone?: boolean; stalled?: boolean; paging?: typeof paging; hook?: typeof hook }) => { status = value.status ?? 200; raw = value.raw; wrongPhone = value.wrongPhone ?? false; stalled = value.stalled ?? false; paging = value.paging ?? 'none'; hook = value.hook; } };
}

describe('paused read-only WhatsApp setup checks', () => {
  it('checks Meta before the relay with fixed GET paths and leaves all saved state untouched', async () => {
    const f = await fixture(); const before = fs.readFileSync(f.state.inboxFile(), 'utf8'); const secrets = getGatewaySecrets(f.instance.id);
    expect(await f.check()).toEqual({ checkedAt: expect.any(Number), account: 'verified', relay: 'ready' });
    expect(f.calls).toEqual([`meta:/v25.0/${f.instance.accountId}`, `meta:/v25.0/${BUSINESS}/phone_numbers`, 'relay:status']);
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before); expect(getGatewaySecrets(f.instance.id)).toEqual(secrets);
    expect(JSON.stringify(await f.check())).not.toContain('PRIVATE');
  });

  it.each([401, 500, 'phone', 'json', 'bytes', 'cycle', 'many'] as const)('refuses a Meta %s fault without contacting the relay', async (kind) => {
    const f = await fixture(); f.fault(typeof kind === 'number' ? { status: kind } : kind === 'phone' ? { wrongPhone: true } : kind === 'cycle' || kind === 'many' ? { paging: kind } : { raw: kind === 'json' ? 'PRIVATE_JSON' : 'x'.repeat(65537) });
    await expect(f.check()).rejects.toThrow('could not verify'); expect(f.calls).not.toContain('relay:status'); expect(f.calls.filter((call) => call.includes('phone_numbers')).length).toBeLessThanOrEqual(10);
  });

  it.each(['installationId', 'businessAccountId', 'phoneNumberId', 'epoch'] as const)('refuses a foreign relay %s without altering its pairing', async (field) => {
    const f = await fixture(); Object.assign(f.remote, { [field]: field === 'epoch' || field === 'installationId' ? '00000000-0000-4000-8000-000000000009' : '999' }); const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    await expect(f.check()).rejects.toThrow('no longer matches'); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
  });

  it('reports a gap or saved hold without recording, clearing or accepting it', async () => {
    const f = await fixture(); f.remote.gap = { at: Date.now(), through: 2 }; const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    expect((await f.check()).relay).toBe('needs-review'); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
    f.remote.gap = null; f.inbox.holdWhatsAppRelay('envelope'); const held = fs.readFileSync(f.state.inboxFile(), 'utf8');
    expect((await f.check()).relay).toBe('needs-review'); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(held);
  });

  it('refuses an unexplained cursor advance instead of treating it as ready', async () => {
    const f = await fixture(); f.remote.cursor = 10; await expect(f.check()).rejects.toThrow('cursor does not match'); expect(f.inbox.whatsAppRelayState()!.cursor).toBe(0);
  });

  it.each([0, 1])('reports an unconfirmed acknowledgement at remote cursor %s without confirming or retrying it', async (cursor) => {
    const f = await fixture(); f.inbox.acceptWhatsAppRelay({ epoch: EPOCH, sequence: 1, id: 'b'.repeat(64) }, [], 1); f.remote.cursor = cursor;
    const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    expect((await f.check()).relay).toBe('acknowledgement-pending'); expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before);
    expect(f.inbox.whatsAppRelayState()!.receipt!.confirmed).toBe(false); expect(f.calls.filter((call) => call.startsWith('relay:'))).toEqual(['relay:status']);
  });

  it('rejects a stale success when credentials change while the relay status is being read', async () => {
    const f = await fixture();
    await expect(checkWhatsAppSetup(f.inbox, { testOrigin: f.testOrigin, request: async (url, init) => {
      const response = await f.request(url, init); updateGatewayCredentials(f.instance.id, { signingSecret: 'PRIVATE_CHANGED_SECRET' }); return response;
    } })).rejects.toThrow('changed during');
  });

  it('requires pause, a sender guard, direct messages and saved credentials before I/O', async () => {
    const f = await fixture(); saveGatewayInstance({ ...f.config, enabled: true }, f.instance.id); await expect(f.check()).rejects.toThrow('Pause');
    saveGatewayInstance({ ...f.config, senderPolicy: { platform: 'whatsapp', allowedPhones: [] } }, f.instance.id); await expect(f.check()).rejects.toThrow('allowed phone');
    saveGatewayInstance({ ...f.config, scope: { directMessages: false, conversationIds: [], guildIds: [] } }, f.instance.id); await expect(f.check()).rejects.toThrow('direct messages');
    saveGatewayInstance(f.config, f.instance.id); saveGatewayCredentials(f.instance.id, { relayKey: PULL }); await expect(f.check()).rejects.toThrow('access token'); expect(f.calls).toEqual([]);
  });

  it('checks that the selected native destination still exists before account I/O', async () => {
    const f = await fixture(); const agent = agents.save({ id: 'whatsapp-check-agent' }); saveGatewayInstance({ ...f.config, target: { kind: 'agent', id: agent.id } }, f.instance.id); agents.remove(agent.id);
    await expect(f.check()).rejects.toThrow('Choose an agent'); expect(f.calls).toEqual([]);
  });

  it.each(['settings', 'credentials'] as const)('stops after %s change during account verification', async (kind) => {
    const f = await fixture(); f.fault({ hook: () => { if (kind === 'settings') saveGatewayInstance({ ...f.config, name: 'Changed during check' }, f.instance.id); else updateGatewayCredentials(f.instance.id, { signingSecret: 'PRIVATE_REPLACEMENT_SECRET' }); } });
    await expect(f.check()).rejects.toThrow('changed during'); expect(f.calls).toHaveLength(1);
  });

  it('keeps the pull key when Meta credentials are replaced or removed independently', async () => {
    const f = await fixture(); updateGatewayCredentials(f.instance.id, { accessToken: 'replacement' }); expect(getGatewaySecrets(f.instance.id)).toMatchObject({ relayKey: PULL, signingSecret: SECRET, accessToken: 'replacement' });
    updateGatewayCredentials(f.instance.id, { signingSecret: null }); expect(getGatewaySecrets(f.instance.id)).toEqual({ accessToken: 'replacement', relayKey: PULL });
    expect(() => updateGatewayCredentials(f.instance.id, { relayKey: null })).toThrow('credentials'); expect(() => updateGatewayCredentials(f.instance.id, { botToken: 'wrong platform' })).toThrow('credentials');
  });

  it('bounds stalled account reads without initializing an adapter or changing state', async () => {
    const f = await fixture(); f.fault({ stalled: true }); const before = fs.readFileSync(f.state.inboxFile(), 'utf8');
    await expect(checkWhatsAppAccount(f.inbox, { testOrigin: f.testOrigin, timeoutMs: 100 })).rejects.toThrow('could not verify');
    expect(fs.readFileSync(f.state.inboxFile(), 'utf8')).toBe(before); expect(f.calls).toEqual([`meta:/v25.0/${f.instance.accountId}`]);
  });

  it('takes exclusive state/account ownership for the supervisor check', async () => {
    const f = await fixture(); const supervisor = new GatewaySupervisor(); closes.push(() => supervisor.stop());
    await expect(supervisor.checkWhatsAppSetup(f.instance.id)).rejects.toThrow('claim'); expect(f.calls).toEqual([]);
  });
});
