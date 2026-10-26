// Puts an agent chat (ChatView, on the Vercel AI SDK) into a plain-DOM page. Loaded with import() when a chat
// opens, so React and the AI SDK are only fetched then.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatView } from './ChatView.tsx';
import type { ChatViewApi, ChatViewProps } from './ChatView.tsx';

export type { ChatAgent, ChatViewApi, ChatViewProps } from './ChatView.tsx';

export interface MountedChat {
  /** Reload, compact, focus, set the draft (once it has drawn). */
  api: { current: ChatViewApi | null };
  destroy: () => void;
}

export function mountChat(el: HTMLElement, props: Omit<ChatViewProps, 'apiRef'>): MountedChat {
  const api: MountedChat['api'] = { current: null };
  const root = createRoot(el);
  root.render(
    <StrictMode>
      <ChatView {...props} apiRef={api} />
    </StrictMode>,
  );
  return { api, destroy: () => root.unmount() };
}
