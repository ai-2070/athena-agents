import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EveRuntime, eveRuntimeFiles } from '../../server/eve/runtime.ts';
import { dataPath, ensureDir } from '../../server/util.ts';
import type { EveHost } from '../../server/eve/host.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const events: string[] = [];
  const workers: (EveHost & { exit(): void })[] = [];
  let work = false;
  let gate: Promise<unknown> = Promise.resolve();
  const runtime = new EveRuntime({
    bridge: async () => {
      events.push('bridge');
      return {
        url: 'http://127.0.0.1:1',
        token: 'private-fixture-token',
        close: async () => {
          events.push('close bridge');
        },
      };
    },
    host: async (_bridge, signal) => {
      events.push('launch');
      const ended = deferred<void>();
      const host = {
        url: `http://127.0.0.1:${1000 + workers.length}`,
        token: 'private-worker-token',
        exited: ended.promise,
        exit: () => ended.resolve(),
        close: async () => {
          events.push('close host');
          ended.resolve();
        },
      };
      signal.addEventListener('abort', host.exit, { once: true });
      workers.push(host);
      return host;
    },
    prepare: () => {
      events.push('prepare');
    },
    recover: async () => {
      events.push('recover');
      await gate;
      events.push('recovered');
    },
    hasWork: () => work,
    retryMs: 10,
  });
  return {
    runtime,
    events,
    workers,
    setWork: (value: boolean) => {
      work = value;
    },
    setGate: (value: Promise<unknown>) => {
      gate = value;
    },
  };
}

describe('Eve worker supervision', () => {
  it('stays lazy without saved work and shares one launch until recovery is complete', async () => {
    const f = fixture();
    await f.runtime.recover();
    expect(f.events).toEqual([]);
    const gate = deferred<void>();
    f.setGate(gate.promise);
    const first = f.runtime.ready();
    const second = f.runtime.ready();
    expect(first).toBe(second);
    await expect.poll(() => f.events.includes('recover')).toBe(true);
    expect(f.events).toEqual(['prepare', 'bridge', 'launch', 'recover']);
    gate.resolve();
    const host = await first;
    expect(await second).toBe(host);
    expect(await f.runtime.ready()).toBe(host);
    expect(f.workers).toHaveLength(1);
    await f.runtime.close();
    expect(f.events.slice(-2)).toEqual(['close host', 'close bridge']);
    await expect(f.runtime.ready()).rejects.toThrow('stopping');
  });

  it('restarts saved work after a crash and reconciles before the replacement becomes ready', async () => {
    const f = fixture();
    f.setWork(true);
    const first = await f.runtime.ready();
    f.workers[0]!.exit();
    await expect.poll(() => f.workers.length).toBe(2);
    const second = await f.runtime.ready();
    expect(second).not.toBe(first);
    expect(f.events.filter((event) => event === 'prepare')).toHaveLength(2);
    expect(f.events.filter((event) => event === 'recovered')).toHaveLength(2);
    expect(f.events.filter((event) => event === 'bridge')).toHaveLength(1);
    await f.runtime.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(f.workers).toHaveLength(2);
  });

  it('does not restart an idle worker and can start it on the next request', async () => {
    const f = fixture();
    await f.runtime.ready();
    f.workers[0]!.exit();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(f.workers).toHaveLength(1);
    await f.runtime.ready();
    expect(f.workers).toHaveLength(2);
    await f.runtime.close();
  });

  it('releases a failed recovery without exposing diagnostics and permits a fresh attempt', async () => {
    const f = fixture();
    // Reject only once recovery is listening, avoiding a test-side unhandled rejection.
    const gate = deferred<void>();
    f.setGate(
      gate.promise.then(() => {
        throw new Error('sensitive provider diagnostic');
      }),
    );
    const ready = f.runtime.ready();
    await expect.poll(() => f.events.includes('recover')).toBe(true);
    gate.resolve();
    await expect(ready).rejects.toThrow('Eve could not restore saved work');
    expect(f.events).toContain('close host');
    f.setGate(Promise.resolve());
    await f.runtime.ready();
    expect(f.workers).toHaveLength(2);
    await f.runtime.close();
  });

  it('does not publish a worker that exits while recovery is still in progress', async () => {
    const f = fixture();
    const gate = deferred<void>();
    f.setGate(gate.promise);
    const ready = f.runtime.ready();
    await expect.poll(() => f.workers.length).toBe(1);
    f.workers[0]!.exit();
    await expect(ready).rejects.toThrow('could not restore');
    gate.resolve();
    await f.runtime.close();
  });

  it('cancels a launch in progress before closing the private bridge', async () => {
    const events: string[] = [];
    const runtime = new EveRuntime({
      bridge: async () => ({
        url: 'http://127.0.0.1:1',
        token: 'fixture',
        close: async () => {
          events.push('close bridge');
        },
      }),
      host: async (_bridge, signal) => {
        events.push('launch');
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              events.push('abort');
              reject(new Error('Cancelled'));
            },
            { once: true },
          ),
        );
        throw new Error('Unreachable');
      },
      prepare: () => {},
      recover: async () => {},
      hasWork: () => false,
    });
    const ready = runtime.ready();
    await expect.poll(() => events).toEqual(['launch']);
    const failed = expect(ready).rejects.toThrow('could not restore');
    await runtime.close();
    await failed;
    expect(events).toEqual(['launch', 'abort', 'close bridge']);
  });
});

describe('Eve runtime files', () => {
  it('distinguishes the source launcher from relocated desktop output', () => {
    const root = ensureDir(dataPath('runtime-location-fixture'));
    const eve = ensureDir(path.join(root, 'runtime', 'eve'));
    fs.writeFileSync(path.join(eve, 'launch.mjs'), 'source launcher');
    expect(() => eveRuntimeFiles(root)).toThrow('eve:build');
    ensureDir(path.join(eve, '.output'));
    ensureDir(path.join(eve, '.eve', 'sandbox-cache'));
    fs.writeFileSync(path.join(eve, '.output', 'launch.mjs'), 'built launcher');
    expect(eveRuntimeFiles(root).entry).toBe(path.join(eve, '.output', 'launch.mjs'));
    ensureDir(path.join(eve, 'server'));
    fs.writeFileSync(path.join(eve, 'server', 'index.mjs'), 'bundled server');
    ensureDir(path.join(root, 'runtime', 'eve-sandbox-cache'));
    expect(eveRuntimeFiles(root)).toEqual({
      entry: path.join(eve, 'launch.mjs'),
      templates: path.join(root, 'runtime', 'eve-sandbox-cache'),
    });
  });
});
