// One project file makes claims and dependency edits a single synchronous transaction.
import { agents, workflows, activeProject, emit } from './store.ts';
import { dataPath, readJSON, writeJSON, uid } from './util.ts';
import type { TaskBatchResult, TaskCreateInput, TaskPage, TaskQuery, TaskScope, TaskSummary, TaskUpdateInput, WorkTask } from '../shared/types.ts';

export interface TaskAccess {
  agentId?: string;
  admin?: boolean;
  scope: TaskScope;
  briefId?: string;
}
const file = () => dataPath('projects', activeProject().id, 'tasks.json');
export const savedTasks = (): WorkTask[] => readJSON<{ tasks: WorkTask[] }>(file(), { tasks: [] }).tasks;
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Batches commit each item in order. Bad items never roll back successful siblings. */
export function runTaskBatch(input: Record<string, unknown>, apply: (item: Record<string, unknown>) => WorkTask): TaskBatchResult | null {
  if (!Object.hasOwn(input, 'tasks')) return null;
  if (Object.keys(input).some((k) => k !== 'tasks')) return fail('Use either single-task fields or a tasks array, not both.');
  if (!Array.isArray(input.tasks) || !input.tasks.length) return fail('tasks must be a non-empty array of task objects.');
  return { results: input.tasks.map((item: unknown, index) => {
    try {
      if (!object(item) || Object.hasOwn(item, 'tasks')) return fail('Each batch item must be one task object.');
      const task = apply(item);
      return { index, success: true, taskId: task.id, status: task.status, updatedAt: task.updatedAt };
    } catch (e) {
      const code = object(e) && typeof e.status === 'number' ? e.status : 400;
      return { index, success: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 1000), code };
    }
  }) };
}
const text = (v: unknown, name: string, max: number, required = false): string => {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) return fail(`${name} must be ${required ? 'non-empty text' : 'text'} of at most ${max} characters.`);
  return v.trim();
};
const key = (s: TaskScope) => `${s.kind}:${s.id || ''}`;
export function taskScope(v: unknown): TaskScope {
  if (!object(v) || typeof v.kind !== 'string' || !['brain', 'agent', 'team'].includes(v.kind)) return fail('Choose a task list: brain, agent or team.');
  if (v.kind === 'brain') return { kind: 'brain' };
  if (typeof v.id !== 'string' || !/^[\w.-]+$/.test(v.id)) return fail('The task list needs a valid id.');
  if (v.kind === 'agent' ? !agents.get(v.id) : !workflows.get(v.id)) return fail('That task list is unavailable.', 404);
  return { kind: v.kind as 'agent' | 'team', id: v.id };
}
const member = (agentId: string | undefined, teamId: string | undefined) => !!agentId && !!teamId && !!workflows.get(teamId)?.members?.includes(agentId);
function ownList(a: TaskAccess, s: TaskScope): boolean {
  return !!a.admin || (s.kind === 'agent' && s.id === a.agentId) || (s.kind === 'team' && member(a.agentId, s.id));
}
function visible(a: TaskAccess, t: WorkTask): boolean {
  if (ownList(a, t.scope)) return true;
  return !!a.agentId && t.scope.kind === 'brain' && (t.owner === `agent:${a.agentId}` || (t.owner.startsWith('team:') && member(a.agentId, t.owner.slice(5))));
}
function actor(a: TaskAccess): void {
  if (!a.admin && (!a.agentId || !agents.get(a.agentId))) fail('This task tool needs a saved agent.', 403);
}
function metadata(v: unknown, old: Record<string, unknown> = {}): Record<string, unknown> {
  if (!object(v)) return fail('metadata must be a JSON object.');
  const next = { ...old };
  for (const [k, value] of Object.entries(v)) {
    if (['__proto__', 'constructor', 'prototype'].includes(k)) return fail('Invalid metadata key.');
    if (value === null) delete next[k]; else next[k] = value;
  }
  try { if (JSON.stringify(next).length > 2000) fail('Task metadata is limited to 2000 characters.'); } catch { return fail('Task metadata must be small, valid JSON.'); }
  return next;
}
function owner(v: unknown, s: TaskScope): string {
  if (v === '') return '';
  const value = text(v, 'owner', 160, true);
  if (value === 'brain') return value;
  const match = /^(agent|team):([\w.-]+)$/.exec(value);
  if (!match) return fail('owner must be empty, brain, agent:<id> or team:<id>.');
  const [, kind, id] = match;
  if (kind === 'agent' ? !agents.get(id) : !workflows.get(id)) return fail('That owner is unavailable.');
  if (s.kind === 'agent' && (kind !== 'agent' || id !== s.id)) return fail('A private list belongs to its agent. Use a shared list to assign other people.');
  if (s.kind === 'team' && (kind === 'team' ? id !== s.id : !member(id, s.id))) return fail('Choose a member of this team.');
  return value;
}
function save(tasks: WorkTask[], ids: string[]): void {
  writeJSON(file(), { tasks });
  emit('tasks', { projectId: activeProject().id, ids });
}
export function createTask(input: TaskCreateInput, access: TaskAccess): WorkTask {
  actor(access);
  if (!object(input)) return fail('Provide the task details.');
  const scope = taskScope(input.scope || access.scope);
  if (!ownList(access, scope)) return fail('You cannot create tasks in that list.', 403);
  const all = savedTasks();
  if (all.filter((t) => t.status !== 'deleted').length >= 10000) return fail('This project has 10,000 tasks. Remove old tasks before adding more.');
  const now = Date.now();
  const task: WorkTask = {
    id: uid('task'), scope, subject: text(input.subject, 'subject', 240, true), description: text(input.description, 'description', 8000, true),
    activeForm: input.activeForm == null ? '' : text(input.activeForm, 'activeForm', 240), status: 'pending',
    owner: owner(input.owner ?? (scope.kind === 'agent' ? `agent:${scope.id}` : ''), scope), blockedBy: [], blocks: [],
    metadata: metadata(input.metadata || {}), ...(access.briefId ? { briefId: access.briefId } : {}), createdAt: now, updatedAt: now,
  };
  if (JSON.stringify(task).length > 18000) return fail('The task details are too large. Use shorter text.');
  save([...all, task], [task.id]);
  return task;
}
export function getTask(taskId: unknown, access: TaskAccess): WorkTask | null {
  actor(access);
  if (typeof taskId !== 'string') return fail('taskId is required.');
  const t = savedTasks().find((t) => t.id === taskId && t.status !== 'deleted');
  return t && visible(access, t) ? t : null;
}
export function listTasks(query: TaskQuery, access: TaskAccess): TaskPage {
  actor(access);
  if (!object(query)) return fail('Provide task filters as an object.');
  const scope = query.scope ? taskScope(query.scope) : null;
  if (scope && !ownList(access, scope)) return fail('That task list is unavailable.', 403);
  const statuses = ['all', 'open', 'pending', 'in_progress', 'completed', 'deleted'];
  if (query.status != null && (typeof query.status !== 'string' || !statuses.includes(query.status))) return fail('Invalid task status.');
  const search = query.search == null ? '' : text(query.search, 'search', 240).toLowerCase();
  const all = savedTasks();
  const unfinished = new Set(all.filter((t) => t.status !== 'completed' && t.status !== 'deleted').map((t) => t.id));
  const matches = all.filter((t) => visible(access, t) && (query.status === 'deleted' ? t.status === 'deleted' : t.status !== 'deleted'))
    .filter((t) => access.admin || scope || key(t.scope) === key(access.scope) || (t.scope.kind === 'brain' && (t.owner === `agent:${access.agentId}` || (access.scope.kind === 'team' && t.owner === `team:${access.scope.id}`))))
    .filter((t) => !scope || key(scope) === key(t.scope))
    .filter((t) => !query.view || query.view === 'all' || query.view === (t.scope.kind === 'brain' ? 'brain' : `${t.scope.kind}:${t.scope.id}`) || query.view === t.owner)
    .filter((t) => !query.status || ['all', 'deleted'].includes(String(query.status)) || (query.status === 'open' ? t.status !== 'completed' : t.status === query.status))
    .filter((t) => !search || `${t.subject}\n${t.description}`.toLowerCase().includes(search))
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const offset = Math.max(0, Math.floor(Number(query.offset) || 0));
  const limit = Math.min(100, Math.max(1, Math.floor(Number(query.limit) || 50)));
  const tasks: TaskSummary[] = matches.slice(offset, offset + limit).map(({ description: _d, metadata: _m, blocks: _b, ...t }) => ({ ...t, blockedBy: t.blockedBy.filter((id) => unfinished.has(id)) }));
  while (tasks.length > 1 && JSON.stringify(tasks).length > 17000) tasks.pop();
  return { tasks, total: matches.length, nextOffset: offset + tasks.length < matches.length ? offset + tasks.length : null };
}
export function updateTask(input: TaskUpdateInput, access: TaskAccess): WorkTask {
  actor(access);
  if (!object(input)) return fail('Provide a task update.');
  const all = savedTasks();
  const before = new Map(all.map((t) => [t.id, JSON.stringify(t)]));
  const byId = new Map(all.map((t) => [t.id, t]));
  const task = all.find((t) => t.id === input.taskId && t.status !== 'deleted');
  if (!task || !visible(access, task)) return fail('That task is unavailable.', 404);
  if (input.expectedUpdatedAt != null && input.expectedUpdatedAt !== task.updatedAt) return fail('This task changed. Reload it before saving.', 409);
  if (input.status != null && !['pending', 'in_progress', 'completed', 'deleted'].includes(input.status)) return fail('Invalid task status.');
  const previous = task.status;
  const originalOwner = task.owner;
  if (input.owner !== undefined) {
    const next = owner(input.owner, task.scope);
    if (!access.admin && originalOwner && originalOwner !== `agent:${access.agentId}` && next !== originalOwner && previous === 'in_progress') return fail('Someone else has already claimed this task.', 409);
    task.owner = next;
  }
  if (!access.admin && previous === 'in_progress' && originalOwner.startsWith('agent:') && originalOwner !== `agent:${access.agentId}` && input.status !== undefined && input.status !== previous) return fail('Only the owner can finish or release this claimed task.', 409);
  for (const field of ['subject', 'description', 'activeForm'] as const) if (input[field] !== undefined) task[field] = text(input[field], field, field === 'description' ? 8000 : 240, field !== 'activeForm');
  if (input.metadata !== undefined) task.metadata = metadata(input.metadata, task.metadata);
  if (input.rank !== undefined) {
    if (typeof input.rank !== 'number' || !Number.isFinite(input.rank)) return fail('rank must be a number.');
    task.rank = input.rank;
  }
  if (access.briefId && (input.status === 'in_progress' || input.status === 'completed') && !task.briefId) task.briefId = access.briefId;
  const edges = (raw: unknown): string[] => {
    if (!Array.isArray(raw) || raw.length > 40 || raw.some((id) => typeof id !== 'string')) return fail('Dependencies must be an array of at most 40 task ids.');
    return [...new Set(raw)] as string[];
  };
  for (const [field, direction, add] of [['addBlockedBy', 'before', true], ['addBlocks', 'after', true], ['removeBlockedBy', 'before', false], ['removeBlocks', 'after', false]] as const) {
    if (input[field] === undefined) continue;
    for (const id of edges(input[field])) {
      const other = byId.get(id);
      if (!other || other.status === 'deleted' || !visible(access, other) || key(other.scope) !== key(task.scope)) return fail('Dependencies must refer to available tasks in the same list.');
      if (id === task.id) return fail('A task cannot depend on itself.');
      const before = direction === 'before' ? other : task;
      const after = direction === 'before' ? task : other;
      before.blocks = add ? [...new Set([...before.blocks, after.id])] : before.blocks.filter((id) => id !== after.id);
      after.blockedBy = add ? [...new Set([...after.blockedBy, before.id])] : after.blockedBy.filter((id) => id !== before.id);
      if (before.blocks.length > 40 || after.blockedBy.length > 40) return fail('A task can have at most 40 dependencies in each direction.');
    }
  }
  const open = all.filter((t) => t.status !== 'deleted');
  const degree = new Map(open.map((t) => [t.id, t.blockedBy.length]));
  const ready = open.filter((t) => !t.blockedBy.length);
  for (let i = 0; i < ready.length; i++) for (const id of ready[i].blocks) {
    const n = (degree.get(id) || 0) - 1; degree.set(id, n);
    if (n === 0) ready.push(byId.get(id)!);
  }
  if (ready.length !== open.length) return fail('These dependencies would create a cycle.');
  task.status = input.status || task.status;
  const blocked = (t: WorkTask) => t.blockedBy.some((id) => { const p = byId.get(id); return p && !['completed', 'deleted'].includes(p.status); });
  if (['in_progress', 'completed'].includes(task.status) && blocked(task)) return fail('Finish the blocking tasks first.', 409);
  if (task.status === 'in_progress' && !task.owner) task.owner = access.agentId ? `agent:${access.agentId}` : 'brain';
  if (!access.admin && task.status === 'in_progress' && task.owner.startsWith('agent:') && task.owner !== `agent:${access.agentId}`) return fail('This task is assigned to another agent.', 409);
  if (task.status === 'deleted') for (const t of all) { t.blocks = t.blocks.filter((id) => id !== task.id); t.blockedBy = t.blockedBy.filter((id) => id !== task.id); }
  // Reopening a prerequisite must not leave downstream work marked ready or complete.
  for (const t of ready) if (blocked(t) && ['in_progress', 'completed'].includes(t.status)) t.status = 'pending';
  const changed = all.filter((t) => JSON.stringify(t) !== before.get(t.id));
  for (const t of changed) t.updatedAt = Math.max(Date.now(), t.updatedAt + 1);
  if (all.some((t) => JSON.stringify(t).length > 18000)) return fail('The task details are too large. Use shorter text or fewer dependency links.');
  save(all, changed.map((t) => t.id));
  return task;
}

