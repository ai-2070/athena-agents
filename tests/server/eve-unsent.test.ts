// A message you sent into a working Eve turn, saved but not seen to arrive (the app stopped in between): after a
// restart it is found in Eve's record, sent again under the same key, or handed back to you first in the chat's
// queue, held, saying it may not have reached the agent (BH-063).
import { describe, expect, it, vi } from 'vitest';
import { activeProject, agents, chats } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { attachSession, beginRun, bindSession, readRun, recordSteer, setRunStatus } from '../../server/eve/state.ts';
import { deliveryIdForKey, handBackUnsent, matchUnsent, resendUnsent, steerKey } from '../../server/eve/unsent.ts';
import { readExecution } from '../../server/execution.ts';
import { recoverEveRuns } from '../../server/eve/recovery.ts';
import type { SessionSnapshot } from 'eve/client';

// Eve's own: the id it gives a delivery sent with an idempotency key
const eve = (await import('../../node_modules/eve/dist/src/channel/delivery-idempotency.js')) as {
  deliveryIdForIdempotencyKey: (key: string) => Promise<string>;
};

/** A working run in a chat, with a message sent into its turn and saved, its sending not seen to finish. */
function runWithUnsent(runId: string) {
  const agent = agents.save(newAgent({ engine: 'eve', name: `Agent ${runId}`, toolGroups: [] }));
  const chat = chats.create(agent.id, 'A chat');
  chat.items.push({ type: 'steer', steerId: `s-${runId}`, text: 'Use PostgreSQL instead.', runId });
  chats.save(chat);
  const binding = bindSession(agent, chat, activeProject(), 'proof');
  attachSession(binding.id, `${runId}-session`);
  beginRun(runId, binding.id);
  setRunStatus(runId, 'running', `${runId}-delivery`);
  recordSteer(runId, {
    id: `s-${runId}`,
    text: 'Use PostgreSQL instead.',
    attachments: [],
    deliveryId: null,
    at: 5,
  });
  return { agent, chat, steerId: `s-${runId}` };
}
const steerOf = (runId: string, id: string) => readRun(runId)?.steers?.find((s) => s.id === id);
const snapshot = (deliveryIds: string[]) =>
  ({
    events: deliveryIds.map((deliveryId) => ({ type: 'delivery.admitted', data: { deliveryId } })),
  }) as unknown as SessionSnapshot;

describe('messages sent into a turn just before a restart (BH-063)', () => {
  it("names a message's delivery the way Eve does", async () => {
    for (const key of ['athena:steer:s1', steerKey('abc-123'), 'x'])
      expect(deliveryIdForKey(key)).toBe(await eve.deliveryIdForIdempotencyKey(key));
  });

  it("one Eve's record shows it took is marked delivered, and not sent again", async () => {
    const { steerId } = runWithUnsent('took');
    matchUnsent('took', snapshot(['other', deliveryIdForKey(steerKey(steerId))]));
    expect(steerOf('took', steerId)?.deliveryId).toBe(deliveryIdForKey(steerKey(steerId)));
    const sent: string[] = [];
    await resendUnsent('took', { fetch: async (url: string | URL) => (sent.push(String(url)), new Response('{}')) });
    expect(sent).toEqual([]);
  });

  it('one it has no record of goes again into the turn, under the same key', async () => {
    const { steerId } = runWithUnsent('again');
    matchUnsent('again', snapshot(['other']));
    const bodies: { idempotencyKey?: string; turnPolicy?: string }[] = [];
    await resendUnsent('again', {
      fetch: async (_url: string | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ sessionId: 'again-session', deliveryId: 'd-again' }));
      },
    });
    expect(bodies).toMatchObject([{ idempotencyKey: steerKey(steerId), turnPolicy: 'steer' }]);
    expect(steerOf('again', steerId)?.deliveryId).toBe('d-again');
  });

  it("one that can't go again comes back to you first in the chat's queue, held, and leaves the turn", async () => {
    const { agent, chat, steerId } = runWithUnsent('back');
    await resendUnsent('back', { fetch: async () => new Response('{"error":"no"}', { status: 409 }) });
    expect(steerOf('back', steerId)?.dropped).toBe(true);
    const queue = readExecution().queues.find((q) => q.chatId === chat.id)!;
    expect(queue.paused).toBe(true);
    expect(queue.items[0]).toMatchObject({ id: steerId, text: 'Use PostgreSQL instead.', unsent: true });
    expect(chats.get(agent.id, chat.id)?.items.some((i) => i.type === 'steer')).toBe(false);
  });

  it('with its turn ended by the restart, it comes back to you', () => {
    const { chat, steerId } = runWithUnsent('ended');
    setRunStatus('ended', 'interrupted');
    handBackUnsent('ended');
    expect(readExecution().queues.find((q) => q.chatId === chat.id)?.items[0]).toMatchObject({
      id: steerId,
      unsent: true,
    });
  });

  it('recovery after a restart hands back one whose turn the restart ended', async () => {
    const { chat, steerId } = runWithUnsent('restarted');
    // (this one, and the runs above, were cut off by the restart: no session to read back here)
    for (const id of ['took', 'again', 'back', 'ended', 'restarted']) setRunStatus(id, 'interrupted');
    const transport = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    try {
      await recoverEveRuns({ url: 'http://127.0.0.1:9876', token: 'fixture' });
    } finally {
      transport.mockRestore();
    }
    expect(steerOf('restarted', steerId)?.dropped).toBe(true);
    expect(readExecution().queues.find((q) => q.chatId === chat.id)?.items[0]).toMatchObject({
      id: steerId,
      unsent: true,
    });
  });
});
