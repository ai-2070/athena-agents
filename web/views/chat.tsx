// Chat with one agent: the agent and its chats on the left; the conversation itself is the AI SDK chat
// (web/chat): streaming answers, tool calls you can open, images, file previews, COMPACTED marks.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GET, POST, PUT, DEL, attempt, navigate, ago, confirmBox, promptBox, ENGINE_LABEL } from '../core.ts';
import { openTerminal } from './agents.tsx';
import { memoryButton } from '../memory.tsx';
import { buttonClass } from '../ui/classes.ts';
import { modelChip, modelInfo } from '../models.tsx';
import { kTokens } from '../../shared/compaction.ts';
import { attachTray } from '../attach.tsx';
import { Avatar, DomNode, Icon, reactPage } from '../ui/react.tsx';
import { Button, ButtonLink } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import type { PageContext } from '../ui/react.tsx';
import type { AgentDetail } from './agents.tsx';
import type { ChatViewApi } from '../chat/ChatView.tsx';
import type { Chat, ChatSummary } from '../../shared/types.ts';

// The conversation (and the AI SDK) loads only when a chat opens.
const ChatView = lazy(() => import('../chat/ChatView.tsx').then((m) => ({ default: m.ChatView })));

/** GET /api/agents/:id/chats/:cid/memory */
interface MemoryInfo {
  tokens: number;
  window: number;
  compactAt: number;
  percent: number;
  auto: boolean;
  /** the engine compacts this chat by itself (compactAt is then the whole window) */
  own?: boolean;
}

type Loaded = { kind: 'gone' } | { kind: 'ready'; agent: AgentDetail; chat: Chat; chats: ChatSummary[] };

function ChatPage({ agentId, chatId, view }: { agentId: string; chatId?: string; view: PageContext }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const agent = await GET<AgentDetail>(`/agents/${agentId}`).catch(() => null);
      if (!live) return;
      if (!agent) return setLoaded({ kind: 'gone' });
      view.setTitle(`${agent.emoji || ''} ${agent.name}`);
      const chats = await GET<ChatSummary[]>(`/agents/${agentId}/chats`);
      if (!live) return;
      if (!chatId) {
        // no chat in the address: the latest one, or a new one
        const target = chats[0] || (await POST<Chat>(`/agents/${agentId}/chats`));
        if (live) location.replace(`#/agents/${agentId}/${target.id}`);
        return;
      }
      const chat = await GET<Chat>(`/agents/${agentId}/chats/${chatId}`).catch(() => null);
      if (!live) return;
      if (!chat) return void location.replace(`#/agents/${agentId}`);
      setLoaded({ kind: 'ready', agent, chat, chats });
    })();
    return () => void (live = false);
  }, [agentId, chatId, view]);
  if (!loaded) return null;
  if (loaded.kind === 'gone')
    return (
      <div className="p-10">
        <p>That agent no longer exists. </p>
        <a href="#/agents">Back to agents</a>
      </div>
    );
  return <ChatScreen agent={loaded.agent} first={loaded.chat} firstChats={loaded.chats} />;
}

