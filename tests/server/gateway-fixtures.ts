import type { GatewayInbound } from '../../shared/types.ts';
import { listProjects } from '../../server/store.ts';

export function gatewayConfig(accountId = '999') {
  return {
    name: 'Test Telegram',
    platform: 'telegram',
    accountId,
    projectId: listProjects()[0].id,
    target: { kind: 'brain' },
    senderPolicy: { platform: 'telegram', allowedUserIds: ['123'] },
    scope: { directMessages: true, conversationIds: ['-100/7'], guildIds: [] },
    fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 },
    enabled: true,
  };
}

export function gatewayInput(sourceMessageId = '1', conversationId = '123'): GatewayInbound {
  return {
    platform: 'telegram',
    accountId: '999',
    conversationId,
    threadId: '',
    sourceEventId: sourceMessageId,
    sourceMessageId,
    kind: 'message',
    actor: { id: '123', label: 'Alice', kind: 'user' },
    directMessage: true,
    triggered: false,
    text: `Message ${sourceMessageId}`,
    media: [],
  };
}
