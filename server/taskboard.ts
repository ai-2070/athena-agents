// The Tasks board: every project's tasks (or one project's) as cards, with the names they show, and moves,
// edits and new tasks made in the project a task belongs to (withProject), not the one open in the dashboard.
import { agents, workflows, listProjects, withProject } from './store.ts';
import { createTask, getTask, savedTasks, updateTask } from './tasks.ts';
import type { TaskAccess } from './tasks.ts';
import type { BoardTask, Project, TaskBoardData, TaskStatus, WorkTask } from '../shared/types.ts';

// the board acts for you, like the task panels in the chats
const YOU: TaskAccess = { admin: true, scope: { kind: 'brain' } };
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };

function projectOf(id: unknown): Project {
  const p = typeof id === 'string' ? listProjects().find((x) => x.id === id) : undefined;
  return p || fail('That project is unavailable.', 404);
}

const live = (t: WorkTask): t is WorkTask & { status: Exclude<TaskStatus, 'deleted'> } => t.status !== 'deleted';

// (inside withProject: the agents and teams read are the project's own)
function cards(p: Project): BoardTask[] {
  const all = savedTasks().filter(live);
  const unfinished = new Set(all.filter((t) => t.status !== 'completed').map((t) => t.id));
  const agentOf = (id: string | undefined) => (id ? agents.get(id) : null);
  const teamOf = (id: string | undefined) => (id ? workflows.get(id) : null);
  return all.map((t) => {
    const listName = t.scope.kind === 'brain' ? 'The Brain' : t.scope.kind === 'agent' ? agentOf(t.scope.id)?.name || 'A former agent' : teamOf(t.scope.id)?.name || 'A former team';
    const [kind, id] = t.owner.includes(':') ? [t.owner.slice(0, t.owner.indexOf(':')), t.owner.slice(t.owner.indexOf(':') + 1)] : [t.owner, ''];
    const a = kind === 'agent' ? agentOf(id) : null;
    const ownerName = !t.owner ? 'Unassigned' : kind === 'brain' ? 'The Brain' : kind === 'agent' ? a?.name || 'A former agent' : teamOf(id)?.name || 'A former team';
    return {
      id: t.id,
      projectId: p.id,
      projectName: p.name,
      subject: t.subject,
      preview: t.description.replace(/\s+/g, ' ').trim().slice(0, 160),
      activeForm: t.activeForm,
      status: t.status,
      scope: t.scope,
      listName,
      owner: t.owner,
      ownerName,
      ...(a?.emoji ? { ownerEmoji: a.emoji } : {}),
      ...(a?.color ? { ownerColor: a.color } : {}),
      blockedBy: t.blockedBy.filter((x) => unfinished.has(x)),
      // never moved on the board: newest first, as the task lists show them
      rank: typeof t.rank === 'number' ? t.rank : -t.createdAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  });
}

/** The cards of one project, or of all of them ('all'), in board order; and every project with its open count. */
export function taskBoard(project: string): TaskBoardData {
  const all = listProjects();
  const chosen = project === 'all' ? all : [projectOf(project)];
  const tasks = chosen.flatMap((p) => withProject(p, () => cards(p)));
  tasks.sort((a, b) => a.rank - b.rank || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const projects = all.map((p) => ({ id: p.id, name: p.name, open: withProject(p, () => savedTasks().filter((t) => t.status === 'pending' || t.status === 'in_progress').length) }));
  return { projects, tasks };
}

/** One task in full (its whole description), read in its own project. */
export function boardTaskDetail(projectId: string, taskId: string): WorkTask {
  const p = projectOf(projectId);
  return withProject(p, () => getTask(taskId, YOU)) || fail('That task is unavailable.', 404);
}

export interface BoardPatch {
  status?: TaskStatus;
  rank?: number;
  subject?: string;
  description?: string;
  owner?: string;
}

/** Moves (status, rank) or edits a task in its own project. */
export function changeBoardTask(projectId: string, taskId: string, patch: BoardPatch): WorkTask {
  const p = projectOf(projectId);
  const { status, rank, subject, description, owner } = patch || {};
  return withProject(p, () => updateTask({ taskId, status, rank, subject, description, owner }, YOU));
}

/** A new task on the Brain's list of a project, in the column it was added to. */
export function addBoardTask(projectId: string, input: { subject?: unknown; description?: unknown; status?: unknown; rank?: unknown }): WorkTask {
  const p = projectOf(projectId);
  const subject = typeof input?.subject === 'string' ? input.subject : '';
  // (a card needs only a title: the description, which a task must have, starts as the title)
  const description = typeof input?.description === 'string' && input.description.trim() ? input.description : subject;
  return withProject(p, () => {
    const task = createTask({ subject, description, scope: { kind: 'brain' } }, YOU);
    const status = input?.status === 'in_progress' || input?.status === 'completed' ? input.status : undefined;
    const rank = typeof input?.rank === 'number' && Number.isFinite(input.rank) ? input.rank : undefined;
    return status || rank !== undefined ? updateTask({ taskId: task.id, status, rank }, YOU) : task;
  });
}
