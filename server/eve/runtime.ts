import path from 'node:path';
import { exists, ROOT, which } from '../util.ts';
import { log } from '../store.ts';
import { privateDataPath } from '../private.ts';
import { openEveBridge } from './bridge.ts';
import { startEveHost } from './host.ts';
import { activeEveRuns, eveRuns, readBinding, sessionBindings } from './state.ts';
import { prepareEveRecovery, recoverEveRuns, retireEveBindings } from './recovery.ts';
import { claimEveRuntime, EveOwnershipError } from './ownership.ts';
import type { EveHost } from './host.ts';

type Bridge = Awaited<ReturnType<typeof openEveBridge>>;
export interface EveRuntimeDependencies {
  claim?(): Promise<() => Promise<void>>;
  bridge(): Promise<Bridge>;
  host(bridge: Bridge, signal: AbortSignal): Promise<EveHost>;
  prepare(): void;
  recover(host: EveHost): Promise<unknown>;
  hasWork(): boolean;
  retryMs?: number;
}

/** Source and relocated desktop builds share the same supervisor and bundled Bun. */
export function eveRuntimeFiles(root = ROOT): { entry: string; templates: string } {
  const staged = path.join(root, 'runtime', 'eve');
  const desktop = exists(path.join(staged, 'server', 'index.mjs'));
  const entry = path.join(staged, ...(desktop ? [] : ['.output']), 'launch.mjs');
  const templates = desktop ? path.join(root, 'runtime', 'eve-sandbox-cache') : path.join(staged, '.eve', 'sandbox-cache');
  if (!exists(entry) || !exists(templates)) throw new Error('The Eve runtime is missing. Run bun run eve:build first.');
  return { entry, templates };
}

const hasSavedWork = () => sessionBindings().some((binding) => binding.sessionId && !binding.runtimeEnded) || activeEveRuns().length > 0 || eveRuns().some((run) => {
  const binding = readBinding(run.bindingId);
  return run.status === 'stopped' && !!binding?.sessionId && !binding.runtimeEnded;
});

/** One private worker. Readiness includes recovery, so a new run cannot overtake saved work. */
export class EveRuntime {
  private bridge: Bridge | undefined;
  private host: EveHost | undefined;
  private starting: Promise<EveHost> | undefined;
  private stopping: Promise<void> | undefined;
  private release: (() => Promise<void>) | undefined;
  private readonly abort = new AbortController();
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private readonly dependencies: EveRuntimeDependencies;

  constructor(dependencies: EveRuntimeDependencies) {
    this.dependencies = dependencies;
  }

  async recover(): Promise<void> {
    if (this.dependencies.hasWork()) await this.ready();
  }

  ready(): Promise<EveHost> {
    if (this.abort.signal.aborted) return Promise.reject(new Error('The Eve runtime is stopping.'));
    if (this.starting) return this.starting;
    if (this.host) return Promise.resolve(this.host);
    clearTimeout(this.retry);
    this.retry = undefined;
    const starting = this.start();
    this.starting = starting;
    void starting.finally(() => {
      if (this.starting === starting) this.starting = undefined;
    }).catch(() => {});
    return starting;
  }

  private async start(): Promise<EveHost> {
    let host: EveHost | undefined;
    let exited = false;
    try {
      this.release ||= await this.dependencies.claim?.();
      // A worker starts its saved queue immediately; reconcile before launching it.
      this.dependencies.prepare();
      this.abort.signal.throwIfAborted();
      this.bridge ||= await this.dependencies.bridge();
      this.abort.signal.throwIfAborted();
      host = await this.dependencies.host(this.bridge, this.abort.signal);
      const owned = host;
      const stopped = host.exited.then(() => {
        exited = true;
        if (this.host === owned) this.host = undefined;
        this.scheduleRetry();
        throw new Error('The Eve worker exited.');
      });
      await Promise.race([this.dependencies.recover(host), stopped]);
      this.abort.signal.throwIfAborted();
      if (exited) throw new Error('The Eve worker exited.');
      this.host = host;
      this.attempts = 0;
      return host;
    } catch (error) {
      await host?.close();
      this.scheduleRetry();
      if (error instanceof EveOwnershipError) throw error;
      throw new Error('Eve could not restore saved work. Check that its runtime is built, then try again.');
    }
  }

  private scheduleRetry(): void {
    if (this.abort.signal.aborted || this.retry || !this.dependencies.hasWork()) return;
    const delay = Math.min(10000, (this.dependencies.retryMs ?? 500) * 2 ** Math.min(this.attempts++, 5));
    this.retry = setTimeout(() => {
      this.retry = undefined;
      void this.ready().catch(() => log('error', 'Eve could not restore saved work. It will try again.'));
    }, delay);
    this.retry.unref();
  }

  close(): Promise<void> {
    return this.stopping ??= this.stop();
  }

  async retireBindings(): Promise<void> {
    if (this.abort.signal.aborted) return;
    const host = this.host || await this.starting?.catch(() => undefined);
    if (host) await retireEveBindings(host);
  }

  private async stop(): Promise<void> {
    const host = this.host;
    this.host = undefined;
    this.abort.abort();
    clearTimeout(this.retry);
    this.retry = undefined;
    await this.starting?.catch(() => {});
    try { await host?.close(); }
    finally {
      try { await this.bridge?.close(); }
      finally {
        this.bridge = undefined;
        await this.release?.();
        this.release = undefined;
      }
    }
  }
}

export const eveRuntime = new EveRuntime({
  claim: claimEveRuntime,
  bridge: openEveBridge,
  host: (bridge, signal) => {
    const executable = process.versions.bun ? process.execPath : which('bun');
    if (!executable) throw new Error('Bun 1.4 or newer is required for Eve.');
    return startEveHost({ ...eveRuntimeFiles(), executable, directory: privateDataPath('runtime', 'eve', 'worker'), bridgeUrl: bridge.url, bridgeToken: bridge.token, signal });
  },
  prepare: prepareEveRecovery,
  recover: recoverEveRuns,
  hasWork: hasSavedWork,
});
