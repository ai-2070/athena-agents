// How the chat views reach the dashboard with the Vercel AI SDK, for agent chats and the Brain: typed oRPC calls
// (rpc), whose events are the AI SDK's chunks (server/uistream.ts). No React here: the Brain chat (dock.tsx) reads
// brainStream() with the AI SDK's stream reader. A refusal (409 busy, 400…) fails with just the server's words, so
// the AI SDK's error reads "This chat is already working on something.".
import { eventIteratorToUnproxiedDataStream } from '@orpc/client';
import type { ChatTransport, UIMessageChunk } from 'ai';
import { readUser } from './messages.ts';
import type { ChatMessage } from './messages.ts';
import { rpcAt } from '../client/rpc.ts';
import type { UIStream } from '../../shared/types.ts';

/** The events as the AI SDK reads them: plain chunks (oRPC's carry its own markers, which the SDK can't copy). */
const chunks = (it: UIStream): ReadableStream<UIMessageChunk> => eventIteratorToUnproxiedDataStream(it);

/** One agent's chats: a send posts only the new message (the server keeps the history); a resume picks up the run
 *  going in the chat. accepted: the server took a request (it answered with a stream). at: '/p/<project>' for an
 *  agent of a project that isn't open (projectAt). */
export function chatTransport(
  agentId: string,
  chatId: () => string | null,
  accepted?: () => void,
  at = '',
): ChatTransport<ChatMessage> {
  const one = () => ({ id: agentId, chatId: chatId() || 'none' });
  return {
    async sendMessages({ messages, body, abortSignal }) {
      // (steer: sent while it works, it stops the run going now and goes next)
      const steer = !!body && 'steer' in body && body.steer === true;
      const it = await rpcAt(at).agents.chats.stream(
        { ...one(), ...readUser(messages[messages.length - 1]), ...(steer ? { steer: true } : {}) },
        { signal: abortSignal },
      );
      accepted?.();
      return chunks(it);
    },
    // (a view that closes, or a steer, stops the request too: it isn't left waiting)
    async reconnectToStream({ abortSignal }) {
      const it = await rpcAt(at).agents.chats.reconnect(one(), abortSignal ? { signal: abortSignal } : {});
      return it ? chunks(it) : null;
    },
  };
}

/** The Brain: one question, its answer streamed (server/uistream.ts streamBrain). at: another project's Brain. */
export async function brainStream(
  body: { text: string; project: string | null; attachments: string[]; goal?: boolean },
  { at = '', signal }: { at?: string; signal?: AbortSignal } = {},
): Promise<ReadableStream<UIMessageChunk>> {
  return chunks(await rpcAt(at).brain.stream(body, { signal }));
}
