// What waits for you (server/api/needs.ts): the questions agents asked you (ask_user) and the permission requests
// they made. The questions are also answered under /api/p/<project> for a project that isn't open.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { AgentQuestion, Approval } from '../types.ts';

const oneItem = z.object({ id: z.string() });

export const questions = {
  /** The latest 100, newest first. */
  list: oc.route({ method: 'GET', path: '/questions' }).output(type<AgentQuestion[]>()),
  /** A choice, your own words, or both; it goes to the agent's chat (or its team's) if it stopped waiting. */
  answer: oc.route({ method: 'POST', path: '/questions/{id}/answer' })
    .input(oneItem.extend({ choice: z.string({ error: 'choice must be one of its choices.' }).optional(), text: z.string({ error: 'Type your answer.' }).optional() }))
    .output(type<AgentQuestion>()),
  dismiss: oc.route({ method: 'POST', path: '/questions/{id}/dismiss' }).input(oneItem).output(type<AgentQuestion>()),
  remove: oc.route({ method: 'DELETE', path: '/questions/{id}' }).input(oneItem).output(type<{ ok: true }>()),
};

export const approvals = {
  /** What waits for you (requests the Brain is still checking aren't shown yet). */
  list: oc.route({ method: 'GET', path: '/approvals' }).output(type<Approval[]>()),
  /** Allow or deny, with a note for the agent; always: allow it from now on; edited: the text, changed (a workflow's
   *  approval step). ok: false when it was already decided. */
  decide: oc.route({ method: 'POST', path: '/approvals/{id}' })
    .input(oneItem.extend({
      approved: z.boolean({ error: 'approved must be true or false.' }).optional(),
      always: z.boolean({ error: 'always must be true or false.' }).optional(),
      message: z.string({ error: 'The note must be text.' }).optional(),
      edited: z.string({ error: 'The changed text must be text.' }).nullable().optional(),
    }))
    .output(type<{ ok: boolean }>()),
};
