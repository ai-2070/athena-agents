import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { GatewayPlatform } from '../../shared/types.ts';
import { dataPath, readJSON, writeJSON } from '../../server/util.ts';
import { getGatewaySecrets } from '../../server/store.ts';
import { captureGatewayRoute, getGatewayInstance, listGatewayInstances, removeGatewayInstance, retireGatewayInstance, saveGatewayCredentials, saveGatewayInstance } from '../../server/gateways/instances.ts';
import { gatewayRetirement, listGatewayRetirements } from '../../server/gateways/retirement.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { GatewayWorker } from '../../server/gateways/worker.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox, gatewayRetiredInboxHistory } from '../../server/gateways/inbox.ts';
import { claimGatewayAccount, claimGatewayState } from '../../server/gateways/ownership.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

let account = 176000;
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  for (const close of closes.splice(0).reverse()) await close();
  for (const instance of listGatewayInstances()) removeGatewayInstance(instance.id);
  for (const retired of listGatewayRetirements()) if (retired.completedAt === undefined) removeGatewayInstance(retired.id);
});
function supervisor() {
  const value = new GatewaySupervisor(() => { throw new Error('Must not start a transport'); });
  closes.push(() => value.stop()); return value;
}
function fixture(platform: GatewayPlatform = 'telegram') {
  const config = { ...gatewayConfig(String(account++)), platform, enabled: false,
    senderPolicy: platform === 'whatsapp' ? { platform, allowedPhones: ['+436641234567'] } : { platform, allowedUserIds: ['123'] } };
  const instance = saveGatewayInstance(config); saveGatewayCredentials(instance.id, { botToken: 'PRIVATE_BOT_TOKEN', relayKey: 'PRIVATE_RELAY_KEY' });
  return { config, instance, record: dataPath('gateways-retired', `${instance.id}.json`), setup: dataPath('gateways', `${instance.id}.json`) };
}

it.each<GatewayPlatform>(['telegram', 'slack', 'discord', 'whatsapp'])('retires %s locally and preserves its identity without retaining credentials', async (platform) => {
  const f = fixture(platform); const other = fixture(platform); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await supervisor().removeInstance(f.instance.id);
  expect(gatewayRetirement(f.instance.id)).toEqual({ version: 1, id: f.instance.id, name: f.instance.name, platform, accountId: f.instance.accountId,
    projectId: f.instance.projectId, target: f.instance.target, routeGeneration: 1, startedAt: expect.any(Number), completedAt: expect.any(Number) });
  expect(JSON.stringify(listGatewayRetirements())).not.toMatch(/PRIVATE_|senderPolicy|fileLimits|relayKey/);
  expect(getGatewaySecrets(f.instance.id)).toEqual({}); expect(getGatewaySecrets(other.instance.id).botToken).toBe('PRIVATE_BOT_TOKEN');
  expect(() => getGatewayInstance(f.instance.id)).toThrow('No such gateway'); expect(() => captureGatewayRoute(f.instance.id)).toThrow('No such gateway');
  expect(() => saveGatewayInstance(f.config, f.instance.id)).toThrow('No such gateway'); expect(() => saveGatewayCredentials(f.instance.id, {})).toThrow('No such gateway');
  expect(fs.existsSync(f.setup)).toBe(false); expect(gatewayRetiredInboxHistory(f.instance.id)).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  const bytes = fs.readFileSync(f.record, 'utf8'); await supervisor().removeInstance(f.instance.id); expect(fs.readFileSync(f.record, 'utf8')).toBe(bytes);
  const replacement = saveGatewayInstance(f.config); expect(replacement.id).not.toBe(f.instance.id); expect(() => gatewayRetiredInboxHistory(replacement.id)).toThrow('No such removed');
});

