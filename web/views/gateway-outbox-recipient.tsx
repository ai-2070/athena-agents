import type { GatewayOutboxPreview } from '../../shared/types.ts';

export function GatewayOutboxRecipient({ value }: { value: GatewayOutboxPreview['recipient'] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm min-w-0 [overflow-wrap:anywhere]">
      <dt className="text-dim">Instance</dt>
      <dd className="min-w-0">
        {value.instanceName} · {value.platform === 'discord' ? 'Discord' : 'Telegram'}
      </dd>
      <dt className="text-dim">Bot account</dt>
      <dd className="min-w-0">
        <code>{value.accountId}</code>
      </dd>
      <dt className="text-dim">Conversation</dt>
      <dd className="min-w-0">
        <code>{value.conversationId}</code>
        {value.threadId && (
          <>
            {' '}
            · thread <code>{value.threadId}</code>
          </>
        )}
      </dd>
      <dt className="text-dim">Reply to</dt>
      <dd className="min-w-0">
        {value.sender} · message <code>{value.sourceMessageId}</code>
      </dd>
    </dl>
  );
}
