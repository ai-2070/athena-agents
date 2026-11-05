// Chat with one agent: the agent and its chats on the left; the conversation itself is the AI SDK chat
// (web/chat): streaming answers, tool calls you can open, images, file previews, COMPACTED marks.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GET, POST, PUT, DEL, attempt, navigate, ago, confirmBox, promptBox, ENGINE_LABEL } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { openTerminal } from './agents.tsx';
import { openMemory } from '../memory.tsx';
import { iconButtonClass } from '../ui/classes.ts';
import { Dropdown, DropdownContent, DropdownItem, DropdownSeparator, DropdownTrigger } from '../ui/dropdown.tsx';
import { modelChip, modelInfo } from '../models.tsx';
import { kTokens } from '../../shared/context.ts';
import { attachTray } from '../attach.tsx';
import { Avatar, Icon, reactPage } from '../ui/react.tsx';
import { Button, ButtonLink } from '../ui/button.tsx';
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
  percent: number;
  /** the engine compacts this chat by itself (compactAt is then the whole window) */
  estimated: boolean;
}

type Loaded = { kind: 'gone' } | { kind: 'ready'; agent: AgentDetail; chat: Chat; chats: ChatSummary[] };

function ChatPage({ agentId, chatId, view }: { agentId: string; chatId?: string; view: PageContext }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const agent = await rpc.agents.get({ id: agentId }).catch(() => null);
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

  // a new chat only when there is something to start fresh from: an empty one is used again
  const newChat = async () => {
    const isEmpty = (id: string) => chats.find((c) => c.id === id)?.count === 0;
    if (isEmpty(chat.id)) return api.current?.focus();
    const empty = chats.find((c) => c.count === 0);
    if (empty) return navigate(`#/agents/${agent.id}/${empty.id}`);
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
  const how = memory ? `${memory.estimated ? 'Estimated context use. ' : ''}${ENGINE_LABEL[agent.engine] || 'The engine'} manages its own memory.` : '';
  const full = !!memory && memory.tokens >= memory.window * 0.85;
  // a search box once the list is long; the chats grouped by the day they were last used
  const [find, setFind] = useState('');
  const q = find.trim().toLowerCase();
  // empty chats aren't listed (the open one is, so you can see where you are)
  const listed = chats.filter((c) => c.count > 0 || c.id === chat.id);
  const shown = q ? listed.filter((c) => (c.title || 'Chat').toLowerCase().includes(q)) : listed;
  const groups: { day: string; list: ChatSummary[] }[] = [];
  for (const c of shown) {
    const day = dayOf(c.updatedAt);
    if (groups.at(-1)?.day === day) groups.at(-1)!.list.push(c);
    else groups.push({ day, list: [c] });
  }
  return (
    <div className="grid h-[calc(100vh-56px)] grid-rows-[minmax(0,1fr)] grid-cols-[280px_minmax(0,1fr)] max-md:h-auto max-md:min-h-[calc(100vh-57px)] max-md:grid-cols-1" ref={page}>
      <aside className="flex min-h-0 flex-col border-r border-line bg-bg max-md:border-r-0 max-md:border-b">
        <div className="border-b border-line px-4 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <Avatar agent={agent} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="truncate text-[15px] leading-[1.3] font-semibold text-ink" title={agent.name}>{agent.name}</div>
              {agent.specialty ? <p className="m-0 mt-0.5 line-clamp-2 text-[12.5px] leading-[1.45] text-dim">{agent.specialty}</p> : null}
            </div>
          </div>
          <div className="mt-3 flex min-w-0 items-center gap-1.5 text-[12px] text-dim" title={info.where}>
            <Icon name="cpu" size={13} className="flex-none text-faint" />
            <span className="truncate">{info.name}</span>
            <span className="truncate text-faint">{`· ${info.where.split(' · ')[0]}`}</span>
          </div>
          {/* New chat, then the agent's own things as a row of icon buttons */}
          <div className="mt-4 flex items-center gap-1.5">
            <Button size="small" className="flex-1 justify-center" onClick={() => void newChat()}>
              <Icon name="plus" size={14} />
              New chat
            </Button>
            <ButtonLink variant="ghost" size="small" className="size-8! px-0!" href={`#/agents/${agent.id}/edit`} title="Edit the agent" aria-label="Edit the agent">
              <Icon name="pencil" size={14} />
            </ButtonLink>
            {agent.engine !== 'eve' ? (
              <Button variant="ghost" size="small" className="size-8! px-0!" title="Open this agent in a live terminal" aria-label="Open in a terminal" onClick={() => void openTerminal(agent)}>
                <Icon name="terminal" size={14} />
              </Button>
            ) : null}
            <Button variant="ghost" size="small" className="size-8! px-0!" title="MEMORY.md: what it remembers across chats" aria-label="MEMORY.md" onClick={() => openMemory(agent.id, agent.name)}>
              <Icon name="file-text" size={14} />
            </Button>
          </div>
          {tools.length ? (
            <details className="group/tools mt-3">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-ctl py-1 text-[12px] text-dim hover:text-ink [&::-webkit-details-marker]:hidden">
                <Icon name="wrench" size={13} className="text-faint" />
                {`${tools.length} tool${tools.length === 1 ? '' : 's'}`}
                <Icon name="chevron-down" size={12} className="ml-auto text-faint transition-transform duration-200 group-open/tools:rotate-180" />
              </summary>
              <div className="chat-tools mt-2 flex max-h-40 flex-wrap gap-1 overflow-y-auto">
                {tools.map((t) => <code key={t} className="rounded-[6px] border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-dim">{t}</code>)}
              </div>
            </details>
          ) : null}
        </div>
        <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5 pt-3 pb-4 max-md:max-h-56 max-md:flex-none" aria-label="Chats">
          <div className="flex items-baseline justify-between px-2 pb-2 text-[12px] font-medium text-dim">
            <span>Chats</span>
            <span className="text-faint tabular-nums">{listed.length}</span>
          </div>
          {listed.length > 8 ? (
            <label className="relative mx-1 mb-2 block">
              <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint"><Icon name="search" size={13} /></span>
              <input className="h-8! py-0! pl-8! text-[12.5px]!" aria-label="Find a chat" placeholder="Find a chat" value={find} onChange={(e) => setFind(e.currentTarget.value)} />
            </label>
          ) : null}
          {groups.map((g) => (
            <div key={g.day} className="mb-2 flex flex-col gap-px">
              <div className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-faint">{g.day}</div>
              {g.list.map((c) => {
                const on = c.id === chat.id;
                const routine = /^Routine: /.test(c.title || '');
                return (
                  <a
                    key={c.id}
                    className={`group/chat flex items-center gap-2.5 rounded-ctl px-2 py-1.5 text-[13px] [transition:background-color_0.12s,color_0.12s] ${on ? 'on bg-ink/[0.06] text-ink' : 'text-dim hover:bg-ink/[0.04] hover:text-ink'}`}
                    aria-current={on ? 'page' : undefined}
                    href={`#/agents/${agent.id}/${c.id}`}
                    title={`${c.title || 'Chat'} · ${c.count} item${c.count === 1 ? '' : 's'}`}
                  >
                    <Icon name={routine ? 'repeat' : 'message-circle'} size={14} className={`flex-none ${on ? 'text-accent' : 'text-faint'}`} />
                    <span className={`t min-w-0 flex-1 truncate ${on ? 'font-medium' : ''}`}>{c.title || 'Chat'}</span>
                    <span className="flex-none text-[11px] text-faint tabular-nums">{ago(c.updatedAt)}</span>
                  </a>
                );
              })}
            </div>
          ))}
          {q && !shown.length ? <p className="m-0 px-2 py-3 text-[12.5px] text-faint">No chat matches.</p> : null}
        </nav>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-col [&_.composer]:border-0 [&_.composer]:bg-transparent">
        <div className="chat-head flex min-h-14 items-center gap-3 border-b border-line px-8 py-2.5 max-md:px-4">
          <button type="button" className="group/title flex min-w-0 flex-1 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left" title="Rename this chat" onClick={() => void rename()}>
            <span className="chat-title truncate text-[14px] font-semibold text-ink">{chat.title || 'Chat'}</span>
            <Icon name="pencil" size={13} className="flex-none text-faint opacity-0 transition-opacity group-hover/title:opacity-100 group-focus-visible/title:opacity-100" />
          </button>
          {memory ? (
            // how full the chat's memory is: a thin bar and a number, amber when nearly full
            <span
              className={`mem flex flex-none cursor-default items-center gap-2 text-[12px] tabular-nums ${full ? 'warn text-amber' : 'text-dim'}`}
              title={`About ${kTokens(memory.tokens)} of ${kTokens(memory.window)} tokens. ${how} (Settings > Context).`}
            >
              Memory
              <span className="relative h-1.5 w-14 overflow-hidden rounded-full bg-ink/[0.08] max-sm:hidden">
                <span aria-hidden="true" className={`absolute inset-y-0 left-0 rounded-full ${full ? 'bg-amber' : 'bg-accent'}`} style={{ width: `${Math.max(0, Math.min(100, memory.percent))}%` }} />
              </span>
              {`${memory.percent}%`}
            </span>
          ) : null}
          <Dropdown>
            <DropdownTrigger className={iconButtonClass('inset', 'flex-none')} aria-label="Chat options" title="Rename, clear memory or delete">
              <Icon name="ellipsis" size={16} />
            </DropdownTrigger>
            <DropdownContent align="end" className="min-w-48">
              <DropdownItem icon="pencil" onClick={() => void rename()}>Rename</DropdownItem>
              <DropdownItem icon="rotate-ccw" title="Keep the messages here but start the agent fresh" onClick={() => void resetMemory()}>Clear memory</DropdownItem>
              <DropdownSeparator />
              <DropdownItem icon="trash-2" danger onClick={() => void removeChat()}>Delete</DropdownItem>
            </DropdownContent>
          </Dropdown>
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

/** The heading a chat goes under in the list, by the day it was last used. */
export function dayOf(t: number, now = Date.now()): string {
  const start = (x: number) => new Date(x).setHours(0, 0, 0, 0);
  const days = Math.round((start(now) - start(t)) / 86_400_000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'This week' : days < 31 ? 'This month' : 'Older';
}

export const flush = true;
export const title = (): string => 'Chat';
export const { render, unmount } = reactPage((params, view) => <ChatPage agentId={params[0]} chatId={params[1]} view={view} />);
