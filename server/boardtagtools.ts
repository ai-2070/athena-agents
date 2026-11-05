// Board tags for agents (the board_tags tool): any agent tags any task of its run's project, makes, renames and
// deletes that project's tags, and finds tasks by tag. Not in a gateway conversation, where the agent
// answers someone outside the dashboard (the Brain's board is out of reach there too).
import { activeProject, withProject } from './store.ts';
import { runInfo } from './engines/index.ts';
import { isGatewayConversation } from './private-conversations.ts';
import { addBoardTag, boardTagLine, changeBoardTag, changeBoardTask, findBoardTag, findBoardTask, findBoardTasksText, removeBoardTag } from './taskboard.ts';
import { tagLabel } from '../shared/boardtags.ts';
import type { Project } from '../shared/types.ts';

const fail = (message: string): never => { throw Object.assign(new Error(message), { status: 400 }); };

/** The project a call changes: its run's own (never the one open on the screen); without a run, the open one. */
function boardOf(runId: string | null | undefined, agentId: string): Project {
  const run = runId ? runInfo(runId) : null;
  if (runId && (!run || run.agentId !== agentId)) return fail('That run is not available to you.');
  if (isGatewayConversation(run?.conversationId)) return fail('The Tasks board isn\'t available in this conversation.');
  return run?.project || activeProject();
}

export interface BoardTagsArgs {
  action?: unknown;
  name?: unknown;
  emoji?: unknown;
  rename?: unknown;
  task?: unknown;
  tags?: unknown;
  add?: unknown;
  remove?: unknown;
  match?: unknown;
  untagged?: unknown;
  status?: unknown;
  limit?: unknown;
}

/** board_tags: list, find tasks, tag a task, create, edit or delete a tag. */
export function agentBoardTags(runId: string | null | undefined, agentId: string, args: BoardTagsArgs): string {
  const p = boardOf(runId, agentId);
  const by = `agent:${agentId}`;
  return withProject(p, () => {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const tag = () => (name ? findBoardTag(p.id, name) : null) || fail(name ? `No tag "${name}" on the board. ${boardTagLine(p.id)}` : 'Say which tag (name).');
    switch (args.action) {
      case 'list':
        return boardTagLine(p.id);
      case 'find':
        return findBoardTasksText(p.id, { tags: args.tags, match: args.match, untagged: args.untagged, status: args.status, limit: args.limit });
      case 'create': {
        const t = addBoardTag(p.id, { name: args.name, emoji: args.emoji }, by);
        return t.made ? `Made tag ${tagLabel(t)}.` : `Tag ${tagLabel(t)} is there already (on ${t.tasks} task${t.tasks === 1 ? '' : 's'}).`;
      }
      case 'tag': {
        if (args.tags === undefined && args.add === undefined && args.remove === undefined) return fail('Give tags, add or remove.');
        const t = changeBoardTask(p.id, findBoardTask(p.id, args.task).id, { tags: args.tags, addTags: args.add, removeTags: args.remove }, undefined, by);
        return t.tagList.length ? `Tagged #${t.number} ${t.title}: ${t.tagList.map(tagLabel).join(', ')}.` : `#${t.number} ${t.title} has no tags now.`;
      }
      case 'edit': {
        const was = tag();
        if (args.rename === undefined && args.emoji === undefined) return fail('Give rename or emoji.');
        const t = changeBoardTag(p.id, was.id, { name: args.rename, emoji: args.emoji });
        return `Tag ${tagLabel(was)} is now ${tagLabel(t)} (on ${t.tasks} task${t.tasks === 1 ? '' : 's'}).`;
      }
      case 'delete': {
        const gone = removeBoardTag(p.id, tag().id);
        return `Deleted tag ${tagLabel(gone.tag)}${gone.tasks ? `; it came off ${gone.tasks} task${gone.tasks === 1 ? '' : 's'}` : ''}.`;
      }
      default:
        return fail('action must be list, find, tag, create, edit or delete.');
    }
  });
}
