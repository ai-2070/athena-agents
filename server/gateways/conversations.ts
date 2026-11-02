import type { GatewayInboxEvent, GatewayLocalConversation } from '../../shared/types.ts';
import { checkConversationId, privateAgentChat, privateTeamId } from '../private-conversations.ts';
import { getGatewayInstance, withGatewayRoute } from './instances.ts';
import { gatewayInputAllowed } from './inbox.ts';
import { verifyGatewayFile } from './files.ts';

/** Resolve only claimed, authorized input. No worker invokes a model through this helper yet. */
export async function gatewayConversation(event: GatewayInboxEvent, signal: AbortSignal): Promise<GatewayLocalConversation> {
  signal.throwIfAborted();
  checkConversationId(event.bindingId);
  if (event.status !== 'running' || !event.operationId) throw new Error('Claim this gateway message before dispatching it.');
  const allowed = () => gatewayInputAllowed(getGatewayInstance(event.route.instanceId), event.input);
  if (!allowed()) throw new Error('This gateway sender or conversation is no longer allowed.');
  if (event.input.mediaGroupId || event.input.kind !== 'message') throw new Error('Review this gateway message before dispatching it.');
  if (event.input.media.length !== (event.files?.length ?? 0)) throw new Error('This gateway message has missing files.');
  for (const file of event.files ?? []) if (!await verifyGatewayFile(event, file, signal)) throw new Error('A gateway file changed or is missing.');
  signal.throwIfAborted();
  if (!allowed()) throw new Error('This gateway sender or conversation is no longer allowed.');
  return withGatewayRoute(event.route, () => {
    const common = { conversationId: event.bindingId, projectId: event.route.projectId, sender: `${event.input.platform}: ${event.input.actor.label} (${event.input.actor.id})` };
    const target = event.route.target;
    if (target.kind === 'brain') return { ...common, kind: 'brain' };
    if (target.kind === 'agent') return { ...common, kind: 'agent', agentId: target.id, chatId: privateAgentChat(event.bindingId, target.id).id };
    return { ...common, kind: 'team', teamId: privateTeamId(event.bindingId, target.id) };
  });
}
