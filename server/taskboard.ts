// The Tasks board: the project's own tasks (data/projects/<id>/board.json), apart from the step lists agents keep
// in their chats (tasks.ts). The board shows one project's or every project's; a change is made in the project
// the task belongs to (withProject), whichever project is open.
import { agents, workflows, listProjects, withProject, activeProject, emit } from './store.ts';
import { dataPath, readJSON, writeJSON, uid } from './util.ts';
import { TAGS_PER_PROJECT, TAGS_PER_TASK, cleanTagText, isEmoji, splitTag, tagKey, tagLabel, tagNameProblem, tagsMatch } from '../shared/boardtags.ts';
import type { TagMatch } from '../shared/boardtags.ts';
import type { BoardComment, BoardPeople, BoardPriority, BoardStatus, BoardTag, BoardTagUse, BoardTask, Project, ProjectTask, TaskBoardData, TaskComment, TaskFile } from '../shared/types.ts';

export const BOARD_STATUSES: readonly BoardStatus[] = ['todo', 'in_progress', 'in_review', 'blocked', 'done'];
export const BOARD_PRIORITIES: readonly BoardPriority[] = ['urgent', 'high', 'normal', 'low'];

interface BoardFile {
  tasks: ProjectTask[];
  /** the number the next task gets */
  next: number;
  /** the project's tags */
  tags: BoardTag[];
}
const file = () => dataPath('projects', activeProject().id, 'board.json');
const read = (): BoardFile => {
  const f = readJSON<Partial<BoardFile>>(file(), {});
  const tasks = Array.isArray(f.tasks) ? f.tasks : [];
  return { tasks, next: typeof f.next === 'number' ? f.next : tasks.reduce((n, t) => Math.max(n, t.number || 0), 0) + 1, tags: Array.isArray(f.tags) ? f.tags : [] };
};
function write(f: BoardFile, ids: string[]): void {
  writeJSON(file(), f);
  // (the project's folder copy is saved again, and open boards load again)
  emit('board', { projectId: activeProject().id, ids });
}

const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, name: string, required = false): string => {
  if (typeof v !== 'string' || (required && !v.trim())) return fail(`${name} must be ${required ? 'non-empty text' : 'text'}.`);
  return v.trim();
};
function projectOf(id: unknown): Project {
  const p = typeof id === 'string' ? listProjects().find((x) => x.id === id) : undefined;
  return p || fail('That project is unavailable.', 404);
}
const status = (v: unknown): BoardStatus => (BOARD_STATUSES as readonly unknown[]).includes(v) ? v as BoardStatus : fail('Choose a status: To do, In progress, In review, Blocked or Done.');
const priority = (v: unknown): BoardPriority => (BOARD_PRIORITIES as readonly unknown[]).includes(v) ? v as BoardPriority : fail('Choose a priority: urgent, high, normal or low.');
/** '' , you, brain, or an agent or team of this project (inside withProject). */
function assignee(v: unknown): string {
  if (v === '' || v === 'you' || v === 'brain') return v;
  const m = typeof v === 'string' ? /^(agent|team):([\w.-]+)$/.exec(v) : null;
  if (!m) return fail('assignee must be empty, you, brain, agent:<id> or team:<id>.');
  if (m[1] === 'agent' ? !agents.get(m[2]) : !workflows.get(m[2])) return fail('That agent or team is not in this project.');
  return v as string;
}
const rank = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail('rank must be a number.'));

