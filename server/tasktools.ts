import { activeProject, chats, withProject } from './store.ts';
import { listBriefs } from './briefs.ts';
import { createTask, getTask, listTasks, runTaskBatch, updateTask } from './tasks.ts';
import type { TaskAccess } from './tasks.ts';
import type { JSONSchema, ToolContext, ToolDef } from './tools.ts';
import type { TaskCreateInput, TaskQuery, TaskUpdateInput } from '../shared/types.ts';

const scope: JSONSchema = { type: 'object', properties: { kind: { type: 'string', enum: ['brain', 'agent', 'team'] }, id: { type: 'string' } }, required: ['kind'] };
const string: JSONSchema = { type: 'string' };
const ids: JSONSchema = { type: 'array', items: string, maxItems: 40 };
const create = { subject: string, description: string, activeForm: string, metadata: { type: 'object' }, scope, owner: string };
const update = { taskId: string, subject: string, description: string, activeForm: string, owner: string, metadata: { type: 'object' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] }, addBlockedBy: ids, addBlocks: ids, removeBlockedBy: ids, removeBlocks: ids, expectedUpdatedAt: { type: 'number' } };
// One task's fields or a tasks array: runTaskBatch refuses both at once, and a single task checks its own fields.
// (Not as a top-level oneOf: Claude models refuse a tool whose schema has one, and so the whole request.)
const bulkSchema = (properties: Record<string, JSONSchema>, required: string[]): JSONSchema => ({ type: 'object', properties: { ...properties, tasks: { type: 'array', minItems: 1, items: { type: 'object', properties, required } } } });
async function inContext<T>(ctx: ToolContext, fn: (access: TaskAccess) => T): Promise<T> {
  const { runInfo } = await import('./engines/index.ts');
  const run = ctx.runId ? runInfo(ctx.runId) : null;
  if (ctx.runId && (!run || run.agentId !== ctx.agent.id || run.signal.aborted)) throw new Error('This run is no longer available to this agent.');
  return withProject(run?.project || activeProject(), () => {
    const chat = run ? chats.get(ctx.agent.id, run.chatId) : null;
    const scope = chat?.teamId ? { kind: 'team' as const, id: chat.teamId } : { kind: 'agent' as const, id: ctx.agent.id };
    const brief = listBriefs().findLast((b) => b.status === 'open' && (scope.kind === 'team' ? b.kind === 'team' && b.targetId === scope.id : b.kind === 'agent' && b.targetId === ctx.agent.id && b.chatId === run?.chatId));
    return fn({ agentId: ctx.agent.id, scope, ...(brief ? { briefId: brief.id } : {}) });
  });
}
export function taskTools(): ToolDef[] {
  return [
    {
      name: 'TaskCreate', group: 'core', risk: 'none',
      description: 'Create saved tasks: one (subject, description, optional activeForm, metadata, scope, owner), or several as {tasks:[...]} without the single-task fields. A batch runs in order with no size cap and returns an indexed result per item (taskId/status/updatedAt, or an error); successes stay saved, so retry only the failures. TaskGet reads full details. Default list: your current team or your own. owner is empty, brain, agent:<id> or team:<id>. Put acceptance criteria in the description. Records work; does not start a run.',
      parameters: bulkSchema(create, ['subject', 'description']),
      run: async (args, ctx) => ({ text: JSON.stringify(await inContext(ctx, (a) => runTaskBatch(args, (item) => createTask(item as unknown as TaskCreateInput, a)) ?? { task: createTask(args as unknown as TaskCreateInput, a) })) }),
    },
    {
      name: 'TaskGet', group: 'core', risk: 'none', description: 'Read one saved task, including its full description, owner, metadata and dependency links. Read before claiming work.',
      parameters: { type: 'object', properties: { taskId: string }, required: ['taskId'] },
      run: async (args, ctx) => ({ text: JSON.stringify(await inContext(ctx, (a) => ({ task: getTask(args.taskId, a) }))) }),
    },
    {
      name: 'TaskList', group: 'core', risk: 'none', description: 'List saved tasks you can access. Default: your current team or own list, plus project tasks assigned to you or this team. Use nextOffset for further pages. blockedBy lists unfinished prerequisites; a blocked task cannot be started. Claim ready tasks with TaskUpdate before doing them.',
      parameters: { type: 'object', properties: { scope, status: { type: 'string', enum: ['all', 'open', 'pending', 'in_progress', 'completed'] }, search: string, offset: { type: 'number' }, limit: { type: 'number' } } },
      run: async (args, ctx) => ({ text: JSON.stringify(await inContext(ctx, (a) => listTasks(args as TaskQuery, a))) }),
    },
    {
      name: 'TaskUpdate', group: 'core', risk: (args) => args.status === 'deleted' || (Array.isArray(args.tasks) && args.tasks.some((t: unknown) => !!t && typeof t === 'object' && 'status' in t && t.status === 'deleted')) ? 'high' : 'none',
      description: 'Update one task by taskId, or several as {tasks:[...]} without the single-task fields. A batch runs in order with no size cap and returns an indexed taskId/status/updatedAt or error per item; successes stay saved, so retry only the failures, and finish prerequisites before the tasks that depend on them. Claim with owner agent:<your id> and status in_progress; set completed only after checking the result. States: pending, in_progress, completed, deleted. addBlockedBy/addBlocks and removeBlockedBy/removeBlocks change links; metadata merges (null removes a key). Claims are exclusive. Any deletion asks for approval of the whole call.',
      parameters: bulkSchema(update, ['taskId']),
      run: async (args, ctx) => ({ text: JSON.stringify(await inContext(ctx, (a) => {
        const batch = runTaskBatch(args, (item) => updateTask(item as unknown as TaskUpdateInput, a));
        if (batch) return batch;
        const before = getTask(args.taskId, a);
        const task = updateTask(args as unknown as TaskUpdateInput, a);
        return { success: true, taskId: task.id, updatedFields: Object.keys(args).filter((k) => k !== 'taskId'), statusChange: before?.status !== task.status ? { from: before?.status, to: task.status } : null };
      })) }),
    },
  ];
}