function ChatScreen({ agent, first, firstChats }: { agent: AgentDetail; first: Chat; firstChats: ChatSummary[] }) {
  const [chat, setChat] = useState(first);
  const [chats, setChats] = useState(firstChats);
  const [memory, setMemory] = useState<MemoryInfo | null>(null);
  const api = useRef<ChatViewApi | null>(null);
  // files waiting to go with the next message: the whole page takes dropped files, and they go when you leave
  const tray = useMemo(() => attachTray(), []);
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = tray.dropZone(page.current!, `Drop files or folders for ${agent.name}`);
    // the message box gets focus as soon as it is on the page (the conversation loads lazily, and
    // ChatView hands over its api while drawing, before the box exists)
    let tries = 0;
    const focus = setInterval(() => {
      const ready = !!page.current?.querySelector('.chat-body textarea');
      if ((ready && api.current) || ++tries > 80) {
        clearInterval(focus);
        api.current?.focus();
      }
    }, 50);
    return () => {
      clearInterval(focus);
      off();
      tray.discard();
    };
  }, [tray, agent.name]);
  const footer = useMemo(() => modelChip(agent, { onChange: () => void api.current?.reload() }), [agent]);

  const loadMemory = useCallback(
    (c: Chat) =>
      GET<MemoryInfo>(`/agents/${agent.id}/chats/${c.id}/memory`)
        .then(setMemory)
        .catch(() => {}),
    [agent.id],
  );
  useEffect(() => void loadMemory(first), [loadMemory, first]);
  const onChat = useCallback(
    (c: Chat) => {
      setChat(c);
      void loadMemory(c);
      void GET<ChatSummary[]>(`/agents/${agent.id}/chats`).then(setChats).catch(() => {});
    },
    [agent.id, loadMemory],
  );

  const newChat = async () => {
    const c = await attempt(() => POST<Chat>(`/agents/${agent.id}/chats`));
    if (c) navigate(`#/agents/${agent.id}/${c.id}`);
  };
  const rename = async () => {
    const t = await promptBox('Rename chat', { value: chat.title });
    if (t && (await attempt(() => PUT(`/agents/${agent.id}/chats/${chat.id}`, { title: t })))) await api.current?.reload();
  };
  const resetMemory = async () => {
    if (!(await confirmBox("Clear this chat’s memory? The messages will stay, but the agent will start fresh.", { ok: "Clear memory", danger: true }))) return;
    if (await attempt(() => PUT(`/agents/${agent.id}/chats/${chat.id}`, { reset: true }), 'The agent will start fresh from your next message')) await api.current?.reload();
  };
  const removeChat = async () => {
    if (!(await confirmBox('Delete this chat?', { ok: 'Delete', danger: true }))) return;
    await attempt(() => DEL(`/agents/${agent.id}/chats/${chat.id}`));
    navigate(`#/agents/${agent.id}`);
  };

  const tools = agent.tools || [];
  const info = modelInfo(agent);
  const how = memory ? (memory.own ? `${ENGINE_LABEL[agent.engine] || 'Its engine'} compacts it by itself when it is nearly full` : memory.auto ? `Compacts by itself at ${kTokens(memory.compactAt)}` : 'Automatic compaction is off') : '';
  return (
    <div className="grid h-[calc(100vh-56px)] grid-rows-[minmax(0,1fr)] grid-cols-[260px_minmax(0,1fr)] max-md:h-auto max-md:min-h-[calc(100vh-57px)] max-md:grid-cols-1" ref={page}>
      <aside className="flex min-h-0 flex-col border-r border-line bg-bg max-md:border-r-0 max-md:border-b">
        <div className="border-b border-line px-5 pt-6 pb-5">
          <div className="flex items-center gap-3">
            <Avatar agent={agent} lg />
            <div className="min-w-0 flex-1 text-[15px] leading-[1.3] font-semibold wrap-anywhere">{agent.name}</div>
          </div>
          {agent.specialty ? <p className="hint mt-3 mb-0">{agent.specialty}</p> : null}
          <div className="mt-4 flex flex-col gap-1 text-[12px] leading-[1.4] text-dim">
            <span>{info.name}</span>
            <span className="text-faint">{info.where}</span>
          </div>
          <div className="mt-5 flex flex-col gap-2">
            <Button size="small" className="w-full justify-center" onClick={() => void newChat()}>+ New chat</Button>
            <div className="grid grid-cols-2 gap-2">
              <ButtonLink variant="ghost" size="tiny" className={`justify-center ${agent.engine === 'openai' ? 'col-span-2' : ''}`} href={`#/agents/${agent.id}/edit`}>Edit</ButtonLink>
              {agent.engine !== 'openai' ? (
                <Button variant="ghost" size="tiny" className="justify-center" title="Open this agent in a live terminal" onClick={() => void openTerminal(agent)}><Icon name="terminal" size={13} />Terminal</Button>
              ) : null}
              <DomNode as="span" className="col-span-2" make={() => memoryButton(agent.id, agent.name, { size: 'tiny', class: 'w-full justify-center' })} deps={[agent.id]} />
            </div>
          </div>
          <details className="mt-4">
            <summary className="label cursor-pointer text-dim">{`${tools.length} tools`}</summary>
            <div className="hint chat-tools mt-2 font-mono text-[11.5px] leading-[1.8]">{tools.join(' · ')}</div>
          </details>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 py-4 max-md:max-h-48 max-md:flex-none" aria-label="Chats">
          <div className="label px-2 pb-2 text-faint">Chats</div>
          {chats.map((c) => (
            <a key={c.id} className={c.id === chat.id ? 'on block rounded-[10px] bg-panel px-3 py-3 text-[13px] text-ink shadow-[inset_0_1px_0_var(--glass-spec)]' : 'block rounded-[10px] px-3 py-3 text-[13px] text-dim hover:bg-panel hover:text-ink'} aria-current={c.id === chat.id ? 'page' : undefined} href={`#/agents/${agent.id}/${c.id}`}>
              <span className="t block truncate font-medium">{c.title || 'Chat'}</span>
              <span className="mt-1 block text-[11.5px] leading-[normal] text-faint">{`${ago(c.updatedAt)} · ${c.count} items`}</span>
            </a>
          ))}
        </nav>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-col [&_.composer]:border-0 [&_.composer]:bg-transparent">
        <div className="chat-head flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-line px-8 py-3 max-md:px-4">
          <div className="min-w-0 flex-1">
            <span className="chat-title text-[14px] font-semibold text-ink">{chat.title || 'Chat'}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {memory ? (
              <Pill
                tone={memory.tokens >= memory.compactAt * 0.8 ? 'warn' : 'dim'}
                className="mem relative cursor-default overflow-hidden tabular-nums"
                title={`About ${kTokens(memory.tokens)} of ${kTokens(memory.window)} tokens. ${how} (Settings > Chat memory).`}
              >
                <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--color-accent)_26%,transparent),color-mix(in_srgb,var(--color-accent)_9%,transparent))]" style={{ width: `${Math.max(0, Math.min(100, memory.percent))}%` }} />
                <span className="relative">{`Memory ${memory.percent}%`}</span>
              </Pill>
            ) : null}
            <Button size="tiny" variant="ghost" title="Compact the agent’s memory of this chat now: older messages become a short history, the latest stay in full (or type /compact)" onClick={() => void api.current?.compact()}>Compact</Button>
            <Button size="tiny" variant="ghost" onClick={() => void rename()}>Rename</Button>
            <Button size="tiny" variant="ghost" title="Keep the messages here but start the agent fresh" onClick={() => void resetMemory()}>Clear memory</Button>
            <Button size="tiny" variant="danger" onClick={() => void removeChat()}>Delete</Button>
          </div>
        </div>
        {/* the reading column: the messages and the composer below them sit here, centred on the page */}
        <div className="chat-body mx-auto flex min-h-0 w-full max-w-[760px] flex-1 flex-col">
          <Suspense fallback={null}>
            <ChatView agent={{ id: agent.id, name: agent.name, emoji: agent.emoji, specialty: agent.specialty, tools: agent.tools }} chatId={chat.id} tray={tray} footer={footer} onChat={onChat} apiRef={api} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

export const flush = true;
export const title = (): string => 'Chat';
export const { render, unmount } = reactPage((params, view) => <ChatPage agentId={params[0]} chatId={params[1]} view={view} />);
