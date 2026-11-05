// One agent's chat, for the floating chat window: its latest conversation as the AI SDK chat (web/chat,
// the small version): streaming replies, tools it uses (with images), file previews, approvals it waits
// on, and a composer with Stop. The bar above picks the model, starts a new chat, opens its MEMORY.md or the full page.
// React; renderAgentChat() puts it into the window's tab (plain DOM) and hands back focus and destroy.
import { StrictMode, Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { createAppRoot } from './ui/root.tsx';
import { GET, POST, attempt } from './core.ts';
import { projectAt } from './client/connection.ts';
import { modelChip } from './models.tsx';
import { attachTray } from './attach.tsx';
import { memoryButton } from './memory.tsx';
import { buttonClass } from './ui/classes.ts';
import { DomNode, Icon, useAppState } from './ui/react.tsx';
import { useProjectAgents } from './projectagents.ts';
import { Button, ButtonLink } from './ui/button.tsx';
import type { ChatViewApi } from './chat/ChatView.tsx';
import type { Chat, ChatSummary } from '../shared/types.ts';

// The conversation (and the AI SDK) loads only when a chat opens.
const ChatView = lazy(() => import('./chat/ChatView.tsx').then((m) => ({ default: m.ChatView })));

/** What renderAgentChat() hands back. */
export interface AgentChatApi {
  focus: () => void;
  destroy: () => void;
}

// A session the agent keeps for a team chat (marked by teamId; chats made before that only have the title).
export const isTeamSession = (c: ChatSummary): boolean => !!c.teamId || /^Team: /.test(c.title || '');

/** Focus asked for from outside (the window, when the tab opens), given once the message box is there. */
interface FocusAsk {
  wanted: boolean;
  api: { current: ChatViewApi | null };
}

function AgentChatPane({ agentId, ask, projectId }: { agentId: string; ask: FocusAsk; projectId?: string }) {
  const d = useAppState();
  // (a chat of a project that isn't open: its agents are fetched from that project)
  const theirs = useProjectAgents(projectId);
  const at = projectAt(projectId);
  const agent = projectId ? theirs.find((a) => a.id === agentId) : d?.agents.find((a) => a.id === agentId);
  // the chat picked (when the tab opens, or New chat): undefined while looking for its latest one,
  // null for a new one, made by the first message. n tells picks apart, so New chat starts afresh.
  const [pick, setPick] = useState<{ id: string | null; n: number } | undefined>(undefined);
  // the chat shown, for the Full page link (a first message makes one without starting the view again)
  const [chatId, setChatId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const tray = useMemo(() => attachTray({ project: projectId }), [projectId]);
  // New chat was clicked: a slow first look for the latest chat must not take the tab back to it
  const chosen = useRef(false);
  useEffect(() => {
    let live = true;
    chosen.current = false;
    // its own conversations, not the sessions it keeps for each team chat
    void GET<ChatSummary[]>(`${at}/agents/${agentId}/chats`)
      .catch((): ChatSummary[] => [])
      .then((chats) => {
        if (!live || chosen.current) return;
        const id = chats.find((c) => !isTeamSession(c))?.id || null;
        setPick({ id, n: 0 });
        setChatId(id);
      });
    return () => void (live = false);
  }, [agentId, at]);
  useEffect(() => {
    const off = tray.dropZone(root.current!, `Drop files or folders for ${agent?.name || 'the agent'}`);
    return () => {
      off();
      // the tab closed: unsent attachments go too
      tray.discard();
    };
    // (the drop zone's text is set once; the agent's name hardly changes while the tab is open)
  }, [tray]);
  // focus asked for before the box existed: given as soon as it does. It looks only until the box is
  // there (once it is, renderAgentChat's focus() gives it straight away), and again after New chat.
  useEffect(() => {
    if (!pick) return;
    const t = setInterval(() => {
      if (!ask.api.current || !root.current?.querySelector('textarea')) return;
      clearInterval(t);
      if (ask.wanted) {
        ask.wanted = false;
        ask.api.current.focus();
      }
    }, 50);
    return () => clearInterval(t);
  }, [pick, ask]);

  const fresh = async () => {
    const c = await attempt(() => POST<Chat>(`${at}/agents/${agentId}/chats`));
    if (c) {
      chosen.current = true;
      setPick((p) => ({ id: c.id, n: (p?.n || 0) + 1 }));
      setChatId(c.id);
    }
  };
  const chip = useMemo(() => agent ? modelChip(agent, { compact: true, at }) : null, [agent?.id, agent?.model, agent?.engine, agent?.provider, at]);
  return (
    <div className="flex flex-col gap-3 h-full" ref={root}>
      <div className="flex items-center gap-2 pt-1">
        <span className="flex-1 min-w-0" />
        <Button size="tiny" variant="ghost" title="Start a fresh conversation" onClick={() => void fresh()}>
          <Icon name="plus" size={13} />
          New chat
        </Button>
        <DomNode as="span" make={() => memoryButton(agentId, agent?.name, { size: 'tiny', projectId })} deps={[agentId, agent?.name, projectId]} />
        {projectId ? null : (
          <ButtonLink size="tiny" variant="ghost" title="Open the full chat page" href={chatId ? `#/agents/${agentId}/${chatId}` : `#/agents/${agentId}`}>
            <Icon name="maximize-2" size={13} />
            Full page
          </ButtonLink>
        )}
      </div>
      <div className="contents">
        {agent && pick ? (
          <Suspense fallback={null}>
            <ChatView
              key={pick.n}
              agent={{ id: agent.id, name: agent.name, emoji: agent.emoji, specialty: agent.specialty }}
              chatId={pick.id}
              compact
              tray={tray}
              footer={chip}
              onChat={(c: Chat) => setChatId(c.id)}
              apiRef={ask.api}
              {...(projectId ? { agents: theirs, projectId } : {})}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
}

/** Draws the agent's chat into a tab of the floating window. */
/** projectId: the agent's project, when it isn't the open one (an Overview pane): its requests go there (projectAt). */
export function renderAgentChat(container: HTMLElement, agentId: string, { projectId }: { projectId?: string } = {}): AgentChatApi {
  const ask: FocusAsk = { wanted: false, api: { current: null } };
  const root = createAppRoot(container);
  root.render(
    <StrictMode>
      <AgentChatPane agentId={agentId} ask={ask} projectId={projectId} />
    </StrictMode>,
  );
  return {
    focus: () => {
      const box = container.querySelector('textarea');
      if (ask.api.current && box) ask.api.current.focus();
      else ask.wanted = true;
    },
    destroy: () => root.unmount(),
  };
}
