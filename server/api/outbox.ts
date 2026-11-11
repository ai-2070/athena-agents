// The Outbox (shared/api/outbox.ts). A gateway delivery's review runs in the project open now (its receipts are
// that project's), and its bodies go to server/gateways/ as they came.
import { implement } from '@orpc/server';
import { outbox as contract } from '../../shared/api/outbox.ts';
import { activeProject, outbox as outboxStore, withProject } from '../store.ts';
import * as social from '../social.ts';
import { postUserMessage } from '../teams.ts';
import { pickMember } from '../brain.ts';
import { gatewaySupervisor as supervisor } from '../gateways/live.ts';
import { gatewayRetirement } from '../gateways/retirement.ts';
import { gatewayOutboxDestinations } from '../gateways/outbox-owner.ts';
import { readGatewayPostDelivery } from '../gateways/outbox-posts.ts';
import { refuse } from './refuse.ts';

const os = implement(contract);

/** A saved post that goes through a gateway (a Telegram or Discord one). */
function gatewayItem(id: string) {
  const item = outboxStore.get(id) || refuse('That post is unavailable.', 404);
  const gateway =
    item.gateway && ['telegram', 'discord'].includes(item.platform)
      ? item.gateway
      : refuse('Choose a saved gateway Outbox delivery.');
  return { item, gateway };
}

export const outboxRouter = os.router({
  list: os.list.handler(() => social.listPosts()),
  destinations: os.destinations.handler(() => gatewayOutboxDestinations(activeProject().id)),
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
  gatewayReview: os.gatewayReview.handler(({ input }) => social.prepareGatewayPost(input.params.id, input.body)),
  delivery: os.delivery.handler(({ input }) => readGatewayPostDelivery(input.id)),
  prepareDelivery: os.prepareDelivery.handler(({ input: { params, body: b } }) => {
    const project = activeProject();
    return withProject(project, async () => {
      const { item, gateway } = gatewayItem(params.id);
      if (gatewayRetirement(gateway.instanceId))
        await supervisor.prepareRetiredOutbox(gateway.instanceId, project.id, item.id, b);
      else await supervisor.prepareOutboxReview(gateway.instanceId, project.id, item.id);
      return readGatewayPostDelivery(params.id);
    });
  }),
  reviewDelivery: os.reviewDelivery.handler(({ input: { params, body: b } }) => {
    const project = activeProject();
    return withProject(project, async () => {
      const { item, gateway } = gatewayItem(params.id);
      await supervisor.reviewOutbox(gateway.instanceId, project.id, item.id, b);
      return readGatewayPostDelivery(params.id);
    });
  }),
  finishDelivery: os.finishDelivery.handler(({ input: { params, body: b } }) => {
    const project = activeProject();
    return withProject(project, async () => {
      const { item, gateway } = gatewayItem(params.id);
      if (gatewayRetirement(gateway.instanceId))
        await supervisor.finishRetiredOutbox(gateway.instanceId, project.id, item.id, b);
      else await supervisor.finishOutbox(gateway.instanceId, project.id, item.id, b);
      return social.listPosts().find((p) => p.id === params.id);
    });
  }),
  oldTest: os.oldTest.handler(() =>
    refuse(
      'Choose a gateway instance and known conversation in the Outbox, review the test text, then approve it. Old global tokens and webhooks are no longer used.',
    ),
  ),
});
