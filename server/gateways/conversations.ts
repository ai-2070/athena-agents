import type { GatewayInboxEvent, GatewayLocalConversation, GatewayRunInput } from '../../shared/types.ts';
import { gatewayAlbumKey } from '../../shared/gateways.ts';
import { checkConversationId, privateAgentChat, privateTeamId } from '../private-conversations.ts';
import { getGatewayInstance, withGatewayRoute } from './instances.ts';
import { gatewayInputAllowed } from './inbox.ts';
import { verifyGatewayFile } from './files.ts';

/** Resolve only claimed, authorized input before model admission. */
export async function gatewayConversation(event: GatewayInboxEvent, signal: AbortSignal, sources = [event]): Promise<GatewayLocalConversation> {
  signal.throwIfAborted();
  checkConversationId(event.bindingId);
  if (event.workKept || event.status !== 'running' || !event.operationId) throw new Error('Claim this gateway message before dispatching it.');
  const allowed = () => sources.every((source) => gatewayInputAllowed(getGatewayInstance(event.route.instanceId), source.input));
  if (!allowed()) throw new Error('This gateway sender or conversation is no longer allowed.');
  gatewayRunInput(event, sources);
  for (const source of sources) {
    if (source.input.media.length !== (source.files?.length ?? 0)) throw new Error('This gateway message has missing files.');
    for (const file of source.files ?? []) if (!await verifyGatewayFile(source, file, signal)) throw new Error('A gateway file changed or is missing.');
  }
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

/** Keep source IDs beside their captions; attachments stay in their original verified batches. */
export function gatewayRunInput(event: GatewayInboxEvent, sources: GatewayInboxEvent[]): GatewayRunInput {
  if (event.input.kind !== 'message') throw new Error('Review this gateway message before dispatching it.');
  if (event.input.mediaGroupId) {
    const ids = event.album?.memberIds;
    if (event.album?.leaderId !== event.id || !ids || ids.length < 2 || ids.length > 10 || new Set(ids).size !== ids.length
      || sources.length !== ids.length || sources.some((source, index) => source.id !== ids[index] || source.album?.leaderId !== event.id
        || source.input.kind !== 'message' || source.bindingId !== event.bindingId || JSON.stringify(source.route) !== JSON.stringify(event.route)
        || source.input.actor.id !== event.input.actor.id || gatewayAlbumKey(source.input) !== gatewayAlbumKey(event.input))) throw new Error('Group the complete album before starting work.');
  } else if (sources.length !== 1 || sources[0].id !== event.id) throw new Error('The gateway source changed.');
  return {
    text: event.input.mediaGroupId ? `Telegram album (${sources.length} source messages)\n\n${sources.map((source) => `Message ${source.input.sourceMessageId}\n${source.input.text || '(No caption)'}`).join('\n\n')}` : event.input.text,
    attachments: sources.flatMap((source) => (source.files ?? []).map((file) => {
      if (file.status !== 'saved' || !file.file) throw new Error('This gateway message has missing files.');
      return file.file.path;
    })),
  };
}
