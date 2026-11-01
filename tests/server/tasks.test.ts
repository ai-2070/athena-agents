import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { activeProject, setActiveProject, withProject, workflows } from '../../server/store.ts';
import { createProject } from '../../server/projects.ts';
import { cloneProject } from '../../server/backup.ts';
import { createTask, getTask, listTasks, restoredTasks, savedTasks, updateTask } from '../../server/tasks.ts';
import { callTool, riskOf, toolsForAgent } from '../../server/tools.ts';
import { decide, listApprovals } from '../../server/approvals.ts';
import type { TaskBatchResult, TaskPage, Team, WorkTask } from '../../shared/types.ts';

const admin = { admin: true, scope: { kind: 'brain' as const } };
const setup = () => {
  const a = newAgent({ name: 'Task worker', toolGroups: [], autonomy: 'full' });
  const b = newAgent({ name: 'Task peer', toolGroups: [], autonomy: 'full' });
  const t = workflows.save({ name: 'Task team', members: [a.id, b.id], lead: a.id, steps: [] } as Partial<Team>);
  const access = { agentId: a.id, scope: { kind: 'team' as const, id: t.id } };
  const create = (subject: string) => createTask({ subject, description: `${subject}: verify the result.` }, access);
  return { a, b, t, access, create };
};

