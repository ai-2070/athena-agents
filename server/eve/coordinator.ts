import { bus, emit } from '../store.ts';
import { readExecution } from '../execution.ts';
import { finishNativeRun, restoreNativeRun } from '../engines/index.ts';
import { eveRuntime } from './runtime.ts';
import { readBinding, readRun, sessionContext, settleRun } from './state.ts';
import { deliverApprovalDecisions, eveClient, observeEveEvent, reconcileSnapshot, stopEveRun } from './recovery.ts';
import { EveProjectionError } from './projection.ts';
import { projectTranscript } from './transcript.ts';
import type { EveHost } from './host.ts';
import type { ServerEvent } from '../../shared/types.ts';
import type { SessionSnapshot, SessionStreamEvent } from 'eve/client';

export interface EveConnection {
  snapshot(signal: AbortSignal): Promise<SessionSnapshot>;
  stream(startIndex: number, signal: AbortSignal): AsyncIterable<SessionStreamEvent>;
  decisions(): Promise<void>;
  stop(): Promise<void>;
}
export interface EveCoordinatorDependencies {
  ready(): Promise<EveHost>;
  connect(host: EveHost, runId: string): EveConnection;
  retryMs?: number;
}

const activeStatus = (status: string) => ['queued', 'running', 'waiting'].includes(status);
const projectionFailure = 'Eve returned a saved event Athena could not read. This run is paused. Check its results before continuing.';

/** Follows saved turns and delivers consent. It never submits a model message or starts a turn. */
export class EveCoordinator {
  private readonly dependencies: EveCoordinatorDependencies;
  private readonly abort = new AbortController();
  private readonly restored = new Set<string>();
  private readonly jobs = new Map<string, { abort: AbortController; promise: Promise<void>; wake: () => void }>();
  private started = false;

  constructor(dependencies: EveCoordinatorDependencies) { this.dependencies = dependencies; }

  restore(): void {
    for (const receipt of readExecution().runs) {
      const native = readRun(receipt.id);
      if (!native || receipt.settled) continue;
      try { projectTranscript(receipt.id); }
      catch (error) {
        if (error instanceof EveProjectionError) settleRun(receipt.id, 'interrupted', '', projectionFailure);
        else continue; // A deleted owner has no conversation to restore.
      }
      if (receipt.completionClaimed || ['interrupted', 'stopped'].includes(readRun(receipt.id)!.status)) continue;
      try {
        if (restoreNativeRun(receipt.id, async () => {
          // Stop is persisted synchronously, before any network acknowledgement.
          await stopEveRun(receipt.id);
          this.jobs.get(receipt.id)?.abort.abort();
          const host = await this.dependencies.ready();
          await this.dependencies.connect(host, receipt.id).stop();
        })) this.restored.add(receipt.id);
      } catch {
        settleRun(receipt.id, 'interrupted', '', 'The saved run no longer matches its conversation. Check its results before continuing.');
        void stopEveRun(receipt.id);
      }
    }
  }

  start(): void {
    if (this.started || this.abort.signal.aborted) return;
    this.started = true;
    bus.on('event', this.onEvent);
    for (const id of this.restored) this.follow(id);
  }

