// Tags on Tasks board tasks: names with an emoji, kept per project, put on and taken off tasks by name or id,
// renamed or deleted everywhere at once, found again by tag, and carried in a saved copy.
import { describe, expect, it } from 'vitest';
import { createProject } from '../../server/projects.ts';
import { cloneProject } from '../../server/backup.ts';
import { activeProject, setActiveProject, withProject } from '../../server/store.ts';
import { applyActions, boardFind, snapshot } from '../../server/overseer.ts';
import { isEmoji, splitTag, tagKey, tagNameProblem, tagsMatch } from '../../shared/boardtags.ts';
import { addBoardTag, addBoardTask, boardLines, boardTagLine, boardTags, boardTask, changeBoardTag, changeBoardTask, findBoardTasks, removeBoardTag, restoredBoard, taskBoard } from '../../server/taskboard.ts';

describe('tag names and emoji', () => {
  it('takes one emoji, as one character on screen', () => {
    for (const ok of ['🐛', '👩‍💻', '🇫🇷', '✍️', '1️⃣', '👍🏽']) expect(isEmoji(ok), ok).toBe(true);
    for (const bad of ['', 'a', 'ab', '🐛🐛', '🐛 x', '1']) expect(isEmoji(bad), bad).toBe(false);
  });

  it('reads "🐛 Bug" as an emoji and a name, and compares names without case or a leading emoji', () => {
    expect(splitTag('  🐛   Bug  ')).toEqual({ emoji: '🐛', name: 'Bug' });
    expect(splitTag('🔥')).toEqual({ name: '🔥' });
    expect(splitTag('Front end')).toEqual({ name: 'Front end' });
    expect(tagKey('🐛 Bug')).toBe(tagKey('bug'));
    expect(tagNameProblem('')).toBe('Give the tag a name.');
    expect(tagNameProblem('a, b')).toContain('comma');
    // counted as people see them: 32 of 👩‍💻 fit, 33 don't
    expect(tagNameProblem('👩‍💻'.repeat(32))).toBe('');
    expect(tagNameProblem('👩‍💻'.repeat(33))).toContain('32 characters');
  });

  it('lets a task through a filter that names any, or all, of its tags; untagged lets tagless tasks through', () => {
    expect(tagsMatch(['Bug', 'Design'], ['🐛 bug'])).toBe(true);
    expect(tagsMatch(['Bug'], ['bug', 'design'], 'any')).toBe(true);
    expect(tagsMatch(['Bug'], ['bug', 'design'], 'all')).toBe(false);
    expect(tagsMatch([], [], 'any', true)).toBe(true);
    expect(tagsMatch(['Bug'], [], 'any', true)).toBe(false);
    expect(tagsMatch(['Bug'], [])).toBe(true);
  });
});