// a name for '', you, brain, agent:<id> or team:<id> (inside withProject)
function who(ref: string, none: string): { name: string; emoji?: string; color?: string } {
  if (!ref) return { name: none };
  if (ref === 'you') return { name: 'You' };
  if (ref === 'brain') return { name: 'The Brain' };
  const id = ref.slice(ref.indexOf(':') + 1);
  if (ref.startsWith('agent:')) {
    const a = agents.get(id);
    return a ? { name: a.name, ...(a.emoji ? { emoji: a.emoji } : {}), ...(a.color ? { color: a.color } : {}) } : { name: 'A former agent' };
  }
  return { name: workflows.get(id)?.name || 'A former team' };
}
/** A task's tags, in its order (ids that point at nothing are skipped). */
function tagsOf(t: ProjectTask, tags: readonly BoardTag[]): BoardTag[] {
  return (t.tags || []).flatMap((id) => tags.filter((x) => x.id === id));
}
/** A task as the board shows it. withComments: its comments too, with their writers' names (the task's page). */
function card(p: Project, t: ProjectTask, tags: readonly BoardTag[], withComments = false): BoardTask {
  const a = who(t.assignee, 'Unassigned');
  const { comments = [], ...rest } = t;
  return {
    ...rest,
    commentCount: comments.length,
    fileCount: (t.files?.length || 0) + comments.reduce((n, c) => n + (c.files?.length || 0), 0),
    ...(withComments ? { comments: comments.map(named) } : {}),
    projectId: p.id,
    projectName: p.name,
    assigneeName: a.name,
    ...(a.emoji ? { assigneeEmoji: a.emoji } : {}),
    ...(a.color ? { assigneeColor: a.color } : {}),
    creatorName: who(t.createdBy, 'You').name,
    ...(t.work ? { workerName: who(`${t.work.target.kind}:${t.work.target.id}`, 'Unassigned').name } : {}),
    tagList: tagsOf(t, tags),
  };
}
function named(c: TaskComment): BoardComment {
  const w = who(c.by, 'You');
  return { ...c, byName: w.name, ...(w.emoji ? { byEmoji: w.emoji } : {}) };
}
const order = (a: ProjectTask, b: ProjectTask) => a.rank - b.rank || b.createdAt - a.createdAt || a.id.localeCompare(b.id);

/** Which cards to show by their tags: tag names (commas between), any or all of them, and tasks with no tag. */
export interface BoardTagFilter {
  tags?: string;
  match?: string;
  untagged?: string;
}
/** The cards of one project, or of all of them ('all'), in board order; and every project with its open count.
 *  With a tag filter, only the cards it lets through (by name, so it works across projects). */
export function taskBoard(project: string, filter: BoardTagFilter = {}): TaskBoardData {
  const wanted = filter.tags ? tagRefs(filter.tags, 'tags') : [];
  const match: TagMatch = !filter.match || filter.match === 'any' ? 'any' : filter.match === 'all' ? 'all' : fail('match must be any or all.');
  const untagged = filter.untagged === '1' || filter.untagged === 'true';
  const all = listProjects();
  const chosen = project === 'all' ? all : [all.find((p) => p.id === project) || fail('That project is unavailable.', 404)];
  // each project's board is read once: for its open count, and for its cards when it is shown
  const boards = new Map(all.map((p) => [p.id, withProject(p, () => read())]));
  const tasks = chosen.flatMap((p) => withProject(p, () => { const f = boards.get(p.id)!; return f.tasks.map((t) => card(p, t, f.tags)); }));
  tasks.sort(order);
  if (wanted.length || untagged) tasks.splice(0, tasks.length, ...tasks.filter((t) => tagsMatch(t.tagList.map((x) => x.name), wanted, match, untagged)));
  const projects = all.map((p) => ({ id: p.id, name: p.name, open: boards.get(p.id)!.tasks.filter((t) => t.status !== 'done').length }));
  return { projects, tasks, tags: Object.fromEntries(chosen.map((p) => [p.id, uses(boards.get(p.id)!)])) };
}

/** One project's cards (not the others': the Overview page asks project by project). */
export function projectCards(projectId: string): BoardTask[] {
  const p = projectOf(projectId);
  return withProject(p, () => { const f = read(); return f.tasks.map((t) => card(p, t, f.tags)); });
}

/** One task as its page shows it. */
export function boardTask(projectId: string, id: string): BoardTask {
  const p = projectOf(projectId);
  return withProject(p, () => {
    const f = read();
    const t = f.tasks.find((x) => x.id === id);
    return t ? card(p, t, f.tags, true) : fail('That task is unavailable.', 404);
  });
}

/** The agents and teams a project's tasks can go to. */
export function boardPeople(projectId: string): BoardPeople {
  return withProject(projectOf(projectId), () => ({
    agents: agents.list().map((a) => ({ id: a.id, name: a.name, ...(a.emoji ? { emoji: a.emoji } : {}), ...(a.color ? { color: a.color } : {}) })),
    teams: workflows.list().map((t) => ({ id: t.id, name: t.name })),
  }));
}