it('keeps native input, replay markers, SDK bytes and approved Outbox evidence unchanged', async () => {
  const config = gatewayConfig(String(account++)); const instance = saveGatewayInstance(config); saveGatewayCredentials(instance.id, { botToken: 'PRIVATE_TOKEN' });
  const state = new GatewayStateAdapter(instance.id); await state.connect(); const inbox = new GatewayInbox(state);
  const event = inbox.accept({ ...gatewayInput(), accountId: instance.accountId, text: 'Saved original input' })!;
  const inboxFile = state.inboxFile(); const outboxFile = state.outboxFile();
  writeJSON(outboxFile, { confirmed: 'kept-message-id', uncertain: true }); await state.disconnect();
  const sdkFile = dataPath('gateways-runtime', instance.id, 'sdk-state.json'); fs.writeFileSync(sdkFile, 'unreadable saved SDK state');
  const before = [inboxFile, outboxFile, sdkFile].map((file) => fs.readFileSync(file, 'utf8'));
  await supervisor().removeInstance(instance.id);
  expect([inboxFile, outboxFile, sdkFile].map((file) => fs.readFileSync(file, 'utf8'))).toEqual(before);
  expect(gatewayRetiredInboxHistory(instance.id)).toEqual([event]);
  fs.writeFileSync(inboxFile, '{broken inbox'); expect(() => gatewayRetiredInboxHistory(instance.id)).toThrow('inbox is unreadable');
  expect(fs.readFileSync(inboxFile, 'utf8')).toBe('{broken inbox'); fs.writeFileSync(inboxFile, before[0]);
  expect(() => gatewayRetiredInboxHistory('missing')).toThrow('No such removed');
  expect(() => gatewayRetiredInboxHistory('../outside')).toThrow('Invalid gateway');
});

it('clears a local WhatsApp pairing even when its private setup record needs recovery', async () => {
  const f = fixture('whatsapp'); const location = dataPath('gateway-secrets.json');
  const records = readJSON<Record<string, unknown>>(location, {});
  writeJSON(location, { ...records, [f.instance.id]: { ...getGatewaySecrets(f.instance.id), whatsappPairing: { interrupted: 'PRIVATE_PAIRING_KEY' } } });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); await supervisor().removeInstance(f.instance.id);
  expect(getGatewaySecrets(f.instance.id)).toEqual({}); expect(fs.readFileSync(f.record, 'utf8')).not.toContain('PRIVATE_PAIRING_KEY'); expect(fetch).not.toHaveBeenCalled();
});

it('blocks new work before draining a worker and leaves other instances running', async () => {
  const oneConfig = gatewayConfig(String(account++)); const one = saveGatewayInstance(oneConfig); const two = saveGatewayInstance(gatewayConfig(String(account++)));
  saveGatewayCredentials(one.id, { botToken: 'PRIVATE_TOKEN' });
  const gate = Promise.withResolvers<void>(); let stopping = false; const started: string[] = []; const stopped: string[] = [];
  const value = new GatewaySupervisor((id, health) => new GatewayWorker(id, { health, transport: (state) => ({
    start: async () => { started.push(id); }, alive: () => true,
    stop: async () => { stopped.push(id); if (id === one.id) { stopping = true; await gate.promise; } await state.disconnect(); },
  }) }));
  closes.push(() => value.stop()); closes.push(async () => { gate.resolve(); }); await value.start();
  await expect.poll(() => started.length).toBe(2);
  const removing = value.removeInstance(one.id); await expect.poll(() => stopping).toBe(true);
  expect(() => captureGatewayRoute(one.id)).toThrow('No such gateway'); expect(() => saveGatewayInstance(oneConfig, one.id)).toThrow('No such gateway');
  expect(getGatewaySecrets(one.id).botToken).toBe('PRIVATE_TOKEN'); expect(gatewayRetirement(one.id)?.completedAt).toBeUndefined();
  expect(getGatewayInstance(two.id).enabled).toBe(true); expect(stopped).toEqual([one.id]);
  gate.resolve(); await removing; expect(getGatewaySecrets(one.id)).toEqual({}); expect(started).toHaveLength(2); expect(started).toEqual(expect.arrayContaining([one.id, two.id]));
  expect(gatewayRetirement(one.id)?.completedAt).toEqual(expect.any(Number)); expect(value.health().some((item) => item.instanceId === one.id)).toBe(false);
});