describe('saved tasks', () => {
  it('creates pending tasks, reads full details, merges metadata and removes keys with null', () => {
    const { create, access } = setup();
    const t = create('Prepare the report');
    expect(getTask(t.id, access)).toMatchObject({ status: 'pending', owner: '', blockedBy: [], blocks: [], description: 'Prepare the report: verify the result.' });
    updateTask({ taskId: t.id, metadata: { reference: 'note.md', attempt: 1 } }, access);
    const next = updateTask({ taskId: t.id, metadata: { attempt: null, checked: true }, activeForm: 'Preparing the report' }, access);
    expect(next.metadata).toEqual({ reference: 'note.md', checked: true });
    expect(next.activeForm).toBe('Preparing the report');
  });

  it('blocks dependent work, maintains both links and unblocks when prerequisites complete', () => {
    const { create, access } = setup();
    const a = create('Write'); const b = create('Review');
    updateTask({ taskId: b.id, addBlockedBy: [a.id] }, access);
    expect(getTask(a.id, access)?.blocks).toEqual([b.id]);
    expect(() => updateTask({ taskId: b.id, status: 'in_progress' }, access)).toThrow('blocking tasks');
    expect(() => updateTask({ taskId: b.id, status: 'completed' }, access)).toThrow('blocking tasks');
    updateTask({ taskId: a.id, status: 'completed' }, access);
    expect(listTasks({}, access).tasks.find((t) => t.id === b.id)?.blockedBy).toEqual([]);
    expect(updateTask({ taskId: b.id, status: 'in_progress' }, access).status).toBe('in_progress');
  });

  it('rejects cycles and missing dependencies atomically, then allows dependency removal and deletion', () => {
    const { create, access } = setup();
    const a = create('First'); const b = create('Second');
    updateTask({ taskId: a.id, addBlocks: [b.id] }, access);
    const before = savedTasks();
    expect(() => updateTask({ taskId: b.id, addBlocks: [a.id] }, access)).toThrow('cycle');
    expect(savedTasks()).toEqual(before);
    expect(() => updateTask({ taskId: a.id, addBlocks: ['missing'] }, access)).toThrow('available tasks');
    expect(savedTasks()).toEqual(before);
    updateTask({ taskId: a.id, removeBlocks: [b.id] }, access);
    expect(getTask(b.id, access)?.blockedBy).toEqual([]);
    updateTask({ taskId: b.id, addBlockedBy: [a.id] }, access);
    updateTask({ taskId: a.id, status: 'deleted' }, access);
    expect(getTask(a.id, access)).toBeNull();
    expect(getTask(b.id, access)?.blockedBy).toEqual([]);
  });

  it('reopening a prerequisite resets downstream completed work in dependency order', () => {
    const { create, access } = setup();
    // Creation order deliberately differs from dependency order.
    const c = create('Ship'); const b = create('Check'); const a = create('Build');
    updateTask({ taskId: b.id, addBlockedBy: [a.id] }, access);
    updateTask({ taskId: c.id, addBlockedBy: [b.id] }, access);
    for (const t of [a, b, c]) updateTask({ taskId: t.id, status: 'completed' }, access);
    updateTask({ taskId: a.id, status: 'pending' }, access);
    expect([a, b, c].map((t) => getTask(t.id, access)?.status)).toEqual(['pending', 'pending', 'pending']);
  });

  it('makes claims exclusive and detects stale user edits without invalidating unrelated tasks', () => {
    const { a, b, create, access } = setup();
    const task = create('Claim me'); const other = create('Independent task');
    const claimed = updateTask({ taskId: task.id, owner: `agent:${a.id}`, status: 'in_progress' }, access);
    expect(() => updateTask({ taskId: task.id, owner: `agent:${b.id}`, status: 'in_progress' }, { ...access, agentId: b.id })).toThrow('already claimed');
    expect(() => updateTask({ taskId: task.id, status: 'completed' }, { ...access, agentId: b.id })).toThrow('Only the owner');
    expect(() => updateTask({ taskId: task.id, subject: 'Old edit', expectedUpdatedAt: task.updatedAt }, admin)).toThrow('changed');
    updateTask({ taskId: other.id, description: 'Updated the independent task.' }, access);
    expect(getTask(task.id, access)?.updatedAt).toBe(claimed.updatedAt);
  });

  it('limits private lists, team membership and assigned Brain work to the intended agent', () => {
    const { a, b, t, access } = setup();
    const privateTask = createTask({ subject: 'Private task', description: 'Private details.', scope: { kind: 'agent', id: b.id } }, admin);
    expect(getTask(privateTask.id, access)).toBeNull();
    expect(() => createTask({ subject: 'Wrong place', description: 'No access.', scope: privateTask.scope }, access)).toThrow('cannot create');
    const projectTask = createTask({ subject: 'Project assignment', description: 'Shared only with its owner.', owner: `agent:${a.id}` }, admin);
    expect(getTask(projectTask.id, access)?.subject).toBe('Project assignment');
    expect(getTask(projectTask.id, { agentId: b.id, scope: { kind: 'agent', id: b.id } })).toBeNull();
    const teamTask = createTask({ subject: 'Team project assignment', description: 'Shared with the team.', owner: `team:${t.id}` }, admin);
    expect(getTask(teamTask.id, access)).not.toBeNull();
    workflows.save({ ...t, members: [b.id] });
    expect(getTask(teamTask.id, access)).toBeNull();
    expect(() => listTasks({ scope: { kind: 'team', id: t.id } }, access)).toThrow('unavailable');
  });

  it('rejects malformed input, unsafe metadata, oversize output and cross-list links', () => {
    const { create, access } = setup();
    const a = create('Valid task');
    expect(() => createTask({ subject: '', description: 'No title.' }, access)).toThrow('subject');
    expect(() => createTask({ subject: 'Large', description: '\u0001'.repeat(8000) }, access)).toThrow('too large');
    expect(() => updateTask({ taskId: a.id, metadata: JSON.parse('{"__proto__":{"bad":true}}') }, access)).toThrow('metadata');
    const b = createTask({ subject: 'Different list', description: 'Other list.' }, admin);
    expect(() => updateTask({ taskId: a.id, addBlockedBy: [b.id] }, admin)).toThrow('same list');
  });

  it('paginates bounded summaries and retains full descriptions for TaskGet', () => {
    const { create, access } = setup();
    for (let i = 0; i < 70; i++) create(`Page task ${i} ${'title '.repeat(25)}`);
    const first = listTasks({ limit: 100, search: 'Page task' }, access);
    expect(first.total).toBe(70);
    expect(JSON.stringify(first).length).toBeLessThan(20000);
    expect(first.nextOffset).not.toBeNull();
    const second = listTasks({ offset: first.nextOffset!, search: 'Page task' }, access);
    expect(second.tasks.some((t) => first.tasks.some((x) => x.id === t.id))).toBe(false);
    expect(getTask(first.tasks[0].id, access)?.description).toContain('verify the result');
  });
});

