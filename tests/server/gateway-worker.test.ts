import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { ensureBrain } from '../../server/projects.ts';
import { agents, collection } from '../../server/store.ts';
import { listGatewayInstances, saveGatewayInstance, removeGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewaySupervisor } from '../../server/gateways/supervisor.ts';
import { GatewayWorker } from '../../server/gateways/worker.ts';
import { GatewaySetupError } from '../../server/gateways/telegram.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import type { GatewayInstance } from '../../shared/types.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';

let account = 20000;
const workers: GatewayWorker[] = [];
const supervisors: GatewaySupervisor[] = [];
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()));
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  for (const instance of listGatewayInstances()) removeGatewayInstance(instance.id);
});

describe('gateway intake lifecycle', () => {
  it('groups a saved album through its worker once and wakes the normal dispatcher', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    let saved: GatewayInbox | undefined;
    let submissions = 0;
    let attachments = 0;
    const worker = new GatewayWorker(instance.id, {
      execution: {
        async submit(_event, _signal, proceed, input) {
          expect(proceed()).toBe(true);
          submissions++;
          attachments = input?.attachments.length ?? 0;
          return {};
        },
        poll() {
          return { state: 'pending' };
        },
      },
      transport: (state, inbox) => {
        saved = inbox;
        return {
          start: async () => {
            for (const id of ['1', '2'])
              inbox.accept({
                ...gatewayInput(id),
                accountId: instance.accountId,
                mediaGroupId: 'album',
                media: [{ kind: 'file', fileId: id }],
              });
          },
          stop: () => state.disconnect(),
          alive: () => true,
          reply: async () => 'confirmed',
          download: async () => ({ source: Readable.from([Buffer.from('hello')]), declaredBytes: 5 }),
        };
      },
    });
    workers.push(worker);
    await worker.start();
    const ids = saved!.list().map((event) => event.id);
    expect(submissions).toBe(0);
    expect(worker.groupAlbum(ids[0], { eventIds: ids })).toEqual({ leaderId: ids[0] });
    await expect.poll(() => submissions).toBe(1);
    expect(attachments).toBe(2);
    expect(() => worker.groupAlbum(ids[0], { eventIds: ids })).toThrow('Reload and check');
    await worker.stop();
    expect(() => worker.groupAlbum(ids[0], { eventIds: ids })).toThrow('Connect this gateway');
  });

  it('reconciles held work through its worker without resubmission or exposing provider errors', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    let saved: GatewayInbox | undefined;
    let recover = false;
    let submissions = 0;
    let sends = 0;
    const worker = new GatewayWorker(instance.id, {
      execution: {
        async submit() {
          submissions++;
          throw new Error('Response lost after saved completion');
        },
        poll() {
          return { state: 'needs-review' };
        },
        reconcile() {
          if (!recover) throw new Error('PRIVATE_PROVIDER_TOKEN');
          return { state: 'completed', answer: 'Recovered completed work' };
        },
      },
      transport: (state, inbox) => {
        saved = inbox;
        return {
          start: async () => {
            inbox.accept({ ...gatewayInput(), accountId: instance.accountId });
          },
          stop: () => state.disconnect(),
          alive: () => true,
          reply: async () => {
            sends++;
            return 'confirmed';
          },
        };
      },
    });
    workers.push(worker);
    await worker.start();
    await expect.poll(() => saved?.list()[0].status).toBe('needs-review');
    const id = saved!.list()[0].id;
    expect(() => worker.reconcile(id)).toThrow('Nothing was restarted or sent');
    expect(JSON.stringify(saved!.list())).not.toContain('PRIVATE_PROVIDER_TOKEN');
    recover = true;
    expect(worker.reconcile(id).state).toBe('completed');
    await expect.poll(() => sends).toBe(1);
    expect(submissions).toBe(1);
    await worker.stop();
    expect(() => worker.reconcile(id)).toThrow('Connect this gateway');
  });

  it('uses the worker file selection service and records interrupted uploads before releasing state', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    let saved: GatewayInbox | undefined;
    let complete = false;
    let sending = false;
    const worker = new GatewayWorker(instance.id, {
      execution: {
        async submit() {
          return {};
        },
        poll() {
          return complete ? { state: 'completed', answer: 'Final answer' } : { state: 'pending' };
        },
      },
      transport: (state, inbox) => {
        saved = inbox;
        return {
          start: async () => {
            inbox.accept({ ...gatewayInput(), accountId: instance.accountId });
          },
          alive: () => true,
          stop: async () => {
            expect(inbox.list()[0].outgoing?.[0].status).toBe('uncertain');
            await state.disconnect();
          },
          reply: async () => 'text-confirmed',
          upload: async (_event, _file, signal) => {
            sending = true;
            return new Promise<never>((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            );
          },
        };
      },
    });
    workers.push(worker);
    await worker.start();
    await expect.poll(() => saved?.list()[0].dispatch?.state).toBe('running');
    const target = path.join(ensureBrain(), `worker-document-${account}.txt`);
    fs.writeFileSync(target, 'document');
    await worker.selectDocuments(saved!.list()[0].id, { paths: [target] });
    complete = true;
    await expect.poll(() => sending).toBe(true);
    await worker.stop();
    const state = new GatewayStateAdapter(instance.id);
    await state.connect();
    expect(new GatewayInbox(state).list()[0].outgoing?.[0].status).toBe('uncertain');
    await state.disconnect();
  });

  it('saves an interrupted status notice before transport shutdown releases ownership', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    let saved: GatewayInbox | undefined;
    let sending = false;
    const worker = new GatewayWorker(instance.id, {
      execution: {
        async submit() {
          return {};
        },
        poll() {
          return { state: 'pending' };
        },
      },
      transport: (state, inbox) => {
        saved = inbox;
        return {
          start: async () => {
            inbox.accept({ ...gatewayInput(), accountId: instance.accountId });
          },
          stop: () => state.disconnect(),
          alive: () => true,
          reply: async (_event, _text, signal) => {
            sending = true;
            return new Promise<never>((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
            );
          },
        };
      },
    });
    workers.push(worker);
    await worker.start();
    await expect.poll(() => saved?.list()[0].dispatch?.state).toBe('running');
    saved!.queueNotice(saved!.list()[0].id, 'working');
    await expect.poll(() => sending).toBe(true);
    await worker.stop();
    const state = new GatewayStateAdapter(instance.id);
    await state.connect();
    expect(new GatewayInbox(state).list()[0].notices?.working?.status).toBe('uncertain');
    await state.disconnect();
  });

  it('starts dispatch and delivery with the transport and saves delivery before releasing ownership', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    let saved: GatewayInbox | undefined;
    let submissions = 0;
    const sent: string[] = [];
    const worker = new GatewayWorker(instance.id, {
      execution: {
        async submit() {
          submissions++;
          return {};
        },
        poll() {
          return { state: 'completed', answer: 'Worker final answer' };
        },
      },
      transport: (state, inbox) => {
        saved = inbox;
        return {
          start: async () => {
            inbox.accept({ ...gatewayInput(), accountId: instance.accountId });
          },
          stop: async () => {
            expect(inbox.list()[0].reply?.parts[0].status).toBe('sent');
            await state.disconnect();
          },
          alive: () => true,
          reply: async (_event, text) => {
            sent.push(text);
            return 'confirmed-message';
          },
        };
      },
    });
    workers.push(worker);
    await worker.start();
    await expect.poll(() => saved?.list()[0].reply?.parts[0].status).toBe('sent');
    expect(submissions).toBe(1);
    expect(sent).toEqual(['Worker final answer']);
    await worker.stop();
    const state = new GatewayStateAdapter(instance.id);
    await state.connect();
    expect(new GatewayInbox(state).list()[0].reply?.parts[0].remoteId).toBe('confirmed-message');
    await state.disconnect();
  });

  it('finishes interrupted file receipts before SDK shutdown releases state ownership', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    let saved: GatewayInbox | undefined;
    let streaming = false;
    const worker = new GatewayWorker(instance.id, {
      transport: (state, inbox) => {
        saved = inbox;
        return {
          start: async () => {},
          stop: () => state.disconnect(),
          alive: () => true,
          download: async (_id, _limit, signal) => ({
            source: (async function* () {
              streaming = true;
              yield Buffer.from('first');
              signal.throwIfAborted();
              await new Promise<never>((_resolve, reject) =>
                signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
              );
            })(),
          }),
        };
      },
    });
    workers.push(worker);
    await worker.start();
    saved!.accept({
      ...gatewayInput(),
      accountId: instance.accountId,
      text: '',
      media: [{ kind: 'file', fileId: 'private-file' }],
    });
    await expect.poll(() => streaming).toBe(true);
    await worker.stop();
    const state = new GatewayStateAdapter(instance.id);
    await state.connect();
    expect(new GatewayInbox(state).list()[0].files![0].status).toBe('failed');
    await state.disconnect();
  });
  it('runs the file stage with its transport and supports explicit file retry', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    let saved: GatewayInbox | undefined;
    let fail = true;
    const worker = new GatewayWorker(instance.id, {
      transport: (_state, inbox) => {
        saved = inbox;
        return {
          start: async () => {
            inbox.accept({
              ...gatewayInput(),
              accountId: instance.accountId,
              text: '',
              media: [{ kind: 'file', fileId: 'private-file', name: 'plan.txt' }],
            });
          },
          stop: async () => {},
          alive: () => true,
          download: async () => {
            if (fail) throw new Error('expired');
            return { source: Readable.from([Buffer.from('hello')]) };
          },
        };
      },
    });
    workers.push(worker);
    await worker.start();
    expect(saved!.list()[0].files![0].status).toBe('failed');
    fail = false;
    worker.retryFiles(saved!.list()[0].id);
    await expect.poll(() => saved!.list()[0].status).toBe('queued');
    await worker.stop();
    const state = new GatewayStateAdapter(instance.id);
    await state.connect();
    expect(new GatewayInbox(state).list()[0].files![0].file!.size).toBe(5);
    await state.disconnect();
  });
  it('retries transport startup with redacted health and stops future attempts when closed', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    let starts = 0;
    let stops = 0;
    const worker = new GatewayWorker(instance.id, {
      retryMs: 5,
      transport: () => ({
        start: async () => {
          if (++starts < 2) throw new Error('https://api.example/botPRIVATE_TOKEN');
        },
        stop: async () => {
          stops++;
        },
        alive: () => true,
      }),
    });
    workers.push(worker);
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
    const state = new GatewayStateAdapter(instance.id);
    await state.connect();
    await state.disconnect();
  });

  it('requires explicit reconnect after a setup error and claims the same account only once', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    let starts = 0;
    const worker = new GatewayWorker(instance.id, {
      retryMs: 5,
      transport: () => ({
        start: async () => {
          starts++;
          throw new GatewaySetupError('Existing webhook');
        },
        stop: async () => {},
        alive: () => false,
      }),
    });
    workers.push(worker);
    await worker.start();
    expect(worker.health().status).toBe('needs-setup');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(starts).toBe(1);
    await worker.stop();
    const first = new GatewayWorker(instance.id, {
      transport: () => ({ start: async () => {}, stop: async () => {}, alive: () => true }),
    });
    workers.push(first);
    await first.start();
    // Simulate two dashboard processes racing to create records for the same account.
    const duplicate = collection<GatewayInstance>('gateways', { global: true }).save({
      ...instance,
      id: `${instance.id}-duplicate`,
    });
    let duplicateStarts = 0;
    const second = new GatewayWorker(duplicate.id, {
      retryMs: 60000,
      transport: () => ({
        start: async () => {
          duplicateStarts++;
        },
        stop: async () => {},
        alive: () => true,
      }),
    });
    workers.push(second);
    await second.start();
    expect(second.health().status).toBe('retrying');
    expect(duplicateStarts).toBe(0);
  });

  it('recovers interrupted work before opening the transport', async () => {
    const instance = saveGatewayInstance(gatewayConfig(String(account++)));
    const state = new GatewayStateAdapter(instance.id);
    await state.connect();
    const inbox = new GatewayInbox(state);
    inbox.accept({ ...gatewayInput(), accountId: instance.accountId });
    inbox.claimNext();
    await state.disconnect();
    const worker = new GatewayWorker(instance.id, {
      transport: (_state, recovered) => ({
        start: async () => {
          expect(recovered.list()[0].status).toBe('needs-review');
          expect(recovered.claimNext()).toBeNull();
        },
        stop: async () => {},
        alive: () => true,
      }),
    });
    workers.push(worker);
    await worker.start();
    expect(worker.health().status).toBe('connected');
  });

  it('restarts only the changed instance and stops polling after pause, delete or target removal', async () => {
    const oneConfig = gatewayConfig(String(account++));
    const one = saveGatewayInstance(oneConfig);
    const agent = agents.save({ id: 'gateway-lifecycle-agent' });
    const twoConfig = { ...gatewayConfig(String(account++)), target: { kind: 'agent', id: agent.id } };
    const two = saveGatewayInstance(twoConfig);
    const starts = new Map<string, number>();
    const stops = new Map<string, number>();
    const supervisor = new GatewaySupervisor(
      (id, health) =>
        new GatewayWorker(id, {
          health,
          transport: () => ({
            start: async () => {
              starts.set(id, (starts.get(id) ?? 0) + 1);
            },
            stop: async () => {
              stops.set(id, (stops.get(id) ?? 0) + 1);
            },
            alive: () => true,
          }),
        }),
    );
    supervisors.push(supervisor);
    await supervisor.start();
    await expect
      .poll(() => supervisor.health())
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ instanceId: one.id, status: 'connected' }),
          expect.objectContaining({ instanceId: two.id, status: 'connected' }),
        ]),
      );
    saveGatewayInstance({ ...oneConfig, name: 'Renamed' }, one.id);
    await expect.poll(() => starts.get(one.id)).toBe(2);
    expect(starts.get(two.id)).toBe(1);
    saveGatewayInstance({ ...oneConfig, enabled: false }, one.id);
    await expect.poll(() => supervisor.health().find((value) => value.instanceId === one.id)?.status).toBe('paused');
    agents.remove(agent.id);
    await expect
      .poll(() => supervisor.health().find((value) => value.instanceId === two.id)?.status)
      .not.toBe('connected');
    expect(stops.get(two.id)).toBe(1);
    removeGatewayInstance(one.id);
    await supervisor.reconnect(one.id);
    expect(supervisor.health().some((value) => value.instanceId === one.id)).toBe(false);
  });
});
