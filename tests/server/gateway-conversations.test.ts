import { afterEach, describe, expect, it } from 'vitest';
import { chats } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { workflows } from '../../server/store.ts';
import { saveGatewayInstance } from '../../server/gateways/instances.ts';
import { GatewayStateAdapter } from '../../server/gateways/state.ts';
import { GatewayInbox } from '../../server/gateways/inbox.ts';
import { gatewayConversation } from '../../server/gateways/conversations.ts';
import { privateTeamRecord } from '../../server/private-conversations.ts';
import { gatewayConfig, gatewayInput } from './gateway-fixtures.ts';
import type { GatewayTarget } from '../../shared/types.ts';

let account = 50000;
const opened: GatewayStateAdapter[] = [];
afterEach(async () => {
  for (const state of opened.splice(0)) await state.disconnect();
});
async function fixture(target: GatewayTarget) {
  const config = { ...gatewayConfig(String(account++)), target };
  const instance = saveGatewayInstance(config);
  const state = new GatewayStateAdapter(instance.id);
  opened.push(state);
  await state.connect();
  const inbox = new GatewayInbox(state);
  inbox.accept({ ...gatewayInput(), accountId: instance.accountId });
  return { instance, inbox, config, event: inbox.claimNext()! };
}

describe('gateway local conversation resolution', () => {
  it('resolves the configured Brain, team or agent with stable binding-specific identities', async () => {
    const agent = newAgent({ name: 'Gateway target' });
    const team = workflows.save({ name: 'Gateway crew', members: [agent.id], lead: agent.id, steps: [] });
    const brain = await fixture({ kind: 'brain' });
    expect(await gatewayConversation(brain.event, new AbortController().signal)).toMatchObject({
      kind: 'brain',
      conversationId: brain.event.bindingId,
      sender: 'telegram: Alice (123)',
    });
    const solo = await fixture({ kind: 'agent', id: agent.id });
    const local = await gatewayConversation(solo.event, new AbortController().signal);
    expect(local.kind).toBe('agent');
    if (local.kind !== 'agent') throw new Error('Wrong target');
    expect(chats.get(agent.id, local.chatId)).toMatchObject({
      conversationId: solo.event.bindingId,
      items: [],
      sessionId: null,
    });
    expect(await gatewayConversation(solo.event, new AbortController().signal)).toEqual(local);
    const another = await fixture({ kind: 'agent', id: agent.id });
    expect(await gatewayConversation(another.event, new AbortController().signal)).not.toEqual(local);
    const group = await fixture({ kind: 'team', id: team.id });
    const groupLocal = await gatewayConversation(group.event, new AbortController().signal);
    if (groupLocal.kind !== 'team') throw new Error('Wrong target');
    expect(privateTeamRecord(groupLocal.teamId)).toMatchObject({
      conversationId: group.event.bindingId,
      target: { kind: 'team', id: team.id },
    });
  });

  it('refuses unclaimed input, stale routes, revoked senders and unfinished attachments before creating a session', async () => {
    const agent = newAgent({ name: 'Guarded gateway target' });
    const f = await fixture({ kind: 'agent', id: agent.id });
    const signal = new AbortController().signal;
    await expect(gatewayConversation({ ...f.event, status: 'queued' }, signal)).rejects.toThrow('Claim');
    await expect(
      gatewayConversation(
        { ...f.event, input: { ...f.event.input, media: [{ kind: 'file', fileId: 'missing' }] } },
        signal,
      ),
    ).rejects.toThrow('missing files');
    expect(chats.list(agent.id)).toHaveLength(0);
    saveGatewayInstance({ ...f.config, target: { kind: 'brain' } }, f.instance.id);
    await expect(gatewayConversation(f.event, signal)).rejects.toThrow('destination changed');
    saveGatewayInstance(
      { ...f.config, senderPolicy: { platform: 'telegram', allowedUserIds: ['777'] } },
      f.instance.id,
    );
    await expect(gatewayConversation(f.event, signal)).rejects.toThrow('no longer allowed');
    expect(chats.list(agent.id)).toHaveLength(0);
  });
});