export interface BoardInput {
  title?: unknown;
  description?: unknown;
  status?: unknown;
  priority?: unknown;
  assignee?: unknown;
  rank?: unknown;
  blockedReason?: unknown;
  /** its whole list of tags (names or ids); addTags and removeTags change some */
  tags?: unknown;
  addTags?: unknown;
  removeTags?: unknown;
}

/** A new task in a project. Without a rank it goes to the top of its column. */
export function addBoardTask(projectId: string, input: BoardInput, by = 'you', files: TaskFile[] = []): BoardTask {
  const p = projectOf(projectId);
  if (!object(input)) return fail('Give the task a title.');
  return withProject(p, () => {
    const f = read();
    const s = input.status === undefined ? 'todo' : status(input.status);
    const top = f.tasks.filter((t) => t.status === s).sort(order)[0];
    const now = Date.now();
    const t: ProjectTask = {
      id: uid('bt'),
      number: f.next,
      title: text(input.title, 'title', true),
      description: input.description === undefined ? '' : text(input.description, 'description'),
      status: s,
      priority: input.priority === undefined ? 'normal' : priority(input.priority),
      assignee: input.assignee === undefined ? '' : assignee(input.assignee),
      rank: input.rank === undefined ? (top ? top.rank - 1024 : 0) : rank(input.rank),
      ...(s === 'blocked' && typeof input.blockedReason === 'string' && input.blockedReason.trim() ? { blockedReason: text(input.blockedReason, 'blockedReason') } : {}),
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      ...(s === 'done' ? { doneAt: now } : {}),
      ...(files.length ? { files } : {}),
    };
    putTags(f, t, input, by);
    write({ ...f, tasks: [...f.tasks, t], next: f.next + 1 }, [t.id]);
    return card(p, t, f.tags);
  });
}

/** Moves (status, rank) or edits a task in its own project. Leaving Blocked drops its reason. by: who makes any new tag. */
export function changeBoardTask(projectId: string, id: string, input: BoardInput & { expectedUpdatedAt?: unknown }, files?: TaskFile[], by = 'you'): BoardTask {
  const p = projectOf(projectId);
  if (!object(input)) return fail('Say what changes.');
  return withProject(p, () => {
    const f = read();
    const t = f.tasks.find((x) => x.id === id) || fail('That task is unavailable.', 404);
    if (typeof input.expectedUpdatedAt === 'number' && input.expectedUpdatedAt !== t.updatedAt) return fail('This task changed meanwhile. Reload it before saving.', 409);
    if (input.title !== undefined) t.title = text(input.title, 'title', true);
    if (input.description !== undefined) t.description = text(input.description, 'description');
    if (input.priority !== undefined) t.priority = priority(input.priority);
    if (input.assignee !== undefined) t.assignee = assignee(input.assignee);
    if (input.rank !== undefined) t.rank = rank(input.rank);
    putTags(f, t, input, by);
    if (files) {
      if (files.length) t.files = files;
      else delete t.files;
    }
    if (input.status !== undefined) {
      const s = status(input.status);
      if (s === 'done' && t.status !== 'done') t.doneAt = Date.now();
      if (s !== 'done') delete t.doneAt;
      t.status = s;
    }
    if (t.status !== 'blocked') delete t.blockedReason;
    else if (input.blockedReason !== undefined) {
      const why = text(input.blockedReason, 'blockedReason');
      if (why) t.blockedReason = why;
      else delete t.blockedReason;
    }
    t.updatedAt = Math.max(Date.now(), t.updatedAt + 1);
    write(f, [t.id]);
    return card(p, t, f.tags, true);
  });
}

/**
 * Spaces a column's cards out again: new ranks for cards of one project or several, one save per project. Only the
 * rank changes (not the version: nothing about the task did), and a card that left the column meanwhile keeps its own.
 */
export function rerankBoardTasks(items: unknown): void {
  if (!Array.isArray(items)) return fail('ranks must be a list.');
  const byProject = new Map<string, Map<string, { status: BoardStatus; rank: number }>>();
  for (const v of items) {
    if (!object(v) || typeof v.projectId !== 'string' || typeof v.id !== 'string') return fail('Each rank needs a projectId and an id.');
    const ranks = byProject.get(v.projectId) || new Map<string, { status: BoardStatus; rank: number }>();
    ranks.set(v.id, { status: status(v.status), rank: rank(v.rank) });
    byProject.set(v.projectId, ranks);
  }
  // (every project is checked before any is written)
  const projects = [...byProject.keys()].map(projectOf);
  for (const p of projects) {
    withProject(p, () => {
      const ranks = byProject.get(p.id)!;
      const f = read();
      const ids: string[] = [];
      for (const t of f.tasks) {
        const r = ranks.get(t.id);
        if (r && r.status === t.status && r.rank !== t.rank) (t.rank = r.rank), ids.push(t.id);
      }
      if (ids.length) write(f, ids);
    });
  }
}

