// Messages you sent into a working Eve turn that were saved, but whose sending wasn't seen to finish (the app stopped
// in between). After a restart each one is found in Eve's record (Eve names a delivery after its idempotency key), or
// sent again under the same key (Eve takes a key once), or, when the turn can't take it any more, handed back to you:
// first in the chat's queue, saying it may not have reached the agent. A team's go back with the team's own work.
import crypto from 'node:crypto';
import type { Client, SessionSnapshot } from 'eve/client';
import { chats, listProjects, withProject } from '../store.ts';
import { readExecution, saveExecutionQueue } from '../execution.ts';
import { eveMessage } from './admission.ts';
import { readBinding, readRun, updateSteer } from './state.ts';
import type { EveSteer, ExecutionQueue } from '../../shared/types.ts';

/** The key a message sent into a turn goes with (steer.ts). */
export const steerKey = (steerId: string): string => `athena:steer:${steerId}`;

/** The delivery id Eve gives a message sent with this key (its deliveryIdForIdempotencyKey: a UUID made from
 *  SHA-256 of "eve:delivery:<key>"). */
export function deliveryIdForKey(key: string): string {
  const b = crypto.createHash('sha256').update(`eve:delivery:${key}`).digest().subarray(0, 16);
  b[6] = (b[6]! & 15) | 128;
  b[8] = (b[8]! & 63) | 128;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Your messages into this run's turn whose sending wasn't seen to finish. */
export function unsentSteers(runId: string): EveSteer[] {
  return (readRun(runId)?.steers || []).filter((s) => !s.deliveryId && !s.dropped && !s.teamMessageId);
}

/** The ones Eve's record shows it took: saved as taken, before the record is read again (so its turn finds them). */
export function matchUnsent(runId: string, snapshot: Pick<SessionSnapshot, 'events'>): void {
  const admitted = new Set(snapshot.events.flatMap((e) => (e.type === 'delivery.admitted' ? [e.data.deliveryId] : [])));
  for (const steer of unsentSteers(runId)) {
    const id = deliveryIdForKey(steerKey(steer.id));
    if (admitted.has(id)) updateSteer(runId, steer.id, { deliveryId: id });
  }
}

/** The rest, sent again into the turn going on: under the same key Eve takes each only once. One it won't take is
 *  handed back. */
export async function resendUnsent(runId: string, client: Pick<Client, 'fetch'>): Promise<void> {
  const run = readRun(runId);
  const binding = run && readBinding(run.bindingId);
  for (const steer of unsentSteers(runId)) {
    try {
      if (!run || !binding?.sessionId || !['running', 'waiting'].includes(readRun(runId)?.status || ''))
        throw new Error('The turn is over.');
      const message = await eveMessage(steer.text, steer.attachments);
      const response = await client.fetch(`/eve/v1/session/${encodeURIComponent(binding.sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, idempotencyKey: steerKey(steer.id), turnPolicy: 'steer' }),
        signal: AbortSignal.timeout(15000),
      });
      const receipt: unknown = response.ok ? await response.json() : null;
      const deliveryId = receipt && typeof receipt === 'object' && 'deliveryId' in receipt ? receipt.deliveryId : null;
      if (typeof deliveryId !== 'string' || !deliveryId) throw new Error('Eve did not take it.');
      updateSteer(runId, steer.id, { deliveryId });
    } catch {
      handBack(runId, steer);
    }
  }
}

/** Every one still unsent goes back to you (the turn ended, or its session did). */
export function handBackUnsent(runId: string): void {
  for (const steer of unsentSteers(runId)) handBack(runId, steer);
}

function handBack(runId: string, steer: EveSteer): void {
  const run = readRun(runId);
  const binding = run && readBinding(run.bindingId);
  updateSteer(runId, steer.id, { dropped: true });
  if (!binding) return;
  const project = listProjects().find((p) => p.id === binding.projectId);
  if (!project) return;
  // (it shows in the queue instead of in the turn it never reached)
  withProject(project, () => {
    const chat = chats.get(binding.agentId, binding.chatId);
    if (!chat) return;
    const items = chat.items.filter((i) => !(i.type === 'steer' && i.steerId === steer.id));
    if (items.length !== chat.items.length) chats.save({ ...chat, items });
  });
  const queue: ExecutionQueue = readExecution().queues.find(
    (q) => q.projectId === binding.projectId && q.chatId === binding.chatId,
  ) || {
    projectId: binding.projectId,
    agentId: binding.agentId,
    chatId: binding.chatId,
    items: [],
    priority: [],
    paused: true,
  };
  // first, and held: you decide whether it goes again
  saveExecutionQueue({
    ...queue,
    paused: true,
    items: [
      {
        id: steer.id,
        text: steer.text,
        ...(steer.attachments.length ? { attachments: steer.attachments } : {}),
        ...(steer.from ? { from: steer.from } : {}),
        unsent: true,
        ts: steer.at,
      },
      ...queue.items.filter((i) => i.id !== steer.id),
    ],
  });
}
