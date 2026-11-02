// The Tasks board: the project's own tasks (data/projects/<id>/board.json), apart from the step lists agents keep
// in their chats (tasks.ts). The board shows one project's or every project's; a change is made in the project
// the task belongs to (withProject), whichever project is open.
import { agents, workflows, listProjects, withProject, activeProject, emit } from './store.ts';
import { dataPath, readJSON, writeJSON, uid } from './util.ts';
import type { BoardPeople, BoardPriority, BoardStatus, BoardTask, Project, ProjectTask, TaskBoardData } from '../shared/types.ts';

export const BOARD_STATUSES: readonly BoardStatus[] = ['todo', 'in_progress', 'in_review', 'blocked', 'done'];
export const BOARD_PRIORITIES: readonly BoardPriority[] = ['urgent', 'high', 'normal', 'low'];
const MAX_TASKS = 10000;

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
const text = (v: unknown, name: string, max: number, required = false): string => {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) return fail(`${name} must be ${required ? 'non-empty text' : 'text'} of at most ${max} characters.`);
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
function card(p: Project, t: ProjectTask): BoardTask {
  const a = who(t.assignee, 'Unassigned');
  return {
    ...t,
    projectId: p.id,
    projectName: p.name,
    assigneeName: a.name,
    ...(a.emoji ? { assigneeEmoji: a.emoji } : {}),
    ...(a.color ? { assigneeColor: a.color } : {}),
    creatorName: who(t.createdBy, 'You').name,
  };
}
const order = (a: ProjectTask, b: ProjectTask) => a.rank - b.rank || b.createdAt - a.createdAt || a.id.localeCompare(b.id);

/** The cards of one project, or of all of them ('all'), in board order; and every project with its open count. */
export function taskBoard(project: string): TaskBoardData {
  const all = listProjects();
  const chosen = project === 'all' ? all : [projectOf(project)];
  const tasks = chosen.flatMap((p) => withProject(p, () => read().tasks.map((t) => card(p, t))));
  tasks.sort(order);
  const projects = all.map((p) => ({ id: p.id, name: p.name, open: withProject(p, () => read().tasks.filter((t) => t.status !== 'done').length) }));
  return { projects, tasks };
}

/** One task as its page shows it. */
export function boardTask(projectId: string, id: string): BoardTask {
  const p = projectOf(projectId);
  return withProject(p, () => {
    const t = read().tasks.find((x) => x.id === id);
    return t ? card(p, t) : fail('That task is unavailable.', 404);
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
export function addBoardTask(projectId: string, input: BoardInput, by = 'you'): BoardTask {
  const p = projectOf(projectId);
  if (!object(input)) return fail('Give the task a title.');
  return withProject(p, () => {
    const f = read();
    if (f.tasks.length >= MAX_TASKS) return fail('This project has 10,000 tasks. Remove old ones before adding more.');
    const s = input.status === undefined ? 'todo' : status(input.status);
    const top = f.tasks.filter((t) => t.status === s).sort(order)[0];
    const now = Date.now();
    const t: ProjectTask = {
      id: uid('bt'),
      number: f.next,
      title: text(input.title, 'title', 200, true),
      description: input.description === undefined ? '' : text(input.description, 'description', 8000),
      status: s,
      priority: input.priority === undefined ? 'normal' : priority(input.priority),
      assignee: input.assignee === undefined ? '' : assignee(input.assignee),
      rank: input.rank === undefined ? (top ? top.rank - 1024 : 0) : rank(input.rank),
      ...(s === 'blocked' && typeof input.blockedReason === 'string' && input.blockedReason.trim() ? { blockedReason: text(input.blockedReason, 'blockedReason', 300) } : {}),
      createdBy: by,
      createdAt: now,
      updatedAt: now,
      ...(s === 'done' ? { doneAt: now } : {}),
    };
    write({ tasks: [...f.tasks, t], next: f.next + 1 }, [t.id]);
    return card(p, t);
  });
}

/** Moves (status, rank) or edits a task in its own project. Leaving Blocked drops its reason. */
export function changeBoardTask(projectId: string, id: string, input: BoardInput & { expectedUpdatedAt?: unknown }): BoardTask {
  const p = projectOf(projectId);
  if (!object(input)) return fail('Say what changes.');
  return withProject(p, () => {
    const f = read();
    const t = f.tasks.find((x) => x.id === id) || fail('That task is unavailable.', 404);
    if (typeof input.expectedUpdatedAt === 'number' && input.expectedUpdatedAt !== t.updatedAt) return fail('This task changed meanwhile. Reload it before saving.', 409);
    if (input.title !== undefined) t.title = text(input.title, 'title', 200, true);
    if (input.description !== undefined) t.description = text(input.description, 'description', 8000);
    if (input.priority !== undefined) t.priority = priority(input.priority);
    if (input.assignee !== undefined) t.assignee = assignee(input.assignee);
    if (input.rank !== undefined) t.rank = rank(input.rank);
    if (input.status !== undefined) {
      const s = status(input.status);
      if (s === 'done' && t.status !== 'done') t.doneAt = Date.now();
      if (s !== 'done') delete t.doneAt;
      t.status = s;
    }
    if (t.status !== 'blocked') delete t.blockedReason;
    else if (input.blockedReason !== undefined) {
      const why = text(input.blockedReason, 'blockedReason', 300);
      if (why) t.blockedReason = why;
      else delete t.blockedReason;
    }
    t.updatedAt = Math.max(Date.now(), t.updatedAt + 1);
    write(f, [t.id]);
    return card(p, t);
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
  for (const v of values.slice(0, MAX_TASKS)) {
    if (!object(v) || typeof v.id !== 'string' || !/^[\w.-]+$/.test(v.id) || seen.has(v.id) || typeof v.title !== 'string' || !v.title.trim()) continue;
    const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
    const ref = (x: unknown) => (typeof x === 'string' && /^(|you|brain|(?:agent|team):[\w.-]+)$/.test(x) ? x : '');
    const s: BoardStatus = (BOARD_STATUSES as readonly unknown[]).includes(v.status) ? v.status as BoardStatus : 'todo';
    tasks.push({
      id: v.id,
      number: num(v.number, tasks.length + 1),
      title: v.title.slice(0, 200),
      description: typeof v.description === 'string' ? v.description.slice(0, 8000) : '',
      status: s,
      priority: (BOARD_PRIORITIES as readonly unknown[]).includes(v.priority) ? v.priority as BoardPriority : 'normal',
      assignee: ref(v.assignee),
      rank: num(v.rank, 0),
      ...(s === 'blocked' && typeof v.blockedReason === 'string' && v.blockedReason ? { blockedReason: v.blockedReason.slice(0, 300) } : {}),
      createdBy: ref(v.createdBy) || 'you',
      createdAt: num(v.createdAt, Date.now()),
      updatedAt: num(v.updatedAt, Date.now()),
      ...(s === 'done' ? { doneAt: num(v.doneAt, num(v.updatedAt, Date.now())) } : {}),
    });
    seen.add(v.id);
  }
  const next = Math.max(object(raw) && typeof raw.next === 'number' ? raw.next : 1, tasks.reduce((n, t) => Math.max(n, t.number), 0) + 1);
  return { tasks, next };
}
