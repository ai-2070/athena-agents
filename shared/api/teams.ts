// A team's chat (server/api/teams.ts): its thread, your messages and the held /queue ones, steering it while it
// works, and its / commands. Also answered under /api/p/<project> for a project that isn't open. (The teams
// themselves are shared/api/workflows.ts.)
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { BrainBrief, LoopInfo, QueuedMessage, TeamChat, TeamMessage, ThreadSummary } from '../types.ts';

const oneTeam = z.object({ id: z.string() });
const oneThread = oneTeam.extend({ chatId: z.string({ error: 'Say which chat.' }) });
const message = {
  text: z.string({ error: 'Type a message first.' }).optional(),
  /** the message it answers */
  replyTo: z.string({ error: 'replyTo must name a message.' }).nullable().optional(),
  attachments: z.array(z.string(), { error: 'attachments must be a list.' }).optional(),
};
/** Posted now ({ message }), or held because someone in the team is working ({ queued }). */
type Posted = { message: TeamMessage } | { queued: QueuedMessage };

export const teams = {
  chat: oc.route({ method: 'GET', path: '/teams/{id}/chat' }).input(oneTeam).output(type<TeamChat>()),
  send: oc.route({ method: 'POST', path: '/teams/{id}/messages' }).input(oneTeam.extend(message)).output(type<TeamMessage>()),
  /** /queue: posted once nobody in the team is working (now, if nobody is). */
  queue: oc.route({ method: 'POST', path: '/teams/{id}/queue' }).input(oneTeam.extend(message)).output(type<Posted>()),
  /** A held message taken back, its words changed (queued: null when it already went), or the order they go in. */
  unqueue: oc.route({ method: 'DELETE', path: '/teams/{id}/queue/{queueId}' })
    .input(oneTeam.extend({ queueId: z.string() }))
    .output(type<{ unqueued: QueuedMessage[] }>()),
  editQueued: oc.route({ method: 'PUT', path: '/teams/{id}/queue/{queueId}' })
    .input(oneTeam.extend({ queueId: z.string(), text: z.string({ error: 'Type the message.' }) }))
    .output(type<{ queued: QueuedMessage | null }>()),
  orderQueue: oc.route({ method: 'POST', path: '/teams/{id}/queue/order' })
    .input(oneTeam.extend({ ids: z.array(z.string(), { error: 'ids must be a list.' }) }))
    .output(type<{ held: QueuedMessage[] }>()),
  /** A message while the team works: whoever is working stops and takes it up now. */
  steer: oc.route({ method: 'POST', path: '/teams/{id}/steer' }).input(oneTeam.extend(message)).output(type<TeamMessage>()),
  resend: oc.route({ method: 'POST', path: '/teams/{id}/resend' }).input(oneTeam).output(type<Posted>()),
  resume: oc.route({ method: 'POST', path: '/teams/{id}/resume' }).input(oneTeam).output(type<{ resumed: true }>()),
  /** /learn: the member best placed for it turns it (and the files) into a skill. */
  learn: oc.route({ method: 'POST', path: '/teams/{id}/learn' })
    .input(oneTeam.extend({ text: message.text, attachments: message.attachments }))
    .output(type<Posted>()),
  loop: oc.route({ method: 'POST', path: '/teams/{id}/loop' })
    .input(oneTeam.extend({ text: message.text, attachments: message.attachments }))
    .output(type<{ loop: LoopInfo | null }>()),
  stopLoop: oc.route({ method: 'DELETE', path: '/teams/{id}/loop' }).input(oneTeam).output(type<{ ok: boolean }>()),
  goal: oc.route({ method: 'POST', path: '/teams/{id}/goal' })
    .input(oneTeam.extend({ text: z.string({ error: 'Say what done looks like.' }) }))
    .output(type<{ goal: BrainBrief | null }>()),
  clearGoal: oc.route({ method: 'DELETE', path: '/teams/{id}/goal' }).input(oneTeam).output(type<{ goal: BrainBrief | null }>()),
  /** Stops its work: your held /queue messages come back to you. */
  stop: oc.route({ method: 'POST', path: '/teams/{id}/stop' }).input(oneTeam).output(type<{ ok: boolean; unqueued: QueuedMessage[] }>()),
  /** Empties its thread. */
  clear: oc.route({ method: 'POST', path: '/teams/{id}/clear' }).input(oneTeam).output(type<{ ok: true }>()),
  /** Its conversations: the open thread first, then the past ones, newest first. */
  threads: oc.route({ method: 'GET', path: '/teams/{id}/chats' }).input(oneTeam).output(type<ThreadSummary[]>()),
  /** New chat: the thread is kept with the others (work going on in it stops), and an empty one opens. */
  newThread: oc.route({ method: 'POST', path: '/teams/{id}/chats' }).input(oneTeam).output(type<{ id: string }>()),
  /** Opens a past conversation (work going on in the open thread stops). */
  openThread: oc.route({ method: 'POST', path: '/teams/{id}/chats/{chatId}/open' }).input(oneThread).output(type<{ id: string }>()),
  /** Deletes a conversation, and the agents forget it (the open one is emptied). */
  removeThread: oc.route({ method: 'DELETE', path: '/teams/{id}/chats/{chatId}' }).input(oneThread).output(type<{ ok: true }>()),
};
