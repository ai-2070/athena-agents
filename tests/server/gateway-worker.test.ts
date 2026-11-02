import { afterEach, describe, expect, it } from 'vitest';
import { agents, collection } from '../../server/store.ts';
import { listGatewayInstances, saveGatewayInstance, removeGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { TelegramGatewayWorker } from '../../server/gateways/worker.ts';
import { GatewaySetupError } from '../../server/gateways/telegram.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import type { GatewayInstance } from '../../shared/types.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

let account = 20000;
const workers: TelegramGatewayWorker[] = [];
const supervisors: GatewaySupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()));
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  for (const instance of listGatewayInstances()) removeGatewayInstance(instance.id);
});

describe('gateway intake lifecycle', () => {
  it('retries transport startup with redacted health and stops future attempts when closed', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    let starts = 0;
    let stops = 0;
    const worker = new TelegramGatewayWorker(instance.id, {
      retryMs: 5,
      transport: () => ({
        start: async () => { if (++starts < 2) throw new Error('https://api.example/botPRIVATE_TOKEN'); },
        stop: async () => { stops++; }, alive: () => true,
      }),
    }); workers.push(worker);
    await worker.start();
    expect(worker.health().status).toBe('retrying');
    expect(JSON.stringify(worker.health())).not.toContain('PRIVATE_TOKEN');
    await expect.poll(() => worker.health().status).toBe('connected');
    expect(starts).toBe(2);
    expect(stops).toBe(1);
    await worker.stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(starts).toBe(2);
    expect(worker.health().status).toBe('paused');
    const state = new GatewayStateAdapter(instance.id); await state.connect(); await state.disconnect();
  });

  it('requires explicit reconnect after a setup error and claims the same account only once', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    let starts = 0;
    const worker = new TelegramGatewayWorker(instance.id, { retryMs: 5, transport: () => ({ start: async () => { starts++; throw new GatewaySetupError('Existing webhook'); }, stop: async () => {}, alive: () => false }) });
    workers.push(worker); await worker.start();
    expect(worker.health().status).toBe('needs-setup');
    await new Promise((resolve) => setTimeout(resolve, 30)); expect(starts).toBe(1);
    await worker.stop();
    const first = new TelegramGatewayWorker(instance.id, { transport: () => ({ start: async () => {}, stop: async () => {}, alive: () => true }) });
    workers.push(first); await first.start();
    // Simulate two dashboard processes racing to create records for the same account.
    const duplicate = collection<GatewayInstance>('gateways', { global: true }).save({ ...instance, id: `${instance.id}-duplicate` });
    let duplicateStarts = 0;
    const second = new TelegramGatewayWorker(duplicate.id, { retryMs: 60000, transport: () => ({ start: async () => { duplicateStarts++; }, stop: async () => {}, alive: () => true }) });
    workers.push(second); await second.start();
    expect(second.health().status).toBe('retrying'); expect(duplicateStarts).toBe(0);
  });

  it('recovers interrupted work before opening the transport', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    const state = new GatewayStateAdapter(instance.id); await state.connect();
    const inbox = new GatewayInbox(state);
    inbox.accept({ ...gatewayInput(), accountId: instance.accountId }); inbox.claimNext();
    await state.disconnect();
    const worker = new TelegramGatewayWorker(instance.id, { transport: (_state, recovered) => ({
      start: async () => { expect(recovered.list()[0].status).toBe('needs-review'); expect(recovered.claimNext()).toBeNull(); },
      stop: async () => {}, alive: () => true,
    }) }); workers.push(worker);
    await worker.start(); expect(worker.health().status).toBe('connected');
  });

  it('restarts only the changed instance and stops polling after pause, delete or target removal', async () => {
    const oneConfig = gatewayConfig(String(account++));
    const one = saveGatewayInstance(oneConfig);
    const agent = agents.save({ id: 'gateway-lifecycle-agent' });
    const twoConfig = { ...gatewayConfig(String(account++)), target: { kind: 'agent', id: agent.id } };
    const two = saveGatewayInstance(twoConfig);
    const starts = new Map<string, number>();
    const stops = new Map<string, number>();
    const supervisor = new GatewaySupervisor((id, health) => new TelegramGatewayWorker(id, { health, transport: () => ({
      start: async () => { starts.set(id, (starts.get(id) ?? 0) + 1); },
      stop: async () => { stops.set(id, (stops.get(id) ?? 0) + 1); }, alive: () => true,
    }) })); supervisors.push(supervisor);
    await supervisor.start();
    await expect.poll(() => supervisor.health().filter((value) => value.status === 'connected').length).toBe(2);
    saveGatewayInstance({ ...oneConfig, name: 'Renamed' }, one.id);
    await expect.poll(() => starts.get(one.id)).toBe(2);
    expect(starts.get(two.id)).toBe(1);
    saveGatewayInstance({ ...oneConfig, enabled: false }, one.id);
    await expect.poll(() => supervisor.health().find((value) => value.instanceId === one.id)?.status).toBe('paused');
    agents.remove(agent.id);
    await expect.poll(() => supervisor.health().find((value) => value.instanceId === two.id)?.status).not.toBe('connected');
    expect(stops.get(two.id)).toBe(1);
    removeGatewayInstance(one.id);
    await supervisor.reconnect(one.id);
    expect(supervisor.health().some((value) => value.instanceId === one.id)).toBe(false);
  });
});
