// The step lists agents, teams and the Brain keep (shared/api/tasks.ts). You see and change every list (admin);
// server/tasks.ts checks the rest, as it does for the agents' tools.
import { implement } from '@orpc/server';
import { tasks as contract } from '../../shared/api/tasks.ts';
import { chats } from '../store.ts';
import * as tasks from '../tasks.ts';
import { listBriefs } from '../briefs.ts';
import { refuse } from './refuse.ts';
import type { TaskAccess } from '../tasks.ts';

const os = implement(contract);
const yours: TaskAccess = { admin: true, scope: { kind: 'brain' } };

export const tasksRouter = os.router({
  list: os.list.handler(({ input }) => tasks.listTasks({ ...input, view: input.view || 'all', status: input.status || 'all', search: input.search || '' }, yours)),
  get: os.get.handler(({ input }) => ({ task: tasks.getTask(input.id, yours) || refuse('That task is unavailable.', 404) })),
  create: os.create.handler(({ input: { chatId: chat, ...body } }) => {
    const scope = tasks.taskScope(body.scope || { kind: 'brain' });
    const chatId = chat && scope.kind === 'agent' && chats.get(scope.id!, chat) ? chat : null;
    // a task made while a /goal is open there counts toward it
    const brief = listBriefs().findLast((b) => b.status === 'open' && (scope.kind === 'team' ? b.kind === 'team' && b.targetId === scope.id : scope.kind === 'agent' && b.targetId === scope.id && b.chatId === chatId));
    return { task: tasks.createTask({ ...body, subject: body.subject ?? '', description: body.description ?? '' }, { ...yours, scope, ...(brief ? { briefId: brief.id } : {}) }) };
  }),
  change: os.change.handler(({ input: { id, ...body } }) => ({ task: tasks.updateTask({ ...body, taskId: id }, yours) })),
});
