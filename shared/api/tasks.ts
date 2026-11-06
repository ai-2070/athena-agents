// The step lists agents, teams and the Brain keep while they work (server/api/tasks.ts), as the chat's task panel
// shows and changes them. Not the Tasks board (taskboard.ts). Also answered under /api/p/<project> for a project
// that isn't open. server/tasks.ts checks what comes in, in the same words the agents' tools get.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { TaskPage, WorkTask } from '../types.ts';

const scope = z.object({ kind: z.enum(['brain', 'agent', 'team'], { error: 'A task list is the Brain\'s, an agent\'s or a team\'s.' }), id: z.string().optional() });
const words = (field: string) => z.string({ error: `${field} must be text.` }).optional();
const ids = (field: string) => z.array(z.string(), { error: `${field} must be a list of task ids.` }).optional();
const status = z.enum(['pending', 'in_progress', 'completed', 'deleted'], { error: 'Invalid task status.' });

export const tasks = {
  /** view: 'all', 'brain', 'agent:<id>', 'team:<id>' or an owner; status: 'open', 'all' or one status. */
  list: oc.route({ method: 'GET', path: '/tasks' })
    .input(z.object({ view: z.string().optional(), status: z.enum(['all', 'open', ...status.options], { error: 'Invalid task status.' }).optional(), search: z.string().optional(), offset: z.coerce.number().optional(), limit: z.coerce.number().optional() }))
    .output(type<TaskPage>()),
  get: oc.route({ method: 'GET', path: '/tasks/{id}' }).input(z.object({ id: z.string() })).output(type<{ task: WorkTask }>()),
  /** A task in a list (the Brain's unless scope says); chatId: the agent's chat it is for, so a /goal there counts it. */
  create: oc.route({ method: 'POST', path: '/tasks' })
    .input(z.object({
      subject: words('subject'),
      description: words('description'),
      activeForm: words('activeForm'),
      owner: words('owner'),
      metadata: z.record(z.string(), z.unknown(), { error: 'metadata must be an object.' }).optional(),
      scope: scope.optional(),
      chatId: z.string().optional(),
    }))
    .output(type<{ task: WorkTask }>()),
  /** expectedUpdatedAt: refused (409) when it changed since. */
  change: oc.route({ method: 'PUT', path: '/tasks/{id}' })
    .input(z.object({
      id: z.string(),
      status: status.optional(),
      subject: words('subject'),
      description: words('description'),
      activeForm: words('activeForm'),
      owner: words('owner'),
      metadata: z.record(z.string(), z.unknown(), { error: 'metadata must be an object.' }).optional(),
      addBlocks: ids('addBlocks'),
      addBlockedBy: ids('addBlockedBy'),
      removeBlocks: ids('removeBlocks'),
      removeBlockedBy: ids('removeBlockedBy'),
      expectedUpdatedAt: z.number({ error: 'expectedUpdatedAt must be a time.' }).optional(),
    }))
    .output(type<{ task: WorkTask }>()),
};