/** Changes one task in its own project and saves it; fn returns false to leave it as it was. */
export function editBoardTask(projectId: string, id: string, fn: (t: ProjectTask) => boolean | void): BoardTask {
  const p = projectOf(projectId);
  return withProject(p, () => {
    const f = read();
    const t = f.tasks.find((x) => x.id === id) || fail('That task is unavailable.', 404);
    if (fn(t) !== false) {
      t.updatedAt = Math.max(Date.now(), t.updatedAt + 1);
      write(f, [t.id]);
    }
    return card(p, t, f.tags, true);
  });
}

/** The task as it is saved (inside its project), or null. */
export function savedBoardTask(projectId: string, id: string): ProjectTask | null {
  return withProject(projectOf(projectId), () => read().tasks.find((x) => x.id === id) || null);
}

/** Every project's tasks that have work going (starting, working or waiting). */
export function tasksWithWork(): { projectId: string; task: ProjectTask }[] {
  return listProjects().flatMap((p) => withProject(p, () => read().tasks.filter((t) => t.work && ['starting', 'working', 'waiting'].includes(t.work.state)).map((task) => ({ projectId: p.id, task }))));
}

/** Adds a comment (Markdown) to a task: from you, the Brain ('brain') or an agent ('agent:<id>'), with files
 *  already copied into the task's project. */
export function addBoardComment(projectId: string, taskId: string, text: unknown, by = 'you', files: TaskFile[] = []): BoardTask {
  const p = projectOf(projectId);
  return withProject(p, () => {
    const f = read();
    const t = f.tasks.find((x) => x.id === taskId) || fail('That task is unavailable.', 404);
    const comments = t.comments || [];
    const now = Date.now();
    t.comments = [...comments, { id: uid('c'), by, text: files.length && (typeof text !== 'string' || !text.trim()) ? '' : text_(text), at: now, ...(files.length ? { files } : {}) }];
    t.updatedAt = Math.max(now, t.updatedAt + 1);
    write(f, [t.id]);
    return card(p, t, f.tags, true);
  });
}

/** Changes or removes a comment (text null removes it). */
export function changeBoardComment(projectId: string, taskId: string, commentId: string, text: unknown): BoardTask {
  const p = projectOf(projectId);
  return withProject(p, () => {
    const f = read();
    const t = f.tasks.find((x) => x.id === taskId) || fail('That task is unavailable.', 404);
    const c = (t.comments || []).find((x) => x.id === commentId) || fail('That comment is unavailable.', 404);
    if (text === null) t.comments = (t.comments || []).filter((x) => x.id !== c.id);
    else Object.assign(c, { text: text_(text), editedAt: Date.now() });
    t.updatedAt = Math.max(Date.now(), t.updatedAt + 1);
    write(f, [t.id]);
    return card(p, t, f.tags, true);
  });
}
const text_ = (v: unknown) => text(v, 'comment', true);

/** A task by its #number, its id or a title only one task has (the Brain names tasks these ways). */
export function findBoardTask(projectId: string, ref: unknown): BoardTask {
  const p = projectOf(projectId);
  return withProject(p, () => {
    const f = read();
    const all = f.tasks;
    const r = typeof ref === 'number' ? `#${ref}` : typeof ref === 'string' ? ref.trim() : '';
    const n = /^#?(\d+)$/.exec(r);
    const hit = (n ? all.find((t) => t.number === Number(n[1])) : undefined) || all.find((t) => t.id === r);
    if (hit) return card(p, hit, f.tags);
    const named = all.filter((t) => t.title.toLowerCase() === r.toLowerCase());
    if (named.length === 1) return card(p, named[0], f.tags);
    return fail(named.length ? `${named.length} tasks are called "${r}": use its #number` : `no task "${r}" on the board`, 404);
  });
}

