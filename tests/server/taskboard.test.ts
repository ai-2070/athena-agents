// The Tasks board: the project's own tasks (not the agents' step lists), from one project or all of them,
// changed in the project each belongs to whichever project is open; and a saved copy brought back.
import { describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { activeProject, setActiveProject, withProject } from '../../server/store.ts';
import { createProject } from '../../server/projects.ts';
import { savedTasks } from '../../server/tasks.ts';
import { cloneProject } from '../../server/backup.ts';
import { addBoardTask, boardPeople, boardTask, changeBoardTask, removeBoardTask, restoredBoard, taskBoard } from '../../server/taskboard.ts';

describe('the Tasks board', () => {
  it('numbers tasks in each project and shows every project\'s, or one project\'s, with names', async () => {
    const a = await createProject({ name: 'Board A' });
    const writer = withProject(a, () => newAgent({ name: 'Board writer', emoji: '✍️', toolGroups: [] }));
    const b = await createProject({ name: 'Board B' });
    const first = addBoardTask(a.id, { title: 'Write the post', description: 'A short post about the launch.', assignee: `agent:${writer.id}`, priority: 'high' });
    const second = addBoardTask(a.id, { title: 'Check the links' });
    const other = addBoardTask(b.id, { title: 'Check the site', status: 'in_review' });
    expect([first.number, second.number, other.number]).toEqual([1, 2, 1]);
    expect(first).toMatchObject({ projectId: a.id, projectName: 'Board A', status: 'todo', priority: 'high', assigneeName: 'Board writer', assigneeEmoji: '✍️', creatorName: 'You' });
    // not the agents' step lists
    expect(withProject(a, () => savedTasks())).toEqual([]);

    const all = taskBoard('all');
    expect(all.tasks.filter((t) => [a.id, b.id].includes(t.projectId)).map((t) => t.title)).toEqual(expect.arrayContaining(['Write the post', 'Check the links', 'Check the site']));
    expect(all.projects.find((p) => p.id === a.id)).toEqual({ id: a.id, name: 'Board A', open: 2 });
    // newest at the top of its column
    expect(taskBoard(a.id).tasks.map((t) => t.title)).toEqual(['Check the links', 'Write the post']);
    expect(boardTask(b.id, other.id).title).toBe('Check the site');
    expect(boardPeople(a.id).agents.map((x) => x.name)).toEqual(['Board writer']);
    expect(() => taskBoard('no-such-project')).toThrow('That project is unavailable.');
    expect(() => addBoardTask(b.id, { title: 'x', assignee: `agent:${writer.id}` })).toThrow('That agent or team is not in this project.');
    expect(() => addBoardTask(a.id, { title: '  ' })).toThrow('title must be non-empty text');
  });

  it('moves and edits a task in its own project, not the open one; Blocked keeps a reason, Done a time', async () => {
    const open = activeProject();
    // (making a project opens it: go back to the one that was open)
    const p = await createProject({ name: 'Board elsewhere' });
    setActiveProject(open.id);
    const t = addBoardTask(p.id, { title: 'Call the printer' });
    const u = addBoardTask(p.id, { title: 'Pay the printer' });
    expect(taskBoard(p.id).tasks.map((x) => x.title)).toEqual(['Pay the printer', 'Call the printer']);
    changeBoardTask(p.id, t.id, { rank: u.rank - 1 });
    expect(taskBoard(p.id).tasks.map((x) => x.title)).toEqual(['Call the printer', 'Pay the printer']);

    const blocked = changeBoardTask(p.id, t.id, { status: 'blocked', blockedReason: 'Waiting for the quote' });
    expect(blocked).toMatchObject({ status: 'blocked', blockedReason: 'Waiting for the quote' });
    const done = changeBoardTask(p.id, t.id, { status: 'done' });
    expect(done.blockedReason).toBeUndefined();
    expect(done.doneAt).toBeGreaterThan(0);
    expect(changeBoardTask(p.id, t.id, { status: 'in_progress' }).doneAt).toBeUndefined();
    expect(() => changeBoardTask(p.id, t.id, { status: 'started' })).toThrow('Choose a status');
    expect(() => changeBoardTask(p.id, t.id, { rank: Number.NaN })).toThrow('rank must be a number.');
    expect(() => changeBoardTask(p.id, t.id, { title: 'x', expectedUpdatedAt: 1 })).toThrow('This task changed meanwhile.');
    // the open project's board never saw it
    expect(taskBoard(open.id).tasks.some((x) => x.id === t.id)).toBe(false);
    removeBoardTask(p.id, t.id);
    expect(taskBoard(p.id).tasks.map((x) => x.title)).toEqual(['Pay the printer']);
  });

  it('goes with a project when it is cloned (a backup), and edits stay apart', async () => {
    const original = await createProject({ name: 'Board original' });
    const t = addBoardTask(original.id, { title: 'Ship it', status: 'blocked', blockedReason: 'Needs a sign-off' });
    const copy = (await cloneProject(original.id, 'Board copy')).project;
    expect(taskBoard(copy.id).tasks).toEqual([expect.objectContaining({ id: t.id, title: 'Ship it', status: 'blocked', blockedReason: 'Needs a sign-off', number: 1 })]);
    changeBoardTask(copy.id, t.id, { title: 'Ship the copy' });
    expect(boardTask(original.id, t.id).title).toBe('Ship it');
    expect(addBoardTask(copy.id, { title: 'Next' }).number).toBe(2);
  });

  it('brings back only well-formed tasks from a saved copy, numbering on from the highest', () => {
    const back = restoredBoard({ tasks: [
      { id: 'bt-1', number: 4, title: 'Kept', status: 'blocked', blockedReason: 'Why', priority: 'urgent', assignee: 'agent:a1', rank: 3, createdBy: 'brain' },
      { id: 'bt-2', title: 'Odd values', status: 'started', priority: 'very', assignee: 'someone' },
      { id: '../x', title: 'Bad id' },
      { id: 'bt-3', title: '' },
      { id: 'bt-1', title: 'Twice' },
    ] });
    expect(back.tasks.map((t) => t.title)).toEqual(['Kept', 'Odd values']);
    expect(back.tasks[0]).toMatchObject({ status: 'blocked', blockedReason: 'Why', priority: 'urgent', assignee: 'agent:a1', createdBy: 'brain' });
    expect(back.tasks[1]).toMatchObject({ status: 'todo', priority: 'normal', assignee: '', createdBy: 'you' });
    expect(back.next).toBe(5);
  });
});