  follow(runId: string): Promise<void> {
    const existing = this.jobs.get(runId);
    if (existing) return existing.promise;
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, this.abort.signal]);
    const job = { abort, promise: Promise.resolve(), wake: () => {} };
    this.jobs.set(runId, job);
    job.promise = this.watch(runId, signal, (wake) => { job.wake = wake; }).finally(() => this.jobs.delete(runId));
    // A caller may follow via nativeRunPromise; background transport errors never escape.
    void job.promise.catch(() => {});
    return job.promise;
  }

  private readonly onEvent = (event: ServerEvent) => {
    if (event.type === 'approvals' || event.type === 'questions') for (const job of this.jobs.values()) job.wake();
  };

  private async watch(runId: string, signal: AbortSignal, setWake: (wake: () => void) => void): Promise<void> {
    let attempts = 0;
    while (!this.abort.signal.aborted) {
      let connection: EveConnection | undefined;
      const local = new AbortController();
      const reading = AbortSignal.any([local.signal, signal]);
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        const saved = readRun(runId);
        if (!saved) return;
        if (activeStatus(saved.status)) {
          try { sessionContext(saved.bindingId); }
          catch {
            settleRun(runId, 'interrupted', '', 'The run owner or conversation is no longer available.');
            await stopEveRun(runId);
            finishNativeRun(runId);
            await this.dependencies.ready().then((host) => this.dependencies.connect(host, runId).stop()).catch(() => {});
            return;
          }
        }
        try { projectTranscript(runId); }
        catch (error) {
          if (error instanceof EveProjectionError) throw error;
          finishNativeRun(runId);
          return;
        }
        if (!activeStatus(saved.status)) {
          finishNativeRun(runId);
          if (saved.status === 'stopped' || saved.status === 'interrupted') {
            const host = await this.dependencies.ready();
            await this.dependencies.connect(host, runId).stop();
          }
          return;
        }
        if (signal.aborted) return;
        const host = await this.dependencies.ready();
        void host.exited.then(() => local.abort());
        connection = this.dependencies.connect(host, runId);
        reconcileSnapshot(runId, await connection.snapshot(reading));
        projectTranscript(runId);
        if (!activeStatus(readRun(runId)!.status)) { finishNativeRun(runId); return; }
        let sending = false;
        const wake = () => {
          if (sending || reading.aborted) return;
          sending = true;
          void connection!.decisions().catch(() => local.abort()).finally(() => { sending = false; });
        };
        setWake(wake);
        timer = setInterval(wake, 1000);
        timer.unref();
        wake();
        const cursor = readRun(runId)!.cursor;
        for await (const event of connection.stream(cursor?.line || 0, reading)) {
          observeEveEvent(runId, event);
          projectTranscript(runId);
          if (!activeStatus(readRun(runId)!.status)) { finishNativeRun(runId); return; }
          if (event.type === 'interaction.opened') wake();
          attempts = 0;
        }
      } catch (error) {
        if (error instanceof EveProjectionError) {
          settleRun(runId, 'interrupted', '', projectionFailure);
          await stopEveRun(runId);
          finishNativeRun(runId);
          await connection?.stop().catch(() => {});
          return;
        }
        // A disconnected stream is still the same run, never a replacement model request.
        const binding = readBinding(readRun(runId)?.bindingId || '');
        if (!signal.aborted) emit('run', { runId, agentId: binding?.agentId, chatId: binding?.chatId, event: { kind: 'status', text: 'Reconnecting to Eve…' } });
      } finally {
        local.abort();
        clearInterval(timer);
        setWake(() => {});
        void eveRuntime.retireBindings().catch(() => {});
      }
      if (this.abort.signal.aborted) return;
      if (signal.aborted) {
        finishNativeRun(runId);
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(5000, (this.dependencies.retryMs ?? 250) * 2 ** Math.min(attempts++, 4)));
        const onAbort = () => done();
        const lifetime = this.abort.signal;
        function done() { clearTimeout(timer); lifetime.removeEventListener('abort', onAbort); resolve(); }
        lifetime.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  async close(): Promise<void> {
    this.abort.abort();
    bus.off('event', this.onEvent);
    await Promise.allSettled([...this.jobs.values()].map((job) => job.promise));
  }
}

export function eveConnection(host: EveHost, runId: string): EveConnection {
  const run = readRun(runId);
  const binding = run && readBinding(run.bindingId);
  if (!run || !binding?.sessionId) throw new Error('The saved Eve session is missing.');
  const client = eveClient(host, binding.id);
  const session = client.sessions.attach(binding.sessionId);
  return {
    snapshot: (signal) => session.snapshot({ signal }),
    stream: (startIndex, signal) => session.stream({ startIndex, signal, reconnect: false }),
    decisions: () => deliverApprovalDecisions(runId, client),
    stop: () => stopEveRun(runId, client),
  };
}

export const eveCoordinator = new EveCoordinator({
  ready: () => eveRuntime.ready(),
  connect: eveConnection,
});