const STATUS_LABEL: Record<BoardStatus, string> = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', done: 'Done' };
/** One task as the Brain and agents read it (inside withProject). */
function line(t: ProjectTask, tags: readonly BoardTag[]): string {
  const comments = t.comments || [];
  const c = comments.at(-1);
  const working = t.work && ['starting', 'working', 'waiting'].includes(t.work.state) ? ` | working: ${who(`${t.work.target.kind}:${t.work.target.id}`, 'someone').name}` : '';
  const files = (t.files?.length || 0) + comments.reduce((n, x) => n + (x.files?.length || 0), 0);
  const tagged = tagsOf(t, tags);
  return `#${t.number} [${STATUS_LABEL[t.status]}] ${t.priority === 'normal' ? '' : `(${t.priority}) `}${t.title} | ${t.assignee ? `${who(t.assignee, 'Unassigned').name} (${t.assignee})` : 'unassigned'}${tagged.length ? ` | tags: ${tagged.map(tagLabel).join(', ')}` : ''}${working}${files ? ` | files: ${files}` : ''}${t.blockedReason ? ` | blocked: ${t.blockedReason}` : ''}${t.description ? ` | ${t.description.replace(/\s+/g, ' ').slice(0, 140)}` : ''}${c ? ` | ${comments.length} comment${comments.length === 1 ? '' : 's'}, last from ${who(c.by, 'you').name}: "${c.text.replace(/\s+/g, ' ').slice(0, 120)}"` : ''}`;
}

/** The board as the Brain sees it: open tasks, then the last few done, one line each. */
export function boardLines(projectId: string, max = 60, only?: string): string[] {
  // (one read of this project's board, comments and all)
  return withProject(projectOf(projectId), () => {
    const f = read();
    const tasks = f.tasks.filter((t) => !only || t.id === only).sort(order);
    const open = tasks.filter((t) => t.status !== 'done');
    const done = tasks.filter((t) => t.status === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 5);
    return [...open.slice(0, max), ...done].map((t) => line(t, f.tags));
  });
}

// ---------- tags ----------
// A project's tags live in its board.json with its tasks; a task keeps their ids, so renaming one or changing its
// emoji shows on every task at once. You, the Brain and agents name tags: a name that is new makes the tag.

export interface TagInput {
  name?: unknown;
  emoji?: unknown;
}
/** The shape of a tag's id (uid('tag')): an id like that which isn't on the board is never taken as a new name. */
const TAG_ID = /^tag[0-9a-z]{16}$/;

