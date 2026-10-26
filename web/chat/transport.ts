// How the chat views reach the dashboard with the Vercel AI SDK (its HTTP transport), for agent chats
// and the Brain. No React here: the Brain chat (dock.ts) uses it with the AI SDK's stream reader.
import { DefaultChatTransport } from 'ai';
import type { UIMessage } from 'ai';
import { readUser } from './messages.ts';
import type { ChatMessage } from './messages.ts';

/** fetch, but a refusal (409 busy, 400…) carries just the server's message, so the AI SDK's error reads
 *  "This chat is already working on something." rather than the JSON it came in. */
export const dashFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (res.ok) return res;
  const body = await res.text();
  let message = body;
  try {
    const j = JSON.parse(body) as { error?: unknown };
    if (typeof j.error === 'string' && j.error) message = j.error;
  } catch {
    /* not JSON */
  }
  return new Response(message || `${res.status} ${res.statusText}`, { status: res.status, statusText: res.statusText });
};

export const streamUrl = (agentId: string, chatId: string): string => `/api/agents/${agentId}/chats/${chatId}/stream`;

/** One agent's chats: a send posts only the new message (the server keeps the history); a resume
 *  picks up the run going in the chat. */
export function chatTransport(agentId: string, chatId: () => string | null): DefaultChatTransport<ChatMessage> {
  return new DefaultChatTransport<ChatMessage>({
    api: '/api/agents',
    headers: { 'x-dash': '1' },
    fetch: dashFetch,
    prepareSendMessagesRequest: ({ messages }) => ({ api: streamUrl(agentId, chatId() || 'none'), body: readUser(messages[messages.length - 1]) }),
    prepareReconnectToStreamRequest: () => ({ api: streamUrl(agentId, chatId() || 'none') }),
  });
}

/** The Brain: one question, its answer streamed (server/uistream.ts streamBrain). */
export function brainTransport(body: { text: string; project: string | null; attachments: string[]; goal?: boolean }): DefaultChatTransport<UIMessage> {
  return new DefaultChatTransport<UIMessage>({ api: '/api/brain/stream', headers: { 'x-dash': '1' }, fetch: dashFetch, prepareSendMessagesRequest: () => ({ body }) });
}
