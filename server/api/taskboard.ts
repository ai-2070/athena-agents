// The Tasks board's routes (shared/api/taskboard.ts), on the same functions agents' tools use. A task you make
// In progress for an agent, a team or the Brain, or move there, starts its work (boardwork.ts); moving it away or giving it to
// someone else stops it. Files are uploads of the open project, copied into the task's own.
import { implement } from '@orpc/server';
import { taskBoard as contract } from '../../shared/api/taskboard.ts';
import { projectById } from '../store.ts';
import { filesFromRequest } from '../boardfiles.ts';
import { draftBoardText } from '../taskdraft.ts';
import * as board from '../taskboard.ts';
import * as work from '../boardwork.ts';
import { refuse } from './refuse.ts';

const os = implement(contract);

export const taskBoard = os.router({
  list: os.list.handler(({ input }) => board.taskBoard(input.project || 'all')),
  people: os.people.handler(({ input }) => board.boardPeople(input.projectId)),
  add: os.add.handler(async ({ input: { projectId, files: list, ...fields } }) => {
    const files = await filesFromRequest(projectById(projectId), list ?? []);
    const task = board.addBoardTask(projectId, fields, 'you', files);
    return { task: task.status === 'in_progress' && work.canPickUp(task.assignee) ? await work.startWork(projectId, task.id) : task };
  }),
  get: os.get.handler(({ input }) => ({ task: board.boardTask(input.projectId, input.id) })),
  change: os.change.handler(async ({ input: { projectId, id, files: list, ...change } }) => {
    const before = board.savedBoardTask(projectId, id) || refuse('That task is unavailable.', 404);
    const files = list === undefined ? undefined : await filesFromRequest(projectById(projectId), list, before.files);
    const after = board.changeBoardTask(projectId, id, change, files);
    return { task: await work.afterUserChange(projectId, before, after) };
  }),
  remove: os.remove.handler(({ input }) => {
    work.stopWork(input.projectId, input.id);
    board.removeBoardTask(input.projectId, input.id);
    return { ok: true as const };
  }),
  start: os.start.handler(async ({ input }) => ({ task: await work.startWork(input.projectId, input.id) })),
  stop: os.stop.handler(({ input }) => ({ task: work.stopWork(input.projectId, input.id) })),
  check: os.check.handler(({ input }) => ({ task: work.checkWork(input.projectId, input.id, input.operationId) })),
  rerank: os.rerank.handler(({ input }) => (board.rerankBoardTasks(input.ranks), { ok: true as const })),
  draft: os.draft.handler(({ input }) => draftBoardText(input)),
  tags: {
    list: os.tags.list.handler(({ input }) => ({ tags: board.boardTags(input.projectId) })),
    add: os.tags.add.handler(({ input: { projectId, ...tag } }) => ({ tag: board.addBoardTag(projectId, tag, 'you') })),
    change: os.tags.change.handler(({ input: { projectId, tagId, ...tag } }) => ({ tag: board.changeBoardTag(projectId, tagId, tag) })),
    remove: os.tags.remove.handler(({ input }) => board.removeBoardTag(input.projectId, input.tagId)),
  },
  comments: {
    add: os.comments.add.handler(async ({ input: { projectId, id, text, files: list } }) => {
      const files = await filesFromRequest(projectById(projectId), list ?? []);
      const task = board.addBoardComment(projectId, id, text, 'you', files);
      // (while an agent or team works on it, your comment reaches them too)
      void work.passToWorker(projectId, id, `A new comment on the task from you:\n\n${text ?? ''}`, files).catch(() => {});
      return { task };
    }),
    change: os.comments.change.handler(({ input }) => ({ task: board.changeBoardComment(input.projectId, input.id, input.commentId, input.text) })),
    remove: os.comments.remove.handler(({ input }) => ({ task: board.changeBoardComment(input.projectId, input.id, input.commentId, null) })),
  },
});