function uses(f: BoardFile): BoardTagUse[] {
  return f.tags
    .map((x) => ({ ...x, tasks: f.tasks.filter((t) => t.tags?.includes(x.id)).length }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}
const byName = (f: BoardFile, name: string): BoardTag | undefined => f.tags.find((x) => tagKey(x.name) === tagKey(name));
/** A tag by its id or its name (a leading emoji and case don't matter). */
function findTag(f: BoardFile, ref: unknown): BoardTag | undefined {
  if (typeof ref !== 'string') return undefined;
  const r = cleanTagText(ref);
  return r ? f.tags.find((x) => x.id === r) || byName(f, r) : undefined;
}
function emojiOf(v: unknown): string {
  if (typeof v !== 'string') return fail('emoji must be text.');
  const e = cleanTagText(v);
  return !e || isEmoji(e) ? e : fail('Choose one emoji for the tag.');
}
function tagName(v: unknown): { name: string; emoji?: string } {
  if (typeof v !== 'string') return fail('Give the tag a name.');
  const split = splitTag(v);
  const problem = tagNameProblem(split.name);
  return problem ? fail(problem) : split;
}
/** Makes a tag, or gives back the one that has that name already (left as it is). */
function makeTag(f: BoardFile, input: TagInput, by: string): { tag: BoardTag; made: boolean } {
  const split = tagName(input.name);
  const emoji = input.emoji === undefined ? split.emoji : emojiOf(input.emoji) || split.emoji;
  const same = byName(f, split.name);
  if (same) return { tag: same, made: false };
  if (f.tags.length >= TAGS_PER_PROJECT) return fail(`A project can have up to ${TAGS_PER_PROJECT} tags. Delete one you no longer use first.`);
  const tag: BoardTag = { id: uid('tag'), name: split.name, ...(emoji ? { emoji } : {}), createdBy: by, createdAt: Date.now() };
  f.tags.push(tag);
  return { tag, made: true };
}
/** Tag names or ids, as a list or as text with commas ("bug, design"). */
function tagRefs(v: unknown, field: string): string[] {
  const list = typeof v === 'string' ? v.split(',') : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v as string[] : fail(`${field} must be a list of tag names.`);
  return list.map(cleanTagText).filter(Boolean);
}
function tagIds(f: BoardFile, refs: string[], by: string): string[] {
  return refs.map((r) => findTag(f, r)?.id || (TAG_ID.test(r) ? fail('That tag is unavailable. Reload and try again.', 404) : makeTag(f, { name: r }, by).tag.id));
}
/** Puts the input's tags on a task: tags (the whole list), then addTags, then removeTags. New names make tags. */
function putTags(f: BoardFile, t: ProjectTask, input: BoardInput, by: string): void {
  if (input.tags === undefined && input.addTags === undefined && input.removeTags === undefined) return;
  let ids = input.tags === undefined ? [...(t.tags || [])] : tagIds(f, tagRefs(input.tags, 'tags'), by);
  if (input.addTags !== undefined) ids.push(...tagIds(f, tagRefs(input.addTags, 'addTags'), by));
  if (input.removeTags !== undefined) {
    const gone = new Set(tagRefs(input.removeTags, 'removeTags').map((r) => findTag(f, r)?.id));
    ids = ids.filter((id) => !gone.has(id));
  }
  ids = [...new Set(ids)];
  if (ids.length > TAGS_PER_TASK) return fail(`A task can have up to ${TAGS_PER_TASK} tags.`);
  if (ids.length) t.tags = ids;
  else delete t.tags;
}
const tasksWith = (f: BoardFile, tagId: string) => f.tasks.filter((t) => t.tags?.includes(tagId));
const useOf = (f: BoardFile, tag: BoardTag): BoardTagUse => ({ ...tag, tasks: tasksWith(f, tag.id).length });

/** A tag of a project by its id or its name, or null. */
export function findBoardTag(projectId: string, ref: unknown): BoardTag | null {
  return withProject(projectOf(projectId), () => findTag(read(), ref) || null);
}

/** A project's tags, by name, with how many tasks have each. */
export function boardTags(projectId: string): BoardTagUse[] {
  return withProject(projectOf(projectId), () => uses(read()));
}

/** Makes a tag ("🐛 Bug" is the emoji and the name), or gives back the one with that name. */
export function addBoardTag(projectId: string, input: TagInput, by = 'you'): BoardTagUse & { made: boolean } {
  if (!object(input)) return fail('Give the tag a name.');
  return withProject(projectOf(projectId), () => {
    const f = read();
    const { tag, made } = makeTag(f, input, by);
    if (made) write(f, []);
    return { ...useOf(f, tag), made };
  });
}

/** Renames a tag or changes its emoji ('' takes it away). Every task with it shows the change. */
export function changeBoardTag(projectId: string, ref: string, input: TagInput): BoardTagUse {
  if (!object(input)) return fail('Say what changes.');
  return withProject(projectOf(projectId), () => {
    const f = read();
    const tag = findTag(f, ref) || fail('That tag is unavailable.', 404);
    if (input.name !== undefined) {
      const split = tagName(input.name);
      const other = byName(f, split.name);
      if (other && other.id !== tag.id) return fail(`There's a tag called "${tagLabel(other)}" already.`, 409);
      tag.name = split.name;
      if (split.emoji && input.emoji === undefined) tag.emoji = split.emoji;
    }
    if (input.emoji !== undefined) {
      const e = emojiOf(input.emoji);
      if (e) tag.emoji = e;
      else delete tag.emoji;
    }
    write(f, tasksWith(f, tag.id).map((t) => t.id));
    return useOf(f, tag);
  });
}

/** Deletes a tag and takes it off every task that had it. */
export function removeBoardTag(projectId: string, ref: string): { tag: BoardTag; tasks: number } {
  return withProject(projectOf(projectId), () => {
    const f = read();
    const tag = findTag(f, ref) || fail('That tag is unavailable.', 404);
    const had = tasksWith(f, tag.id);
    const now = Date.now();
    for (const t of had) {
      t.tags = t.tags!.filter((id) => id !== tag.id);
      if (!t.tags.length) delete t.tags;
      t.updatedAt = Math.max(now, t.updatedAt + 1);
    }
    write({ ...f, tags: f.tags.filter((x) => x.id !== tag.id) }, had.map((t) => t.id));
    return { tag, tasks: had.length };
  });
}

/** The project's tags in one line, for the Brain and agents: "TAGS: 🐛 Bug (3), frontend (0)". */
export function boardTagLine(projectId: string): string {
  const all = boardTags(projectId);
  return `TAGS: ${all.length ? all.map((x) => `${tagLabel(x)} (${x.tasks})`).join(', ') : '(none yet)'}`;
}

export interface BoardQuery {
  /** tag names (or ids) */
  tags?: unknown;
  match?: unknown;
  /** tasks without any tag too */
  untagged?: unknown;
  /** 'open' (not done; the default), 'all', or one status */
  status?: unknown;
  limit?: unknown;
}
/** Tasks found by their tags (and status), as the Brain and agents read them; and the names no tag has. */
export function findBoardTasks(projectId: string, q: BoardQuery): { lines: string[]; total: number; unknown: string[] } {
  if (!object(q)) return fail('Say which tags to look for.');
  const wanted = q.tags === undefined ? [] : tagRefs(q.tags, 'tags');
  const match: TagMatch = q.match === undefined || q.match === 'any' ? 'any' : q.match === 'all' ? 'all' : fail('match must be any or all.');
  const untagged = q.untagged === true;
  if (!wanted.length && !untagged) return fail('Name the tags to look for, or ask for untagged tasks.');
  const st = q.status === undefined || q.status === 'open' ? 'open' : q.status === 'all' ? 'all' : status(q.status);
  const limit = q.limit === undefined ? 50 : typeof q.limit === 'number' && Number.isInteger(q.limit) && q.limit > 0 ? Math.min(q.limit, 200) : fail('limit must be a whole number above 0.');
  return withProject(projectOf(projectId), () => {
    const f = read();
    const unknown = wanted.filter((r) => !findTag(f, r));
    // (an id names its tag; a name is matched as a name)
    const names = wanted.map((r) => findTag(f, r)?.name ?? r);
    const hits = f.tasks
      .filter((t) => (st === 'all' || (st === 'open' ? t.status !== 'done' : t.status === st)) && tagsMatch(tagsOf(t, f.tags).map((x) => x.name), names, match, untagged))
      .sort((a, b) => BOARD_STATUSES.indexOf(a.status) - BOARD_STATUSES.indexOf(b.status) || order(a, b));
    return { lines: hits.slice(0, limit).map((t) => line(t, f.tags)), total: hits.length, unknown };
  });
}

export function removeBoardTask(projectId: string, id: string): void {
  withProject(projectOf(projectId), () => {
    const f = read();
    if (!f.tasks.some((t) => t.id === id)) return fail('That task is unavailable.', 404);
    write({ ...f, tasks: f.tasks.filter((t) => t.id !== id) }, [id]);
  });
}

/** A saved copy of a project's board (its folder save, a backup): well-formed tasks only. */
export function restoredBoard(raw: unknown): BoardFile {
  const values: unknown[] = object(raw) && Array.isArray(raw.tasks) ? raw.tasks : [];
  const { tags, same } = restoredTags(object(raw) ? raw.tags : undefined);
  const tasks: ProjectTask[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!object(v) || typeof v.id !== 'string' || !/^[\w.-]+$/.test(v.id) || seen.has(v.id) || typeof v.title !== 'string' || !v.title.trim()) continue;
    const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
    const ref = (x: unknown) => (typeof x === 'string' && /^(|you|brain|(?:agent|team):[\w.-]+)$/.test(x) ? x : '');
    const s: BoardStatus = (BOARD_STATUSES as readonly unknown[]).includes(v.status) ? v.status as BoardStatus : 'todo';
    const files = restoredFiles(v.files);
    tasks.push({
      id: v.id,
      number: num(v.number, tasks.length + 1),
      title: v.title,
      description: typeof v.description === 'string' ? v.description : '',
      status: s,
      priority: (BOARD_PRIORITIES as readonly unknown[]).includes(v.priority) ? v.priority as BoardPriority : 'normal',
      assignee: ref(v.assignee),
      rank: num(v.rank, 0),
      ...(s === 'blocked' && typeof v.blockedReason === 'string' && v.blockedReason ? { blockedReason: v.blockedReason } : {}),
      createdBy: ref(v.createdBy) || 'you',
      createdAt: num(v.createdAt, Date.now()),
      updatedAt: num(v.updatedAt, Date.now()),
      ...(s === 'done' ? { doneAt: num(v.doneAt, num(v.updatedAt, Date.now())) } : {}),
      ...(files.length ? { files } : {}),
      ...(() => {
        const kept = Array.isArray(v.tags) ? [...new Set(v.tags.flatMap((x) => (typeof x === 'string' && same.get(x)) || []))].slice(0, TAGS_PER_TASK) : [];
        return kept.length ? { tags: kept } : {};
      })(),
      // (work isn't kept: its runs and threads belong to the copy it was saved from)
      ...(Array.isArray(v.comments) ? { comments: v.comments.filter((c): c is Record<string, unknown> => object(c) && typeof c.id === 'string' && /^[\w.-]+$/.test(c.id) && typeof c.text === 'string' && (!!c.text.trim() || restoredFiles(c.files).length > 0)).map((c) => ({ id: c.id as string, by: ref(c.by) || 'you', text: c.text as string, at: num(c.at, Date.now()), ...(typeof c.editedAt === 'number' ? { editedAt: c.editedAt } : {}), ...(restoredFiles(c.files).length ? { files: restoredFiles(c.files) } : {}) })) } : {}),
    });
    seen.add(v.id);
  }
  const next = Math.max(object(raw) && typeof raw.next === 'number' ? raw.next : 1, tasks.reduce((n, t) => Math.max(n, t.number), 0) + 1);
  return { tasks, next, tags };
}

/** Tags on a saved copy: a safe id, a name that can be used, one emoji or none; no two with one name. same: the id
 *  each saved id is kept as (a second tag with a name already kept becomes that one, so its tasks keep the tag). */
function restoredTags(raw: unknown): { tags: BoardTag[]; same: Map<string, string> } {
  const out: BoardTag[] = [];
  const same = new Map<string, string>();
  for (const x of Array.isArray(raw) ? raw : []) {
    if (!object(x) || typeof x.id !== 'string' || !/^[\w.-]+$/.test(x.id) || typeof x.name !== 'string' || same.has(x.id)) continue;
    const split = splitTag(x.name);
    if (tagNameProblem(split.name)) continue;
    const twin = out.find((y) => tagKey(y.name) === tagKey(split.name));
    if (twin) {
      same.set(x.id, twin.id);
      continue;
    }
    if (out.length >= TAGS_PER_PROJECT) continue;
    same.set(x.id, x.id);
    const emoji = typeof x.emoji === 'string' && isEmoji(x.emoji) ? x.emoji : split.emoji;
    out.push({
      id: x.id,
      name: split.name,
      ...(emoji ? { emoji } : {}),
      createdBy: typeof x.createdBy === 'string' && /^(you|brain|agent:[\w.-]+)$/.test(x.createdBy) ? x.createdBy : 'you',
      createdAt: typeof x.createdAt === 'number' && Number.isFinite(x.createdAt) ? x.createdAt : Date.now(),
    });
  }
  return { tags: out, same };
}

/** Files on a saved copy: paths inside the uploads folder only (relative, no way out of it). */
function restoredFiles(raw: unknown): TaskFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(object).flatMap((x) => {
    const rel = typeof x.path === 'string' ? x.path : '';
    if (!rel || /^[\\/]|^[a-z]:/i.test(rel) || rel.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) return [];
    return [{
      path: rel,
      name: typeof x.name === 'string' && x.name ? x.name : rel.split(/[\\/]/).at(-1)!,
      size: typeof x.size === 'number' && x.size >= 0 ? x.size : 0,
      ...(typeof x.sha256 === 'string' && /^[a-f0-9]{64}$/.test(x.sha256) ? { sha256: x.sha256 } : {}),
      by: typeof x.by === 'string' && /^(you|agent:[\w.-]+)$/.test(x.by) ? x.by : 'you',
      at: typeof x.at === 'number' ? x.at : Date.now(),
    }];
  });
}