export function tasksForBrief(briefId: string): WorkTask[] {
  return savedTasks().filter((t) => t.briefId === briefId && t.status !== 'deleted');
}

export function bindTasks(ids: string[], briefId: string): void {
  const all = savedTasks();
  const changed = all.filter((t) => ids.includes(t.id) && !['completed', 'deleted'].includes(t.status));
  for (const t of changed) t.briefId = briefId;
  if (changed.length) save(all, changed.map((t) => t.id));
}

/** Saved copies keep task IDs and links, but do not claim work is still running on another PC. */
export function restoredTasks(raw: unknown): { tasks: WorkTask[] } {
  const values: unknown[] = object(raw) && Array.isArray(raw.tasks) ? raw.tasks : Array.isArray(raw) ? raw : [];
  const tasks: WorkTask[] = [];
  const seen = new Set<string>();
  // Deleted records must not displace live work when an older project is restored.
  for (const v of values.filter((v) => !object(v) || v.status !== 'deleted').slice(0, 10000)) {
    try {
      if (!object(v) || typeof v.id !== 'string' || !/^[\w.-]+$/.test(v.id) || seen.has(v.id) || !object(v.scope) || typeof v.scope.kind !== 'string' || !['brain', 'agent', 'team'].includes(v.scope.kind)) continue;
      const scope: TaskScope = v.scope.kind === 'brain' ? { kind: 'brain' } : { kind: v.scope.kind as 'agent' | 'team', id: text(v.scope.id, 'list id', 160, true) };
      if (scope.id && !/^[\w.-]+$/.test(scope.id)) continue;
      const status = ['pending', 'in_progress', 'completed', 'deleted'].includes(String(v.status)) ? v.status as WorkTask['status'] : 'pending';
      const task: WorkTask = {
        id: v.id, scope, subject: text(v.subject, 'subject', 240, true), description: text(v.description, 'description', 8000, true), activeForm: v.activeForm ? text(v.activeForm, 'activeForm', 240) : '',
        status: status === 'in_progress' ? 'pending' : status, owner: typeof v.owner === 'string' && /^(|brain|(?:agent|team):[\w.-]+)$/.test(v.owner) ? v.owner : '',
        metadata: metadata(v.metadata || {}), blockedBy: Array.isArray(v.blockedBy) ? v.blockedBy.filter((id): id is string => typeof id === 'string').slice(0, 40) : [], blocks: [],
        ...(typeof v.rank === 'number' && Number.isFinite(v.rank) ? { rank: v.rank } : {}),
        createdAt: typeof v.createdAt === 'number' && Number.isFinite(v.createdAt) ? v.createdAt : Date.now(), updatedAt: Date.now(),
      };
      if (JSON.stringify(task).length > 18000) continue;
      tasks.push(task); seen.add(task.id);
    } catch { /* a damaged task does not prevent the rest of the project from opening */ }
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    const wanted = [...new Set(t.blockedBy)]; t.blockedBy = [];
    if (t.status === 'deleted') continue;
    for (const id of wanted) {
      const before = byId.get(id);
      if (!before || before.id === t.id || before.status === 'deleted' || key(before.scope) !== key(t.scope) || before.blocks.length >= 40) continue;
      const visited = new Set<string>(); const queue = [before];
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i]; if (visited.has(item.id)) continue; visited.add(item.id);
        for (const prev of item.blockedBy) { const p = byId.get(prev); if (p) queue.push(p); }
      }
      if (visited.has(t.id)) continue;
      t.blockedBy.push(before.id); before.blocks.push(t.id);
    }
  }
  return { tasks };
}
