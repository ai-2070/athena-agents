import { activeProject } from '../store.ts';
import { isStopping } from './index.ts';
import { eveRuntime } from '../eve/runtime.ts';
import type { EveHost } from '../eve/host.ts';
import { eveCoordinator } from '../eve/coordinator.ts';
import { prepareAdmission, submitAdmission, validAdmission } from '../eve/admission.ts';
import { eveClient, stopEveRun, retireEveBindings } from '../eve/recovery.ts';
import { canSteer, sendSteer } from '../eve/steer.ts';
import { adoptRun, failureText, readBinding, readRun } from '../eve/state.ts';
import { status } from '../providers.ts';
import { contextWindow } from '../context.ts';
import type { EngineRunArgs, EngineResult, TurnSteering } from './index.ts';
import { eveUsage } from '../eve/usage.ts';
export { status };
export const durable = true;

/** A message sent while it works joins the turn going on (server/eve/steer.ts). */
export const steer: TurnSteering = {
  can: (runId) => canSteer(runId),
  send: async (runId, message) => void (await sendSteer(runId, { ...message, attachments: message.attachments || [] })),
};

/** How long a run following a turn Eve started with a late message waits for that turn to begin. */
export const ADOPT_WAIT = { ms: 60_000 };

/** How long Eve may keep refusing a message before the run gives up (Eve normally takes one at once). Past it the
 *  session is retired, so sending again starts a fresh one: a session Eve can no longer take messages on must not
 *  leave the agent "working" forever. */
export const SEND_WAIT = { ms: 120_000 };

/** Delivery retries are transport recovery; Eve owns every model and tool step. */
export async function run({ runId, signal, adopt, depth, agent, chat }: EngineRunArgs): Promise<EngineResult> {
  if (adopt) return follow(runId, signal, adopt, depth, await contextWindow(agent, chat));
  const project = activeProject();
  let host = await eveRuntime.ready();
  signal.throwIfAborted();
  const input = await prepareAdmission(runId, project);
  const binding = readBinding(input.bindingId)!;
  await retireEveBindings(host, binding);
  return followRun(
    runId,
    input.bindingId,
    signal,
    input.selection.contextWindow,
    async () => {
      const giveUp = Date.now() + SEND_WAIT.ms;
      for (;;) {
        signal.throwIfAborted();
        try {
          await submitAdmission(input, eveClient(host, input.bindingId), signal);
          return host;
        } catch {
          const saved = readRun(runId);
          if (
            signal.aborted ||
            !saved ||
            ['failed', 'stopped', 'interrupted'].includes(saved.status) ||
            !validAdmission(runId)
          )
            throw new Error('Eve could not accept this input.');
          if (Date.now() >= giveUp) {
            await stopEveRun(runId, eveClient(host, input.bindingId)).catch(() => {});
            throw new Error(
              `Eve did not take this message in ${Math.round(SEND_WAIT.ms / 60_000)} minutes, so it was stopped. Send it again: it starts a fresh session with the same chat.`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
          try {
            host = await eveRuntime.ready();
          } catch {
            signal.throwIfAborted();
          }
        }
      }
    },
    host,
  );
}

/** A turn Eve already started with a message that missed the turn before it: nothing to send, only to follow.
 *  If that turn never begins (the session broke), it gives up rather than wait forever. */
async function follow(
  runId: string,
  signal: AbortSignal,
  adopt: NonNullable<EngineRunArgs['adopt']>,
  depth: number,
  window: number,
): Promise<EngineResult> {
  const host = await eveRuntime.ready();
  signal.throwIfAborted();
  adoptRun(runId, adopt.bindingId, adopt.deliveryId, depth, null, adopt.steers);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const began = new Promise<never>((_, reject) => {
    const check = (waited: number) => {
      if (readRun(runId)?.turnId) return;
      if (waited >= ADOPT_WAIT.ms) {
        void stopEveRun(runId, eveClient(host, adopt.bindingId)).catch(() => {});
        return reject(new Error('Eve did not start the turn with your message. Send it again.'));
      }
      timer = setTimeout(() => check(waited + 250), 250);
    };
    check(0);
  });
  began.catch(() => {});
  try {
    return await followRun(runId, adopt.bindingId, signal, window, async () => host, host, began);
  } finally {
    clearTimeout(timer);
  }
}

/** Sends the input (start), then follows the run until it ends; Stop stops it in Eve too. */
async function followRun(
  runId: string,
  bindingId: string,
  signal: AbortSignal,
  window: number,
  start: () => Promise<EveHost>,
  host: EveHost,
  watch?: Promise<never>,
): Promise<EngineResult> {
  const stopped = () => {
    if (!isStopping()) void stopEveRun(runId);
  };
  signal.addEventListener('abort', stopped, { once: true });
  try {
    host = await start();
    let aborted = () => {};
    try {
      await Promise.race([
        eveCoordinator.follow(runId),
        ...(watch ? [watch] : []),
        new Promise<never>((_, reject) => {
          aborted = () => reject(new Error('Stopped.'));
          if (signal.aborted) aborted();
          else signal.addEventListener('abort', aborted, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener('abort', aborted);
    }
    const result = readRun(runId);
    if (signal.aborted || result?.status !== 'completed') throw new Error(failureText(result));
    return { text: result.answer || '', ...eveUsage(runId), ...(window ? { window } : {}) };
  } finally {
    signal.removeEventListener('abort', stopped);
    if (signal.aborted && !isStopping()) await stopEveRun(runId, eveClient(host, bindingId)).catch(() => {});
  }
}
