// The Tasks board's routes (shared/api/taskboard.ts), on the same functions agents' tools use.
import { implement } from '@orpc/server';
import { taskBoard as contract } from '../../shared/api/taskboard.ts';
import * as board from '../taskboard.ts';

const os = implement(contract);

export const taskBoard = os.router({
  tags: {
    list: os.tags.list.handler(({ input }) => ({ tags: board.boardTags(input.projectId) })),
    add: os.tags.add.handler(({ input: { projectId, ...tag } }) => ({ tag: board.addBoardTag(projectId, tag, 'you') })),
    change: os.tags.change.handler(({ input: { projectId, tagId, ...tag } }) => ({ tag: board.changeBoardTag(projectId, tagId, tag) })),
    remove: os.tags.remove.handler(({ input }) => board.removeBoardTag(input.projectId, input.tagId)),
  },
});
