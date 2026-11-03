// The Tasks board: the project's own tasks (data/projects/<id>/board.json), apart from the step lists agents keep
// in their chats (tasks.ts). The board shows one project's or every project's; a change is made in the project
// the task belongs to (withProject), whichever project is open.
import { agents, workflows, listProjects, withProject, activeProject, emit } from './store.ts';
import { dataPath, readJSON, writeJSON, uid } from './util.ts';
import type { BoardComment, BoardPeople, BoardPriority, BoardStatus, BoardTask, Project, ProjectTask, TaskBoardData, TaskComment, TaskFile } from '../shared/types.ts';

export const BOARD_STATUSES: readonly BoardStatus[] = ['todo', 'in_progress', 'in_review', 'blocked', 'done'];
export const BOARD_PRIORITIES: readonly BoardPriority[] = ['urgent', 'high', 'normal', 'low'];

interface BoardFile {
  tasks: ProjectTask[];
  /** the number the next task gets */
  next: number;
}
const file = () => dataPath('projects', activeProject().id, 'board.json');
const read = (): BoardFile => {
  const f = readJSON<Partial<BoardFile>>(file(), {});
  const tasks = Array.isArray(f.tasks) ? f.tasks : [];
  return { tasks, next: typeof f.next === 'number' ? f.next : tasks.reduce((n, t) => Math.max(n, t.number || 0), 0) + 1 };
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
/** A task as the board shows it. withComments: its comments too, with their writers' names (the task's page). */
function card(p: Project, t: ProjectTask, withComments = false): BoardTask {
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
  };
}
function named(c: TaskComment): BoardComment {
  const w = who(c.by, 'You');
  return { ...c, byName: w.name, ...(w.emoji ? { byEmoji: w.emoji } : {}) };
}
const order = (a: ProjectTask, b: ProjectTask) => a.rank - b.rank || b.createdAt - a.createdAt || a.id.localeCompare(b.id);

/** The cards of one project, or of all of them ('all'), in board order; and every project with its open count. */
export function taskBoard(project: string): TaskBoardData {
  const all = listProjects();
  const chosen = project === 'all' ? all : [all.find((p) => p.id === project) || fail('That project is unavailable.', 404)];
  // each project's board is read once: for its open count, and for its cards when it is shown
  const boards = new Map(all.map((p) => [p.id, withProject(p, () => read().tasks)]));
  const tasks = chosen.flatMap((p) => withProject(p, () => boards.get(p.id)!.map((t) => card(p, t))));
  tasks.sort(order);
  const projects = all.map((p) => ({ id: p.id, name: p.name, open: boards.get(p.id)!.filter((t) => t.status !== 'done').length }));
  return { projects, tasks };
}

/** One project's cards (not the others': the Overview page asks project by project). */
export function projectCards(projectId: string): BoardTask[] {
  const p = projectOf(projectId);
  return withProject(p, () => read().tasks.map((t) => card(p, t)));
}

/** One task as its page shows it. */
export function boardTask(projectId: string, id: string): BoardTask {
  const p = projectOf(projectId);
  return withProject(p, () => {
    const t = read().tasks.find((x) => x.id === id);
    return t ? card(p, t, true) : fail('That task is unavailable.', 404);
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
    write({ tasks: [...f.tasks, t], next: f.next + 1 }, [t.id]);
    return card(p, t);
  });
}

/** Moves (status, rank) or edits a task in its own project. Leaving Blocked drops its reason. */
export function changeBoardTask(projectId: string, id: string, input: BoardInput & { expectedUpdatedAt?: unknown }, files?: TaskFile[]): BoardTask {
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
    return card(p, t, true);
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
    return card(p, t, true);
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
    return card(p, t, true);
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
    return card(p, t, true);
  });
}
const text_ = (v: unknown) => text(v, 'comment', true);

/** A task by its #number, its id or a title only one task has (the Brain names tasks these ways). */
export function findBoardTask(projectId: string, ref: unknown): BoardTask {
  const p = projectOf(projectId);
  return withProject(p, () => {
    const all = read().tasks;
    const r = typeof ref === 'number' ? `#${ref}` : typeof ref === 'string' ? ref.trim() : '';
    const n = /^#?(\d+)$/.exec(r);
    const hit = (n ? all.find((t) => t.number === Number(n[1])) : undefined) || all.find((t) => t.id === r);
    if (hit) return card(p, hit);
    const named = all.filter((t) => t.title.toLowerCase() === r.toLowerCase());
    if (named.length === 1) return card(p, named[0]);
    return fail(named.length ? `${named.length} tasks are called "${r}": use its #number` : `no task "${r}" on the board`, 404);
  });
}

/** The board as the Brain sees it: open tasks, then the last few done, one line each. */
export function boardLines(projectId: string, max = 60, only?: string): string[] {
  const label: Record<BoardStatus, string> = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', blocked: 'Blocked', done: 'Done' };
  // (one read of this project's board, comments and all)
  return withProject(projectOf(projectId), () => {
    const tasks = read().tasks.filter((t) => !only || t.id === only).sort(order);
    const open = tasks.filter((t) => t.status !== 'done');
    const done = tasks.filter((t) => t.status === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 5);
    return [...open.slice(0, max), ...done].map((t) => {
      const comments = t.comments || [];
      const c = comments.at(-1);
      const working = t.work && ['starting', 'working', 'waiting'].includes(t.work.state) ? ` | working: ${who(`${t.work.target.kind}:${t.work.target.id}`, 'someone').name}` : '';
      const files = (t.files?.length || 0) + comments.reduce((n, x) => n + (x.files?.length || 0), 0);
      return `#${t.number} [${label[t.status]}] ${t.priority === 'normal' ? '' : `(${t.priority}) `}${t.title} | ${t.assignee ? `${who(t.assignee, 'Unassigned').name} (${t.assignee})` : 'unassigned'}${working}${files ? ` | files: ${files}` : ''}${t.blockedReason ? ` | blocked: ${t.blockedReason}` : ''}${t.description ? ` | ${t.description.replace(/\s+/g, ' ').slice(0, 140)}` : ''}${c ? ` | ${comments.length} comment${comments.length === 1 ? '' : 's'}, last from ${who(c.by, 'you').name}: "${c.text.replace(/\s+/g, ' ').slice(0, 120)}"` : ''}`;
    });
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
      // (work isn't kept: its runs and threads belong to the copy it was saved from)
      ...(Array.isArray(v.comments) ? { comments: v.comments.filter((c): c is Record<string, unknown> => object(c) && typeof c.id === 'string' && /^[\w.-]+$/.test(c.id) && typeof c.text === 'string' && (!!c.text.trim() || restoredFiles(c.files).length > 0)).map((c) => ({ id: c.id as string, by: ref(c.by) || 'you', text: c.text as string, at: num(c.at, Date.now()), ...(typeof c.editedAt === 'number' ? { editedAt: c.editedAt } : {}), ...(restoredFiles(c.files).length ? { files: restoredFiles(c.files) } : {}) })) } : {}),
    });
    seen.add(v.id);
  }
  const next = Math.max(object(raw) && typeof raw.next === 'number' ? raw.next : 1, tasks.reduce((n, t) => Math.max(n, t.number), 0) + 1);
  return { tasks, next };
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