it.each(['account', 'state'] as const)('keeps credentials and a durable block when %s ownership is held elsewhere', async (kind) => {
  const f = fixture(); const release = await (kind === 'account' ? claimGatewayAccount(f.instance.platform, f.instance.accountId) : claimGatewayState(f.instance.id)); closes.push(release);
  const value = supervisor(); await expect(value.removeInstance(f.instance.id)).rejects.toMatchObject({ status: 503 });
  expect(gatewayRetirement(f.instance.id)?.completedAt).toBeUndefined(); expect(getGatewaySecrets(f.instance.id).botToken).toBe('PRIVATE_BOT_TOKEN'); expect(fs.existsSync(f.setup)).toBe(true);
  expect(listGatewayInstances().some((item) => item.id === f.instance.id)).toBe(false); expect(() => saveGatewayInstance(f.config)).toThrow('already has');
  await release(); await value.stop(); const restarted = supervisor(); await restarted.start();
  expect(gatewayRetirement(f.instance.id)?.completedAt).toEqual(expect.any(Number)); expect(getGatewaySecrets(f.instance.id)).toEqual({});
});

it.each(['intent', 'secrets', 'setup', 'completion'] as const)('survives a failed %s write without losing retirement or another account', async (stage) => {
  const f = fixture(); const other = fixture(); const original = fs.writeFileSync.bind(fs); const unlink = fs.unlinkSync.bind(fs);
  vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
    const location = String(file).split(path.sep).join('/'); const content = String(args[0]);
    if ((stage === 'intent' && location.includes('/gateways-retired/') && !content.includes('completedAt'))
      || (stage === 'completion' && location.includes('/gateways-retired/') && content.includes('completedAt'))
      || (stage === 'secrets' && location.includes('/gateway-secrets.json.'))) throw new Error('PRIVATE_DISK_PATH');
    return original(file, ...args);
  });
  vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => { if (stage === 'setup' && String(file) === f.setup) throw new Error('PRIVATE_DISK_PATH'); return unlink(file); });
  const value = supervisor(); await expect(value.removeInstance(f.instance.id)).rejects.toThrow('Check storage and ownership');
  expect(getGatewaySecrets(other.instance.id).botToken).toBe('PRIVATE_BOT_TOKEN');
  if (stage === 'intent') { expect(getGatewayInstance(f.instance.id).id).toBe(f.instance.id); expect(gatewayRetirement(f.instance.id)).toBeUndefined(); }
  else { expect(gatewayRetirement(f.instance.id)?.completedAt).toBeUndefined(); expect(() => getGatewayInstance(f.instance.id)).toThrow('No such gateway'); }
  vi.restoreAllMocks();
  if (stage === 'intent') await value.removeInstance(f.instance.id);
  else { await value.stop(); await supervisor().start(); }
  expect(gatewayRetirement(f.instance.id)?.completedAt).toEqual(expect.any(Number));
});

it('keeps credentials if worker shutdown fails and only removes setup after a successful drain', async () => {
  const config = gatewayConfig(String(account++)); const instance = saveGatewayInstance(config); saveGatewayCredentials(instance.id, { botToken: 'PRIVATE_TOKEN' });
  let started = false; let fail = true;
  class Worker extends GatewayWorker {
    override async stop(): Promise<void> { if (fail) throw new Error('PRIVATE_TRANSPORT_ERROR'); await super.stop(); }
  }
  const value = new GatewaySupervisor((id, health) => new Worker(id, { health, transport: (state) => ({
    start: async () => { started = true; }, stop: () => state.disconnect(), alive: () => true,
  }) })); closes.push(() => value.stop()); closes.push(async () => { fail = false; }); await value.start();
  await expect.poll(() => started).toBe(true); await expect(value.removeInstance(instance.id)).rejects.toThrow('Check storage and ownership');
  expect(getGatewaySecrets(instance.id).botToken).toBe('PRIVATE_TOKEN'); expect(gatewayRetirement(instance.id)?.completedAt).toBeUndefined();
  fail = false; await value.removeInstance(instance.id); expect(getGatewaySecrets(instance.id)).toEqual({});
});

