// The Tasks board's routes (server/api/taskboard.ts). The board's rules and their words stay in
// server/taskboard.ts, which agents' tools share: these say only the shape, and word what can fail on its own.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import type { BoardTag, BoardTagUse } from '../types.ts';

const inProject = z.object({ projectId: z.string() });
const oneTag = inProject.extend({ tagId: z.string() });
const tagName = z.string({ error: 'Give the tag a name.' });
const tagEmoji = z.string({ error: 'Choose one emoji for the tag.' });

/** A project's tags: made, renamed or given another emoji ('' takes it away), and deleted (which takes them off
 *  every task). Making one that exists gives that one back, with made: false. */
const tags = {
  list: oc.route({ method: 'GET', path: '/task-board-tags/{projectId}' })
    .input(inProject)
    .output(type<{ tags: BoardTagUse[] }>()),
  add: oc.route({ method: 'POST', path: '/task-board-tags/{projectId}' })
    .input(inProject.extend({ name: tagName, emoji: tagEmoji.optional() }))
    .output(type<{ tag: BoardTagUse & { made: boolean } }>()),
  change: oc.route({ method: 'PUT', path: '/task-board-tags/{projectId}/{tagId}' })
    .input(oneTag.extend({ name: tagName.optional(), emoji: tagEmoji.optional() }))
    .output(type<{ tag: BoardTagUse }>()),
  remove: oc.route({ method: 'DELETE', path: '/task-board-tags/{projectId}/{tagId}' })
    .input(oneTag)
    .output(type<{ tag: BoardTag; tasks: number }>()),
};

export const taskBoard = { tags };
