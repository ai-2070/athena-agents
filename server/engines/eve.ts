import { activeProject } from '../store.ts';
import { isStopping } from './index.ts';
import { eveRuntime } from '../eve/runtime.ts';
import { eveCoordinator } from '../eve/coordinator.ts';
import { prepareAdmission, submitAdmission, validAdmission } from '../eve/admission.ts';
import { eveClient, stopEveRun, retireEveBindings } from '../eve/recovery.ts';
import { readBinding, readRun } from '../eve/state.ts';
import { status } from '../providers.ts';
import type { EngineRunArgs, EngineResult } from './index.ts';
import { eveUsage } from '../eve/usage.ts';
export { status };
export const durable = true;

/** Delivery retries are transport recovery; Eve owns every model and tool step. */
export async function run({ runId, signal }: EngineRunArgs): Promise<EngineResult> {
  const project = activeProject();
  let host = await eveRuntime.ready();
  signal.throwIfAborted();
  const input = await prepareAdmission(runId, project);
  const binding = readBinding(input.bindingId)!;
  await retireEveBindings(host, binding);
  const stopped = () => { if (!isStopping()) void stopEveRun(runId); };
  signal.addEventListener('abort', stopped, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      try {
        await submitAdmission(input, eveClient(host, input.bindingId), signal);
        break;
      } catch {
        const saved = readRun(runId);
        if (signal.aborted || !saved || ['failed', 'stopped', 'interrupted'].includes(saved.status) || !validAdmission(runId)) throw new Error('Eve could not accept this input.');
        await new Promise((resolve) => setTimeout(resolve, 250));
        try { host = await eveRuntime.ready(); }
        catch { signal.throwIfAborted(); }
      }
    }
    let aborted = () => {};
    try {
      await Promise.race([eveCoordinator.follow(runId), new Promise<never>((_, reject) => {
        aborted = () => reject(new Error('Stopped.'));
        if (signal.aborted) aborted();
        else signal.addEventListener('abort', aborted, { once: true });
      })]);
    } finally { signal.removeEventListener('abort', aborted); }
    const result = readRun(runId);
    if (signal.aborted || result?.status !== 'completed') throw new Error(result?.limitReason || 'Eve could not finish this work. Check its saved results before continuing.');
    return { text: result.answer || '', ...eveUsage(runId), window: input.selection.contextWindow };
  } finally {
    signal.removeEventListener('abort', stopped);
    if (signal.aborted && !isStopping()) await stopEveRun(runId, eveClient(host, input.bindingId)).catch(() => {});
  }
}
