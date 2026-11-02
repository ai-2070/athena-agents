// The Tasks board: cards from one project or all of them, with the names they show, and moves, edits and new
// tasks that land in the project the task belongs to, whichever project is open.
import { describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { activeProject, setActiveProject, withProject } from '../../server/store.ts';
import { createProject } from '../../server/projects.ts';
import { createTask, savedTasks, updateTask } from '../../server/tasks.ts';
import { addBoardTask, changeBoardTask, taskBoard } from '../../server/taskboard.ts';

const admin = { admin: true, scope: { kind: 'brain' as const } };

describe('the Tasks board', () => {
  it('shows every project\'s tasks with their project, list and owner, or one project\'s', async () => {
    const a = await createProject({ name: 'Board A' });
    const b = await createProject({ name: 'Board B' });
    const ta = withProject(a, () => {
      const writer = newAgent({ name: 'Board writer', emoji: '✍️', toolGroups: [] });
      return createTask({ subject: 'Write the post', description: 'A short post about the launch.', owner: `agent:${writer.id}` }, admin);
    });
    const tb = withProject(b, () => createTask({ subject: 'Check the site', description: 'All pages load.' }, admin));
    withProject(b, () => updateTask({ taskId: createTask({ subject: 'Gone', description: 'x' }, admin).id, status: 'deleted' }, admin));

    const all = taskBoard('all');
    const card = all.tasks.find((t) => t.id === ta.id)!;
    expect(card).toMatchObject({ projectId: a.id, projectName: 'Board A', status: 'pending', listName: 'The Brain', ownerName: 'Board writer', ownerEmoji: '✍️', preview: 'A short post about the launch.' });
    expect(all.tasks.find((t) => t.id === tb.id)).toMatchObject({ projectId: b.id, ownerName: 'Unassigned' });
    // deleted tasks are not cards
    expect(all.tasks.some((t) => t.subject === 'Gone')).toBe(false);
    expect(all.projects.find((p) => p.id === b.id)).toEqual({ id: b.id, name: 'Board B', open: 1 });

    const one = taskBoard(a.id);
    expect(one.tasks.map((t) => t.id)).toEqual([ta.id]);
    expect(() => taskBoard('no-such-project')).toThrow('That project is unavailable.');
  });

  it('moves, ranks and adds tasks in their own project, not the open one', async () => {
    const open = activeProject();
    // (making a project opens it: go back to the one that was open)
    const other = await createProject({ name: 'Board elsewhere' });
    setActiveProject(open.id);
    expect(activeProject().id).toBe(open.id);
    const first = withProject(other, () => createTask({ subject: 'First', description: 'One' }, admin));
    const second = withProject(other, () => createTask({ subject: 'Second', description: 'Two' }, admin));
    // never moved: newest first
    expect(taskBoard(other.id).tasks.map((t) => t.subject)).toEqual(['Second', 'First']);

    changeBoardTask(other.id, first.id, { rank: taskBoard(other.id).tasks[0].rank - 1 });
    expect(taskBoard(other.id).tasks.map((t) => t.subject)).toEqual(['First', 'Second']);
    changeBoardTask(other.id, second.id, { status: 'in_progress' });
    expect(withProject(other, () => savedTasks().find((t) => t.id === second.id))).toMatchObject({ status: 'in_progress', owner: 'brain' });
    // nothing changed in the open project
    expect(savedTasks().some((t) => t.id === second.id)).toBe(false);
    expect(() => changeBoardTask(other.id, second.id, { rank: Number.NaN })).toThrow('rank must be a number.');

    // a card needs only a title; it lands in the column it was added to
    const added = addBoardTask(other.id, { subject: 'Call the printer', status: 'in_progress', rank: 5 });
    expect(withProject(other, () => savedTasks().find((t) => t.id === added.id))).toMatchObject({ subject: 'Call the printer', description: 'Call the printer', status: 'in_progress', rank: 5, scope: { kind: 'brain' } });
  });

  it('refuses to start a task that still waits for another', async () => {
    const p = await createProject({ name: 'Board blocked' });
    const [before, after] = withProject(p, () => {
      const x = createTask({ subject: 'Before', description: 'x' }, admin);
      const y = createTask({ subject: 'After', description: 'y' }, admin);
      updateTask({ taskId: y.id, addBlockedBy: [x.id] }, admin);
      return [x, y];
    });
    expect(taskBoard(p.id).tasks.find((t) => t.id === after.id)!.blockedBy).toEqual([before.id]);
    expect(() => changeBoardTask(p.id, after.id, { status: 'in_progress' })).toThrow('Finish the blocking tasks first.');
  });
});