describe('task tools and project copies', () => {
  it('creates batches with indexed partial results, full saved details and per-item access checks', async () => {
    const { a, b } = setup();
    const result = await callTool(a, 'TaskCreate', { tasks: [
      { subject: 'First bulk task', description: 'Keep every requirement.', metadata: { ticket: 42 } },
      { subject: '', description: 'Invalid title.' },
      { subject: 'Private intrusion', description: 'Must be refused.', scope: { kind: 'agent', id: b.id } },
      null,
      { tasks: [{ subject: 'Nested', description: 'No nested batches.' }] },
      { subject: 'Last bulk task', description: 'Continue after failures.' },
    ] });
    expect(result.isError).toBe(false);
    const batch = JSON.parse(result.text) as TaskBatchResult;
    expect(batch.results.map((r) => [r.index, r.success])).toEqual([[0, true], [1, false], [2, false], [3, false], [4, false], [5, true]]);
    expect(batch.results[2]).toMatchObject({ code: 403 });
    const first = batch.results[0];
    if (!first.success) throw new Error('The first task should have been saved.');
    expect(getTask(first.taskId, { agentId: a.id, scope: { kind: 'agent', id: a.id } })).toMatchObject({ description: 'Keep every requirement.', metadata: { ticket: 42 }, updatedAt: first.updatedAt });
    expect(savedTasks().filter((t) => t.subject.endsWith('bulk task'))).toHaveLength(2);
  });

  it('updates batches in order, respects blockers and stale versions, and keeps successful siblings', async () => {
    const { a, create, access } = setup();
    const first = create('Bulk prerequisite'); const second = create('Bulk dependent');
    updateTask({ taskId: second.id, addBlockedBy: [first.id] }, access);
    const result = JSON.parse((await callTool(a, 'TaskUpdate', { tasks: [
      { taskId: second.id, status: 'completed' },
      { taskId: first.id, status: 'completed' },
      { taskId: second.id, status: 'completed', metadata: { checked: true } },
      { taskId: first.id, subject: 'Stale edit', expectedUpdatedAt: first.updatedAt },
      { taskId: 'missing', status: 'completed' },
    ] })).text) as TaskBatchResult;
    expect(result.results.map((r) => r.success)).toEqual([false, true, true, false, false]);
    expect(result.results[0]).toMatchObject({ index: 0, code: 409 });
    expect(result.results[3]).toMatchObject({ index: 3, code: 409 });
    expect(result.results[4]).toMatchObject({ index: 4, code: 404 });
    expect(getTask(first.id, access)).toMatchObject({ status: 'completed', subject: 'Bulk prerequisite' });
    expect(getTask(second.id, access)).toMatchObject({ status: 'completed', metadata: { checked: true } });
  });

  it('protects claimed work inside a batch and detects deletions anywhere in the call', async () => {
    const { a, b, create, access } = setup();
    const claimed = create('Peer owns this'); const free = create('My own work');
    updateTask({ taskId: claimed.id, owner: `agent:${b.id}`, status: 'in_progress' }, { ...access, agentId: b.id });
    const args = { tasks: [{ taskId: claimed.id, status: 'completed' }, { taskId: free.id, status: 'completed' }] };
    expect(riskOf('TaskUpdate', args)).toBe('none');
    const batch = JSON.parse((await callTool(a, 'TaskUpdate', args)).text) as TaskBatchResult;
    expect(batch.results.map((r) => r.success)).toEqual([false, true]);
    expect(getTask(claimed.id, access)?.status).toBe('in_progress');
    expect(riskOf('TaskUpdate', { tasks: [null, ...args.tasks, { taskId: free.id, status: 'deleted' }] })).toBe('high');
    expect(riskOf('TaskUpdate', { status: 'deleted', tasks: args.tasks })).toBe('high');
  });

  it('rejects malformed, empty and mixed batches before writing any task', async () => {
    const { a } = setup();
    const item = { subject: 'Must not be saved', description: 'Invalid wrapper.' };
    const before = savedTasks();
    for (const tasks of [null, {}, []]) {
      expect((await callTool(a, 'TaskCreate', { tasks })).isError).toBe(true);
      expect((await callTool(a, 'TaskUpdate', { tasks })).isError).toBe(true);
    }
    expect((await callTool(a, 'TaskCreate', { ...item, tasks: [item] })).isError).toBe(true);
    expect((await callTool(a, 'TaskUpdate', { taskId: 'missing', tasks: [{}] })).isError).toBe(true);
    expect(savedTasks()).toEqual(before);
  });

  it('waits for approval before any batch item runs when a later item deletes a task', async () => {
    const { a, create, access } = setup();
    const first = create('Wait for approval'); const second = create('Delete after approval');
    const guarded = { ...a, autonomy: 'auto' as const, alwaysAllow: ['TaskUpdate'] };
    const args = { tasks: [{ taskId: first.id, status: 'completed' }, { taskId: second.id, status: 'deleted' }] };
    const pending = callTool(guarded, 'TaskUpdate', args);
    const approval = listApprovals().find((p) => p.agentId === a.id)!;
    expect(approval.data.args).toEqual(args);
    expect(getTask(first.id, access)?.status).toBe('pending');
    expect(getTask(second.id, access)?.status).toBe('pending');
    decide(approval.id, { approved: false });
    expect((await pending).denied).toBe(true);
    expect(getTask(first.id, access)?.status).toBe('pending');
    expect(getTask(second.id, access)?.status).toBe('pending');
  });

  it('accepts large create and update batches without a task-count cap and retains every result', async () => {
    const { a } = setup();
    const result = await callTool(a, 'TaskCreate', { tasks: Array.from({ length: 300 }, (_, i) => ({ subject: `Large batch task ${i}`, description: i ? 'Verify the result.' : 'a'.repeat(8000) })) });
    const batch = JSON.parse(result.text) as TaskBatchResult;
    expect(batch.results).toHaveLength(300);
    expect(batch.results.every((r) => r.success)).toBe(true);
    expect(result.text.length).toBeGreaterThan(24000);
    expect(batch.results.at(-1)).toMatchObject({ index: 299, status: 'pending' });
    const tasks = batch.results.flatMap((r) => r.success ? [{ taskId: r.taskId, status: 'completed' }] : []);
    const updated = JSON.parse((await callTool(a, 'TaskUpdate', { tasks })).text) as TaskBatchResult;
    expect(updated.results).toHaveLength(300);
    expect(updated.results.every((r) => r.success && r.status === 'completed')).toBe(true);
  });

  it('exposes the four core tools, keeps ordinary bookkeeping approval-free and gates deletion', async () => {
    const { a, b } = setup();
    expect(toolsForAgent(a).filter((t) => /^Task(Create|Get|List|Update)$/.test(t.name))).toHaveLength(4);
    expect(riskOf('TaskUpdate', { status: 'completed' })).toBe('none');
    expect(riskOf('TaskUpdate', { status: 'deleted' })).toBe('high');
    const result = await callTool(a, 'TaskCreate', { subject: 'Tool task', description: 'A real core tool task.' });
    expect(result.isError).toBe(false);
    const task = (JSON.parse(result.text) as { task: WorkTask }).task;
    expect(JSON.parse((await callTool(a, 'TaskGet', { taskId: task.id })).text).task.id).toBe(task.id);
    expect(JSON.parse((await callTool(b, 'TaskGet', { taskId: task.id })).text).task).toBeNull();
    const page = JSON.parse((await callTool(a, 'TaskList')).text) as TaskPage;
    expect(page.tasks.some((t) => t.id === task.id)).toBe(true);
    expect((await callTool({ id: '_outsider', name: 'Outside' }, 'TaskCreate', { subject: 'No', description: 'No.' })).isError).toBe(true);
    expect((await callTool(a, 'TaskList', {}, { runId: 'expired' })).isError).toBe(true);
  });

  it('keeps saved tasks and dependency links in a clone, resets in-progress state and isolates edits', async () => {
    const original = await createProject({ name: 'Tasks original', mode: 'new', folder: path.join(os.homedir(), 'task-projects', 'original') });
    const a = createTask({ subject: 'Original work', description: 'Keep this in its project.' }, admin);
    const b = createTask({ subject: 'Follow-up', description: 'Wait for the original.' }, admin);
    updateTask({ taskId: b.id, addBlockedBy: [a.id] }, admin);
    updateTask({ taskId: a.id, status: 'in_progress' }, admin);
    const copy = (await cloneProject(original.id, 'Task copy')).project;
    withProject(copy, () => {
      expect(getTask(a.id, admin)?.status).toBe('pending');
      expect(getTask(b.id, admin)?.blockedBy).toEqual([a.id]);
      updateTask({ taskId: a.id, subject: 'Copy only' }, admin);
    });
    expect(withProject(original, () => getTask(a.id, admin)?.subject)).toBe('Original work');
    setActiveProject(original.id);
    expect(activeProject().id).toBe(original.id);
  });

  it('cleans damaged saved tasks without importing unsafe links or stale completion bindings', () => {
    const { create } = setup();
    const a = create('Restore A'); const b = create('Restore B');
    const restored = restoredTasks({ tasks: [{ ...a, status: 'in_progress', briefId: 'old-project-brief', blockedBy: [b.id] }, { ...b, blockedBy: [a.id] }, { ...a, id: '../bad' }] }).tasks;
    expect(restored).toHaveLength(2);
    expect(restored[0].briefId).toBeUndefined();
    expect(restored[0].status).toBe('pending');
    expect(restored.every((t) => !t.blockedBy.includes(t.id))).toBe(true);
    expect(restored[0].blockedBy.length + restored[1].blockedBy.length).toBe(1);
    const oldDeletes = Array.from({ length: 10000 }, (_, i) => ({ ...a, id: `deleted_${i}`, status: 'deleted' }));
    expect(restoredTasks({ tasks: [...oldDeletes, b] }).tasks.map((t) => t.id)).toEqual([b.id]);
  });
});
