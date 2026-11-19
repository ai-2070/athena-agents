// The Outbox (shared/api/outbox.ts).
import { implement } from '@orpc/server';
import { outbox as contract } from '../../shared/api/outbox.ts';
import { activeProject } from '../store.ts';
import * as social from '../social.ts';
import { postUserMessage } from '../teams.ts';
import { pickMember } from '../brain.ts';
import { gateways } from '../gateways/supervisor.ts';

const os = implement(contract);

export const outboxRouter = os.router({
  list: os.list.handler(() => social.listPosts()),
  chats: os.chats.handler(() => gateways.chats(activeProject().id)),
  draft: os.draft.handler(({ input }) =>
    social.draftPost({ ...input, platform: input.platform || 'x', agentName: 'You' }),
  ),
  edit: os.edit.handler(({ input: { id, ...change } }) => social.editPost(id, change)),
  approve: os.approve.handler(({ input: { id, ...edits } }) => social.approvePost(id, edits)),
  discuss: os.discuss.handler(({ input }) =>
    social.returnPost(input.id, input.text || '', (teamId, text) =>
      postUserMessage(teamId, text, { route: pickMember }),
    ),
  ),
  reject: os.reject.handler(({ input }) => social.rejectPost(input.id, input.reason)),
  remove: os.remove.handler(({ input }) => (social.removePost(input.id), { ok: true as const })),
});