it('saves an in-flight reply as uncertain before releasing ownership and never replays native work', async () => {
  const instance = saveGatewayInstance(gatewayConfig(String(account++))); let saved: GatewayInbox | undefined; let submissions = 0; let sends = 0;
  const value = new GatewaySupervisor((id, health) => new GatewayWorker(id, { health,
    execution: { async submit() { submissions++; return {}; }, poll() { return { state: 'completed', answer: 'Final answer' }; } },
    transport: (state, inbox) => {
      saved = inbox; return {
        start: async () => { inbox.accept({ ...gatewayInput(), accountId: instance.accountId }); }, alive: () => true,
        stop: async () => { expect(inbox.list()[0].reply?.parts[0].status).toBe('uncertain'); await state.disconnect(); },
        reply: async (_event, _text, signal) => { sends++; return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); },
      };
    },
  })); closes.push(() => value.stop()); await value.start(); await expect.poll(() => sends).toBe(1);
  const dispatch = structuredClone(saved!.list()[0].dispatch); await value.removeInstance(instance.id);
  const event = gatewayRetiredInboxHistory(instance.id)[0]; expect(event.reply?.parts[0].status).toBe('uncertain'); expect(event.dispatch).toEqual(dispatch);
  expect(submissions).toBe(1); expect(sends).toBe(1); await value.reconnect(instance.id); expect(sends).toBe(1);
});

it('resumes another pending removal even when one retired record is unreadable', async () => {
  const broken = fixture(); const pending = fixture(); const live = fixture(); retireGatewayInstance(broken.instance.id); retireGatewayInstance(pending.instance.id);
  const bytes = fs.readFileSync(broken.record, 'utf8'); fs.writeFileSync(broken.record, '{broken');
  try {
    await supervisor().start(); expect(gatewayRetirement(pending.instance.id)?.completedAt).toEqual(expect.any(Number));
    expect(getGatewaySecrets(broken.instance.id).botToken).toBe('PRIVATE_BOT_TOKEN'); expect(fs.readFileSync(broken.record, 'utf8')).toBe('{broken');
    expect(saveGatewayInstance({ ...live.config, name: 'Still editable' }, live.instance.id).name).toBe('Still editable');
  } finally { fs.writeFileSync(broken.record, bytes); }
});

it('refuses unreadable retirement records and credential storage without resetting either', async () => {
  const f = fixture(); retireGatewayInstance(f.instance.id); const record = fs.readFileSync(f.record, 'utf8');
  fs.writeFileSync(f.record, '{broken'); const value = supervisor();
  await expect(value.removeInstance(f.instance.id)).rejects.toThrow('removal record is unreadable');
  expect(listGatewayInstances().some((item) => item.id === f.instance.id)).toBe(false); expect(fs.readFileSync(f.record, 'utf8')).toBe('{broken');
  fs.writeFileSync(f.record, record);
  const secrets = dataPath('gateway-secrets.json'); const saved = fs.readFileSync(secrets, 'utf8'); fs.writeFileSync(secrets, '{broken credentials');
  await expect(value.removeInstance(f.instance.id)).rejects.toMatchObject({ status: 503 }); expect(fs.readFileSync(secrets, 'utf8')).toBe('{broken credentials');
  expect(gatewayRetirement(f.instance.id)?.completedAt).toBeUndefined(); expect(fs.existsSync(f.setup)).toBe(true);
  fs.writeFileSync(secrets, saved); await value.removeInstance(f.instance.id); expect(getGatewaySecrets(f.instance.id)).toEqual({});
});
