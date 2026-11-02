// The Tasks board: the project's own tasks (not the agents' step lists), from one project or all of them,
// changed in the project each belongs to whichever project is open; and a saved copy brought back.
import { describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { activeProject, setActiveProject, withProject } from '../../server/store.ts';
import { createProject } from '../../server/projects.ts';
import { savedTasks } from '../../server/tasks.ts';
import { cloneProject } from '../../server/backup.ts';
import { applyActions } from '../../server/overseer.ts';
import { addBoardComment, addBoardTask, boardLines, boardPeople, boardTask, changeBoardComment, changeBoardTask, findBoardTask, removeBoardTask, restoredBoard, taskBoard } from '../../server/taskboard.ts';

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

  it('lets the Brain add, move, assign and remove board tasks by #number or title, and see the board', async () => {
    const p = await createProject({ name: 'Board brain' });
    const r = applyActions([
      { do: 'hire', members: [{ new: { name: 'Board baker', specialty: 'cakes' } }] },
      { do: 'board_add', title: 'Bake the test cake', description: 'Chocolate, for Friday.', priority: 'high', assignee: 'agent:new' },
      { do: 'board_add', title: 'Order flour' },
    ], p);
    expect(r.done.filter((d) => d.kind === 'board').map((d) => d.text)).toEqual(['Added #1 to the board: Bake the test cake', 'Added #2 to the board: Order flour']);
    const cake = findBoardTask(p.id, '#1');
    expect(cake).toMatchObject({ priority: 'high', assigneeName: 'Board baker', creatorName: 'The Brain' });
    expect(r.done.find((d) => d.kind === 'board')!.boardTask).toEqual({ projectId: p.id, id: cake.id });
    expect(boardLines(p.id)).toEqual([
      '#2 [To do] Order flour | unassigned',
      expect.stringMatching(/^#1 \[To do\] \(high\) Bake the test cake \| Board baker \(agent:.+\) \| Chocolate, for Friday\.$/),
    ]);

    // blocked needs a reason; a title finds the task too
    expect(applyActions([{ do: 'board_update', task: '#2', status: 'blocked' }], p).done[0]).toMatchObject({ kind: 'error', text: 'board_update: say why it is blocked (blockedReason)' });
    const moved = applyActions([{ do: 'board_update', task: 'order flour', status: 'blocked', blockedReason: 'The mill is closed' }, { do: 'board_update', task: 1, status: 'in_review' }], p);
    expect(moved.done.map((d) => d.text)).toEqual(['Updated #2 on the board: Order flour (now blocked)', 'Updated #1 on the board: Bake the test cake (now in review)']);
    expect(boardLines(p.id)[0]).toBe('#2 [Blocked] Order flour | unassigned | blocked: The mill is closed');
    expect(applyActions([{ do: 'board_update', task: '#9', status: 'done' }], p).done[0]).toMatchObject({ kind: 'error', text: 'board_update: no task "#9" on the board' });
    applyActions([{ do: 'board_remove', task: '#2' }], p);
    expect(taskBoard(p.id).tasks.map((t) => t.number)).toEqual([1]);
  });

  it('keeps comments on a task (you, the Brain), counts them on the board and shows them on its page', async () => {
    const p = await createProject({ name: 'Board comments' });
    const t = addBoardTask(p.id, { title: 'Pick the paper' });
    const after = addBoardComment(p.id, t.id, 'Go for **recycled**, 120 g.');
    expect(after.comments).toEqual([expect.objectContaining({ by: 'you', byName: 'You', text: 'Go for **recycled**, 120 g.' })]);
    expect(taskBoard(p.id).tasks[0]).toMatchObject({ commentCount: 1 });
    expect(taskBoard(p.id).tasks[0].comments).toBeUndefined();
    const cid = after.comments![0].id;
    expect(changeBoardComment(p.id, t.id, cid, 'Go for recycled, 150 g.').comments![0]).toMatchObject({ text: 'Go for recycled, 150 g.', editedAt: expect.any(Number) });
    expect(() => addBoardComment(p.id, t.id, '   ')).toThrow('comment must be non-empty text');

    // the Brain reads the last comment and adds its own
    expect(boardLines(p.id)[0]).toContain('1 comment, last from You: "Go for recycled, 150 g."');
    const r = applyActions([{ do: 'board_comment', task: '#1', text: 'Checked: the printer has it in stock.' }], p);
    expect(r.done[0]).toMatchObject({ kind: 'board', text: 'Commented on #1: Pick the paper' });
    expect(boardTask(p.id, t.id).comments!.map((c) => [c.byName, c.text])).toEqual([['You', 'Go for recycled, 150 g.'], ['The Brain', 'Checked: the printer has it in stock.']]);

    // they go with a copy of the project
    const copy = restoredBoard({ tasks: [{ id: t.id, title: 'x', comments: [{ id: 'c1', by: 'brain', text: 'kept', at: 1 }, { id: 'c2', text: '' }, { id: '../c', text: 'bad id' }] }] });
    expect(copy.tasks[0].comments).toEqual([{ id: 'c1', by: 'brain', text: 'kept', at: 1 }]);
    expect(changeBoardComment(p.id, t.id, cid, null).comments!.length).toBe(1);
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