describe('tags on the Tasks board', () => {
  it('makes tags once per name, with an emoji, and puts them on tasks by name or id', async () => {
    const p = await createProject({ name: 'Tags make' });
    const bug = addBoardTag(p.id, { name: '🐛 Bug' });
    expect(bug).toMatchObject({ name: 'Bug', emoji: '🐛', createdBy: 'you', tasks: 0, made: true });
    // the same name again (other case, no emoji) is the same tag, left as it was
    expect(addBoardTag(p.id, { name: 'bug', emoji: '🪲' })).toMatchObject({ id: bug.id, emoji: '🐛', made: false });
    expect(addBoardTag(p.id, { name: 'Design', emoji: '🎨' })).toMatchObject({ name: 'Design', emoji: '🎨' });
    expect(() => addBoardTag(p.id, { name: 'Odd', emoji: 'xy' })).toThrow('Choose one emoji for the tag.');
    expect(() => addBoardTag(p.id, { name: '  ' })).toThrow('Give the tag a name.');

    // a new name makes its tag (by whoever tags), a name or an id finds one
    const t = addBoardTask(p.id, { title: 'Fix the login', tags: ['bug', '📱 Mobile', bug.id] }, 'brain');
    expect(t.tagList.map((x) => [x.name, x.emoji])).toEqual([['Bug', '🐛'], ['Mobile', '📱']]);
    expect(boardTags(p.id).find((x) => x.name === 'Mobile')).toMatchObject({ createdBy: 'brain', tasks: 1 });
    // added, taken off, replaced; text with commas works too
    expect(changeBoardTask(p.id, t.id, { addTags: 'design, urgent fix', removeTags: ['📱 mobile'] }).tagList.map((x) => x.name)).toEqual(['Bug', 'Design', 'urgent fix']);
    expect(changeBoardTask(p.id, t.id, { tags: [] }).tags).toBeUndefined();
    expect(() => changeBoardTask(p.id, t.id, { tags: 'tag0123456789abcdef' })).toThrow('That tag is unavailable.');
    expect(() => changeBoardTask(p.id, t.id, { tags: [1] })).toThrow('tags must be a list of tag names.');
    expect(() => changeBoardTask(p.id, t.id, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).toThrow('A task can have up to 10 tags.');
    // nothing of a refused change was kept, not even its new tags
    expect(boardTags(p.id).some((x) => x.name === 't0')).toBe(false);
  });

  it('keeps the tags when a task is added (the board is written whole)', async () => {
    const p = await createProject({ name: 'Tags kept' });
    addBoardTag(p.id, { name: 'Keep me' });
    addBoardTask(p.id, { title: 'One' });
    addBoardTask(p.id, { title: 'Two' });
    expect(boardTags(p.id).map((x) => x.name)).toEqual(['Keep me']);
  });

  it('renames a tag or changes its emoji on every task at once, and deleting one takes it off every task', async () => {
    const open = activeProject();
    const p = await createProject({ name: 'Tags change' });
    setActiveProject(open.id);
    const a = addBoardTask(p.id, { title: 'A', tags: ['Bug', 'Design'] });
    const b = addBoardTask(p.id, { title: 'B', tags: ['Bug'] });
    const bug = boardTags(p.id).find((x) => x.name === 'Bug')!;
    expect(changeBoardTag(p.id, bug.id, { name: '🪲 Defect' })).toMatchObject({ name: 'Defect', emoji: '🪲', tasks: 2 });
    expect(boardTask(p.id, b.id).tagList[0]).toMatchObject({ name: 'Defect', emoji: '🪲' });
    expect(changeBoardTag(p.id, 'defect', { emoji: '' }).emoji).toBeUndefined();
    expect(() => changeBoardTag(p.id, bug.id, { name: 'design' })).toThrow('There\'s a tag called "Design" already.');
    expect(() => changeBoardTag(p.id, 'nope', { name: 'x' })).toThrow('That tag is unavailable.');

    const before = boardTask(p.id, a.id).updatedAt;
    expect(removeBoardTag(p.id, bug.id)).toMatchObject({ tasks: 2, tag: { id: bug.id } });
    expect(boardTask(p.id, a.id).tagList.map((x) => x.name)).toEqual(['Design']);
    expect(boardTask(p.id, a.id).updatedAt).toBeGreaterThan(before);
    expect(boardTask(p.id, b.id).tags).toBeUndefined();
    expect(boardTags(p.id).map((x) => x.name)).toEqual(['Design']);
    // the open project never saw any of it
    expect(boardTags(open.id).some((x) => x.name === 'Design' && x.tasks > 0)).toBe(false);
  });

  it('holds up to 50 tags in a project', async () => {
    const p = await createProject({ name: 'Tags many' });
    for (let i = 0; i < 50; i++) addBoardTag(p.id, { name: `Tag ${i}` });
    expect(() => addBoardTag(p.id, { name: 'One more' })).toThrow('A project can have up to 50 tags.');
    // an existing name still answers
    expect(addBoardTag(p.id, { name: 'tag 3' }).made).toBe(false);
  });

  it('shows tags on the board, in the Brain\'s lines, and finds tasks by any or all of their tags', async () => {
    const p = await createProject({ name: 'Tags find' });
    addBoardTask(p.id, { title: 'Login breaks', tags: ['🐛 Bug', 'Mobile'] });
    addBoardTask(p.id, { title: 'New icons', tags: ['🎨 Design'] });
    addBoardTask(p.id, { title: 'Old crash', tags: ['Bug'], status: 'done' });
    addBoardTask(p.id, { title: 'Plain' });
    const board = taskBoard(p.id);
    expect(board.tags[p.id].map((x) => [x.name, x.tasks])).toEqual([['Bug', 2], ['Design', 1], ['Mobile', 1]]);
    expect(board.tasks.find((t) => t.title === 'Login breaks')!.tagList.map((x) => x.name)).toEqual(['Bug', 'Mobile']);
    expect(boardLines(p.id)).toContain('#1 [To do] Login breaks | unassigned | tags: 🐛 Bug, Mobile');
    expect(boardTagLine(p.id)).toBe('TAGS: 🐛 Bug (2), 🎨 Design (1), Mobile (1)');

    const titles = (lines: string[]) => lines.map((l) => l.replace(/^#\d+ \[[^\]]+\] /, '').split(' | ')[0]);
    expect(titles(findBoardTasks(p.id, { tags: ['bug'] }).lines)).toEqual(['Login breaks']);
    expect(titles(findBoardTasks(p.id, { tags: ['bug'], status: 'all' }).lines)).toEqual(['Login breaks', 'Old crash']);
    // (in board order: newest at the top of its column)
    expect(titles(findBoardTasks(p.id, { tags: 'bug, design' }).lines)).toEqual(['New icons', 'Login breaks']);
    expect(titles(findBoardTasks(p.id, { tags: ['bug', 'mobile'], match: 'all' }).lines)).toEqual(['Login breaks']);
    expect(titles(findBoardTasks(p.id, { untagged: true }).lines)).toEqual(['Plain']);
    expect(findBoardTasks(p.id, { tags: ['bug', 'nothing'], limit: 1 })).toMatchObject({ total: 1, unknown: ['nothing'] });
    expect(() => findBoardTasks(p.id, {})).toThrow('Name the tags to look for');
    expect(() => findBoardTasks(p.id, { tags: ['bug'], match: 'some' })).toThrow('match must be any or all.');
    expect(() => findBoardTasks(p.id, { tags: ['bug'], limit: 0 })).toThrow('limit must be');
  });

  it('goes with a project when it is cloned, and a saved copy keeps only good tags', async () => {
    const p = await createProject({ name: 'Tags copy' });
    const t = addBoardTask(p.id, { title: 'Tagged', tags: ['🐛 Bug'] });
    const copy = (await cloneProject(p.id, 'Tags copy 2')).project;
    expect(boardTask(copy.id, t.id).tagList).toEqual([expect.objectContaining({ name: 'Bug', emoji: '🐛' })]);

    const restored = restoredBoard({
      tasks: [{ id: 'x1', title: 'One', tags: ['good', 'gone', 'good', 7] }],
      tags: [
        { id: 'good', name: 'Good', emoji: '✅', createdBy: 'brain', createdAt: 5 },
        { id: 'good', name: 'Twin id' },
        { id: 'same', name: '🙂 good' },
        { id: '../bad', name: 'Bad id' },
        { id: 'noemoji', name: 'Plain', emoji: 'not one' },
        { id: 'split', name: '🔥 Hot', createdBy: 'someone' },
        { id: 'long', name: 'x'.repeat(40) },
      ],
    });
    expect(restored.tags).toEqual([
      { id: 'good', name: 'Good', emoji: '✅', createdBy: 'brain', createdAt: 5 },
      { id: 'noemoji', name: 'Plain', createdBy: 'you', createdAt: expect.any(Number) },
      { id: 'split', name: 'Hot', emoji: '🔥', createdBy: 'you', createdAt: expect.any(Number) },
    ]);
    expect(restored.tasks[0].tags).toEqual(['good']);
  });
});

describe('the Brain and board tags', () => {
  it('tags tasks as it adds or updates them, re-tags them, and says so', async () => {
    const p = await createProject({ name: 'Tags brain' });
    const r = applyActions([
      { do: 'board_add', title: 'Fix the checkout', tags: ['🐛 Bug', 'Payments'] },
      { do: 'board_add', title: 'Draw the icons' },
    ], p);
    expect(r.done.map((d) => d.text)).toEqual(['Added #1 to the board: Fix the checkout (tags: 🐛 Bug, Payments)', 'Added #2 to the board: Draw the icons']);
    expect(boardTags(p.id).map((x) => [x.name, x.createdBy])).toEqual([['Bug', 'brain'], ['Payments', 'brain']]);
    // re-tag: one off, another on, in one update
    const moved = applyActions([{ do: 'board_update', task: '#1', removeTags: ['payments'], addTags: ['🎨 Design'] }, { do: 'board_update', task: '#2', status: 'in_review' }], p);
    expect(moved.done.map((d) => d.text)).toEqual(['Updated #1 on the board: Fix the checkout (tags: 🐛 Bug, 🎨 Design)', 'Updated #2 on the board: Draw the icons (now in review)']);
    expect(applyActions([{ do: 'board_update', task: '#1', tags: [] }], p).done[0].text).toBe('Updated #1 on the board: Fix the checkout (tags: none)');
    expect(applyActions([{ do: 'board_update', task: '#1', tags: 7 }], p).done[0]).toMatchObject({ kind: 'error', text: 'board_update: tags must be a list of tag names.' });
  });

  it('makes, re-emojis, renames and deletes tags with board_tag', async () => {
    const p = await createProject({ name: 'Tags brain list' });
    addBoardTask(p.id, { title: 'Tagged', tags: ['Ops'] });
    const r = applyActions([
      { do: 'board_tag', name: 'Bug', emoji: '🐛' },
      { do: 'board_tag', name: 'ops', emoji: '⚙️' },
      { do: 'board_tag', name: 'Ops', rename: 'Operations' },
      { do: 'board_tag', name: 'operations', remove: true },
      { do: 'board_tag', name: 'Nope', remove: true },
      { do: 'board_tag', name: 'Nope', rename: 'Yes' },
      { do: 'board_tag', name: 'Bug' },
      { do: 'board_tag' },
    ], p);
    expect(r.done.map((d) => d.text)).toEqual([
      'Made tag 🐛 Bug',
      'Changed tag Ops: now ⚙️ Ops',
      'Changed tag ⚙️ Ops: now ⚙️ Operations',
      'Deleted tag ⚙️ Operations (it came off 1 task)',
      'board_tag: no tag "Nope" on the board',
      'board_tag: no tag "Nope" on the board',
      'board_tag: tag 🐛 Bug is there already: say what changes (rename, emoji)',
      'board_tag: say which tag (name)',
    ]);
    expect(boardTags(p.id).map(tagNames)).toEqual(['🐛 Bug']);
  });

  it('finds tasks by tag with board_find, a look-up that changes nothing', async () => {
    const p = await createProject({ name: 'Tags brain find' });
    addBoardTask(p.id, { title: 'Crash on start', tags: ['🐛 Bug'] });
    addBoardTask(p.id, { title: 'Write the notes' });
    expect(boardFind(p.id, { do: 'board_find', tags: ['bug'] })).toBe('--- tags: bug | match: any | status: open ---\n#1 [To do] Crash on start | unassigned | tags: 🐛 Bug');
    expect(boardFind(p.id, { do: 'board_find', tags: ['bug', 'gone'], match: 'all' })).toContain('(no tasks match)\nNo tag called: gone');
    expect(boardFind(p.id, { do: 'board_find', untagged: true, limit: 5 })).toContain('Write the notes');
    expect(boardFind(p.id, { do: 'board_find', tags: ['bug'], match: 'some' })).toContain('Couldn\'t look: match must be any or all.');
    expect(boardFind(p.id, { do: 'board_find', tags: ['bug'] }, 'gateway-binding-1')).toContain('isn\'t available in this conversation');
    // applied as an action it is skipped: it was answered before the actions ran
    expect(applyActions([{ do: 'board_find', tags: ['bug'] }], p).done).toEqual([]);
    // the snapshot lists the tags
    expect(await withProject(p, () => snapshot())).toContain('TAGS: 🐛 Bug (1)');
  });

  it('may tag its own task in the task\'s conversation, but changes tags only in its own chat', async () => {
    const p = await createProject({ name: 'Tags brain private' });
    const mine = addBoardTask(p.id, { title: 'Mine', tags: ['Ops'] });
    const own = { conversationId: `board-${mine.id}` };
    expect(applyActions([{ do: 'board_update', task: '#1', addTags: ['🔥 Hot'] }], p, own).done[0]).toMatchObject({ kind: 'board' });
    expect(boardTask(p.id, mine.id).tagList.map(tagNames)).toEqual(['Ops', '🔥 Hot']);
    for (const conversationId of [own.conversationId, 'gateway-binding-1']) {
      expect(applyActions([{ do: 'board_tag', name: 'Ops', remove: true }], p, { conversationId }).done[0]).toMatchObject({ kind: 'error', text: expect.stringContaining('can\'t be changed in this conversation') });
    }
    expect(applyActions([{ do: 'board_update', task: '#1', addTags: ['Sneaky'] }], p, { conversationId: 'gateway-binding-1' }).done[0]).toMatchObject({ kind: 'error' });
    expect(boardTags(p.id).map((x) => x.name)).toEqual(['Hot', 'Ops']);
  });
});

const tagNames = (x: { name: string; emoji?: string }) => (x.emoji ? `${x.emoji} ${x.name}` : x.name);
