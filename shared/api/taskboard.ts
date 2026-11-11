// The Tasks board's routes (server/api/taskboard.ts). The board's rules and their words stay in
// server/taskboard.ts, which agents' tools share: these say only the shape, and word what can fail on its own
// in the board's words.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type {
  BoardDraft,
  BoardPeople,
  BoardPriority,
  BoardStatus,
  BoardTag,
  BoardTagUse,
  BoardTask,
  TaskBoardData,
} from '../types.ts';

export const BOARD_STATUSES = [
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
] as const satisfies readonly BoardStatus[];
export const BOARD_PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const satisfies readonly BoardPriority[];

const inProject = z.object({ projectId: z.string() });
const oneTask = inProject.extend({ id: z.string() });
const words = (field: string, required = false) =>
  z.string({ error: `${field} must be ${required ? 'non-empty text' : 'text'}.` });
// names or ids, as a list or "a, b"
const tagRefs = (field: string) =>
  z.union([z.string(), z.array(z.string())], { error: `${field} must be a list of tag names.` });

/** What a task says: every field can be left out (a new task needs its title). files: the paths it keeps and new
 *  uploads of the open project; tags: its whole list, or addTags and removeTags to change some. */
const taskFields = {
  title: words('title', true).optional(),
  description: words('description').optional(),
  status: z
    .enum(BOARD_STATUSES, { error: 'Choose a status: To do, In progress, In review, Blocked or Done.' })
    .optional(),
  priority: z.enum(BOARD_PRIORITIES, { error: 'Choose a priority: urgent, high, normal or low.' }).optional(),
  assignee: z.string({ error: 'assignee must be empty, you, brain, agent:<id> or team:<id>.' }).optional(),
  rank: z.number({ error: 'rank must be a number.' }).optional(),
  blockedReason: words('blockedReason').optional(),
  tags: tagRefs('tags').optional(),
  addTags: tagRefs('addTags').optional(),
  removeTags: tagRefs('removeTags').optional(),
  files: z.array(z.string(), { error: 'files must be a list.' }).optional(),
};
const taskChange = z.object({
  ...taskFields,
  /** the version the change was made on: refused (409) when the task changed meanwhile */
  expectedUpdatedAt: z.number().optional(),
});
/** A change to a task, as the page sends it. */
export type BoardChange = z.input<typeof taskChange>;

const withTask = type<{ task: BoardTask }>();
const tagName = z.string({ error: 'Give the tag a name.' });
const tagEmoji = z.string({ error: 'Choose one emoji for the tag.' });
const oneTag = inProject.extend({ tagId: z.string() });

/** A project's tags: made, renamed or given another emoji ('' takes it away), and deleted (which takes them off
 *  every task). Making one that exists gives that one back, with made: false. */
const tags = {
  list: oc
    .route({ method: 'GET', path: '/task-board-tags/{projectId}' })
    .input(inProject)
    .output(type<{ tags: BoardTagUse[] }>()),
  add: oc
    .route({ method: 'POST', path: '/task-board-tags/{projectId}' })
    .input(inProject.extend({ name: tagName, emoji: tagEmoji.optional() }))
    .output(type<{ tag: BoardTagUse & { made: boolean } }>()),
  change: oc
    .route({ method: 'PUT', path: '/task-board-tags/{projectId}/{tagId}' })
    .input(oneTag.extend({ name: tagName.optional(), emoji: tagEmoji.optional() }))
    .output(type<{ tag: BoardTagUse }>()),
  remove: oc
    .route({ method: 'DELETE', path: '/task-board-tags/{projectId}/{tagId}' })
    .input(oneTag)
    .output(type<{ tag: BoardTag; tasks: number }>()),
};

/** A task's comments, yours: written (with files, then the text may be empty), changed and removed. */
const comments = {
  add: oc
    .route({ method: 'POST', path: '/task-board/{projectId}/{id}/comments' })
    .input(oneTask.extend({ text: words('comment').optional(), files: taskFields.files }))
    .output(withTask),
  change: oc
    .route({ method: 'PUT', path: '/task-board/{projectId}/{id}/comments/{commentId}' })
    .input(oneTask.extend({ commentId: z.string(), text: words('comment', true) }))
    .output(withTask),
  remove: oc
    .route({ method: 'DELETE', path: '/task-board/{projectId}/{id}/comments/{commentId}' })
    .input(oneTask.extend({ commentId: z.string() }))
    .output(withTask),
};

export const taskBoard = {
  /** One project's cards, or every project's ('all'), with each project's open count and tags. */
  list: oc
    .route({ method: 'GET', path: '/task-board' })
    .input(z.object({ project: z.string().optional() }))
    .output(type<TaskBoardData>()),
  /** Who a project's tasks can go to. */
  people: oc
    .route({ method: 'GET', path: '/task-board-people/{projectId}' })
    .input(inProject)
    .output(type<BoardPeople>()),
  /** A new task. Made In progress for an agent or team, its work starts. */
  add: oc
    .route({ method: 'POST', path: '/task-board/{projectId}' })
    .input(inProject.extend({ ...taskFields, title: words('title', true) }))
    .output(withTask),
  get: oc.route({ method: 'GET', path: '/task-board/{projectId}/{id}' }).input(oneTask).output(withTask),
  /** Moves or edits a task; moving it to or from In progress, or giving it to someone else, starts or stops work. */
  change: oc
    .route({ method: 'PUT', path: '/task-board/{projectId}/{id}' })
    .input(oneTask.extend(taskChange.shape))
    .output(withTask),
  /** Stops its work, then removes it. */
  remove: oc
    .route({ method: 'DELETE', path: '/task-board/{projectId}/{id}' })
    .input(oneTask)
    .output(type<{ ok: true }>()),
  start: oc.route({ method: 'POST', path: '/task-board/{projectId}/{id}/start' }).input(oneTask).output(withTask),
  stop: oc.route({ method: 'POST', path: '/task-board/{projectId}/{id}/stop' }).input(oneTask).output(withTask),
  /** Checks work that ended for review again; operationId: the work it was shown for (409 when that changed). */
  check: oc
    .route({ method: 'POST', path: '/task-board/{projectId}/{id}/check' })
    .input(oneTask.extend({ operationId: z.string().optional() }))
    .output(withTask),
  /** A column's cards spaced out again, in one or several projects (only the ranks change). */
  rerank: oc
    .route({ method: 'PUT', path: '/task-board-ranks' })
    .input(
      z.object({
        ranks: z.array(
          z.object(
            {
              projectId: z.string(),
              id: z.string(),
              status: taskFields.status.unwrap(),
              rank: z.number({ error: 'rank must be a number.' }),
            },
            { error: 'Each rank needs a projectId and an id.' },
          ),
          { error: 'ranks must be a list.' },
        ),
      }),
    )
    .output(type<{ ok: true }>()),
  /** "Draft with the Brain": a title and description, or a comment, put back in the box (nothing is saved). */
  draft: oc
    .route({ method: 'POST', path: '/task-board-draft' })
    .input(
      z.object({
        projectId: z.string({ error: 'That project is unavailable.' }),
        kind: z.enum(['task', 'comment'], { error: 'Say whether to draft a task or a comment.' }),
        taskId: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        text: z.string().optional(),
        instruction: z.string().optional(),
      }),
    )
    .output(type<BoardDraft>()),
  tags,
  comments,
};
