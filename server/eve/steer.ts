// Steering an Eve turn: a message sent while an agent works joins the turn going on (Eve's own
// turnPolicy "steer") instead of stopping it. It is saved on the run before it is sent, and the run's
// events say whether its turn took it (joinDelivery). One that reached Eve just as the turn ended
// starts the next turn instead: in an agent chat a new run follows that turn (takeOverSteers in
// engines/index.ts); in a team's turn the message comes back to be sent the ordinary way (missedSteers).
import { eveRuntime } from './runtime.ts';
import { eveClient } from './recovery.ts';
import { eveMessage } from './admission.ts';
import { lateSteers, readBinding, readRun, recordSteer, retireSession, updateSteer } from './state.ts';
import type { EveSteer } from '../../shared/types.ts';

/** Whether a message can join this run's turn now: it is working (not waiting on you, not ending) in a live session. */
export function canSteer(runId: string): boolean {
  const run = readRun(runId);
  const binding = run && readBinding(run.bindingId);
  return (
    !!run &&
    !!binding &&
    run.status === 'running' &&
    !run.pendingTerminal &&
    !!run.deliveryId &&
    !!binding.sessionId &&
    !binding.retired &&
    !binding.retiring &&
    !binding.runtimeEnded
  );
}

/** Sends the message into the run's turn. Throws when Eve didn't take it: the caller sends it the
 *  ordinary way (stopping the run, which ends the session, so one Eve took after all never runs twice). */
export async function sendSteer(
  runId: string,
  steer: Pick<EveSteer, 'id' | 'text' | 'attachments' | 'from' | 'teamMessageId'>,
): Promise<EveSteer> {
  if (!canSteer(runId)) throw new Error('This turn can no longer take a message.');
  // (read before anything is saved: a missing file sends nothing)
  const message = await eveMessage(steer.text, steer.attachments);
  // reading attached documents takes a while, and the turn may have ended meanwhile: looked at again, and saved
  // with nothing awaited in between, so the end of the turn either finds the message or it is sent the ordinary way
  const run = readRun(runId);
  const binding = run && readBinding(run.bindingId);
  if (!run || !binding?.sessionId || !canSteer(runId)) throw new Error('This turn can no longer take a message.');
  recordSteer(runId, { ...steer, deliveryId: null, at: Date.now() });
  try {
    const host = await eveRuntime.ready();
    const response = await eveClient(host, binding.id).fetch(
      `/eve/v1/session/${encodeURIComponent(binding.sessionId)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, idempotencyKey: `athena:steer:${steer.id}`, turnPolicy: 'steer' }),
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error('Eve did not take the message.');
    const receipt: unknown = await response.json();
    const sessionId = receipt && typeof receipt === 'object' && 'sessionId' in receipt ? receipt.sessionId : null;
    const deliveryId = receipt && typeof receipt === 'object' && 'deliveryId' in receipt ? receipt.deliveryId : null;
    if (sessionId !== binding.sessionId || typeof deliveryId !== 'string' || !deliveryId)
      throw new Error('Eve returned an invalid receipt for the message.');
    return updateSteer(runId, steer.id, { deliveryId })!;
  } catch (error) {
    updateSteer(runId, steer.id, { dropped: true });
    throw error;
  }
}

/** Messages sent into a turn that ended before it took them, in work someone waits on (a team's turn).
 *  The turn Eve would start with them never runs: its session ends (the next turn starts a new one with the
 *  saved conversation), and they come back to be sent the ordinary way. Waits for any still being sent. */
export async function missedSteers(runId: string): Promise<EveSteer[]> {
  for (
    let waited = 0;
    waited < 20000 && readRun(runId)?.steers?.some((steer) => !steer.deliveryId && !steer.dropped);
    waited += 50
  )
    await new Promise((resolve) => setTimeout(resolve, 50));
  const late = lateSteers(runId);
  const run = readRun(runId);
  if (!late.length || !run) return [];
  for (const steer of late) updateSteer(runId, steer.id, { dropped: true });
  retireSession(run.bindingId);
  void eveRuntime.retireBindings().catch(() => {});
  return late;
}
