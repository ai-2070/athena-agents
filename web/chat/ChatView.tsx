// One agent's conversation, on the Vercel AI SDK (useChat): the saved chat as UI messages, a message
// you send streams in as its run goes (text as written, tool calls as they happen), and a run started
// anywhere else (a team turn, a routine, another tab) is picked up and streamed too (a resume: the
// turn so far, then the rest). The server speaks the AI SDK's UI message stream (server/uistream.ts).
// Used by the full chat page (views/chat.ts), the floating window's agent tabs (agentchat.ts, compact)
// and the Station's agent panel (mini).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { GET, POST, attempt, toast, state, onState, onEvent, approvalCard } from '../core.ts';
import { restoreDraft } from '../attach.ts';
import type { AttachTray } from '../attach.ts';
import { icon } from '../icons.ts';
import { latestCompaction, memoryStart } from '../../shared/compaction.ts';
import { Dom, MessageView, isRichCode } from './parts.tsx';
import type { Variant } from './parts.tsx';
import { beforeTurn, readUser, toUIMessages, userParts } from './messages.ts';
import type { ChatMessage } from './messages.ts';
import type { AppState, Chat, ChatItem } from '../../shared/types.ts';

export { isRichCode };

export interface ChatAgent {
  id: string;
  name: string;
  emoji?: string;
  specialty?: string;
  tools?: string[];
}

export interface ChatViewApi {
  /** Load the saved chat again (after a rename, Clear memory, a compaction…). */
  reload: (after?: boolean) => Promise<void>;
  /** Compact the chat now (the Compact button; /compact). */
  compact: (mode?: 'instant' | 'summary') => Promise<void>;
  focus: () => void;
  setDraft: (text: string) => void;
}

export interface ChatViewProps {
  agent: ChatAgent;
  /** The conversation; null: a new one, made when the first message is sent. */
  chatId: string | null;
  /** full: the chat page. compact: the floating window. mini: the Station panel. (compact: true = compact) */
  variant?: Variant;
  compact?: boolean;
  /** Files for the next message (the host owns it, so it can make the whole page a drop zone). */
  tray?: AttachTray | null;
  /** Shown under the composer (the model chip). */
  footer?: HTMLElement | null;
  /** The chat as it was (re)loaded, or made by the first message. */
  onChat?: (chat: Chat) => void;
  apiRef?: { current: ChatViewApi | null };
}

/** The page's shared state (agents, runs, approvals), kept current. */
function useAppState(): AppState | null {
  const [data, setData] = useState(state.data);
  useEffect(() => onState((d) => setData(d)), []);
  return data;
}

export const streamUrl = (agentId: string, chatId: string): string => `/api/agents/${agentId}/chats/${chatId}/stream`;

/** The AI SDK transport for one agent's chats: a send posts only the new message (the server keeps the
 *  history); a resume picks up the run going in the chat. */
export function chatTransport(agentId: string, chatId: () => string | null): DefaultChatTransport<ChatMessage> {
  return new DefaultChatTransport<ChatMessage>({
    api: '/api/agents',
    headers: { 'x-dash': '1' },
    prepareSendMessagesRequest: ({ messages }) => ({ api: streamUrl(agentId, chatId() || 'none'), body: readUser(messages[messages.length - 1]) }),
    prepareReconnectToStreamRequest: () => ({ api: streamUrl(agentId, chatId() || 'none') }),
  });
}

export function ChatView(p: ChatViewProps) {
  const { agent } = p;
  const variant: Variant = p.variant || (p.compact ? 'compact' : 'full');
  const compact = variant !== 'full';
  const tray = p.tray || null;
  const app = useAppState();
  const chatIdRef = useRef<string | null>(p.chatId);
  const [chatId, setChatId] = useState<string | null>(p.chatId);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [statusText, setStatusText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  const failed = useRef<string | null>(null);
  const onChat = useRef(p.onChat);
  onChat.current = p.onChat;
  // one id for this view's useChat, even when its first message makes the chat
  const [viewId] = useState(() => p.chatId || `new-${agent.id}-${Math.random().toString(36).slice(2, 8)}`);

  const transport = useMemo(() => chatTransport(agent.id, () => chatIdRef.current), [agent.id]);
  const { messages, setMessages, sendMessage, status, stop: stopStream, resumeStream } = useChat<ChatMessage>({
    id: viewId,
    transport,
    onData: (part) => {
      if (part.type === 'data-status') setStatusText((part.data as { text: string }).text);
    },
    onError: (e) => (failed.current = e.message || 'Could not send.'),
  });
  const streaming = status === 'submitted' || status === 'streaming';
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

  const serverRunning = !!chatId && !!app?.runs.some((r) => r.chatId === chatId);
  const busy = streaming || serverRunning;
  const approvals = (app?.approvals || []).filter((a) => a.agentId === agent.id);

  // the saved chat, shown as it is. after: a stream just ended (its flag may not have caught up yet)
  const reload = useCallback(async (after = false) => {
    const id = chatIdRef.current;
    if (!id) return;
    const saved = await GET<Chat>(`/agents/${agent.id}/chats/${id}`).catch(() => null);
    if (!saved || chatIdRef.current !== id) return;
    setItems(saved.items);
    // (while a stream is going it keeps its own message; the saved chat comes when it ends)
    if (after || !streamingRef.current) setMessages(toUIMessages(saved.items));
    onChat.current?.(saved);
  }, [agent.id, setMessages]);

  // pick up a run going in this chat: the messages before its turn, then the turn streamed in
  const following = useRef(false);
  const follow = useCallback(async () => {
    if (streamingRef.current || following.current || !chatIdRef.current) return;
    following.current = true;
    try {
      setMessages((m) => beforeTurn(m));
      setStatusText('Working…');
      await resumeStream();
    } finally {
      following.current = false;
      setStatusText('');
      await reload(true);
    }
  }, [resumeStream, reload, setMessages]);

  useEffect(() => {
    void (async () => {
      await reload();
      if (chatIdRef.current && state.data?.runs.some((r) => r.chatId === chatIdRef.current)) await follow();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a run starting here from elsewhere, compactions, and runs ending without a stream (missed ones)
  useEffect(
    () =>
      onEvent((ev) => {
        if (!chatIdRef.current || ev.chatId !== chatIdRef.current) return;
        if (ev.type === 'compacted') {
          if (!streamingRef.current) void reload();
          return;
        }
        if (ev.type !== 'run') return;
        const kind = (ev.event as { kind?: string })?.kind;
        if (kind === 'start' && !streamingRef.current && !sending.current) void reload().then(follow);
        else if ((kind === 'done' || kind === 'error') && !streamingRef.current && !sending.current) void reload();
      }),
    [reload, follow],
  );

  const compactNow = useCallback(
    async (mode?: 'instant' | 'summary') => {
      const id = chatIdRef.current;
      if (!id) return void toast('Nothing to compact yet');
      setStatusText(mode === 'summary' ? 'Compacting: the Brain’s model is writing a summary…' : 'Compacting…');
      const r = await attempt(
        () => POST<{ compacted: boolean; message?: string }>(`/agents/${agent.id}/chats/${id}/compact`, mode ? { mode } : {}),
        (x) => (x.compacted ? 'Compacted: the agent now remembers the older messages as a short history' : x.message || 'Nothing to compact yet'),
      );
      setStatusText('');
      if (r?.compacted) await reload();
    },
    [agent.id, reload],
  );

  const sending = useRef(false);
  const send = useCallback(
    async (typed?: string) => {
      const box = input.current;
      if (sending.current || busy) return;
      const draft = typed ?? box?.value.trim() ?? '';
      if (!draft && !tray?.count()) return;
      sending.current = true;
      let taken: ReturnType<AttachTray['take']> = [];
      try {
        if (tray?.busy()) setStatusText('Uploading files…');
        const attachments = typed != null || !tray ? [] : await tray.ready();
        setStatusText('');
        if (!attachments) return;
        // what is in the box now (more may have been typed while the files uploaded)
        const text = typed ?? box?.value.trim() ?? '';
        if (!text && !attachments.length) return;
        if (typed == null && box) {
          box.value = '';
          box.style.height = '';
        }
        // /compact, /compact instant, /compact summary (with no files attached)
        const cmd = attachments.length ? null : /^\/compact(?:\s+(instant|summary))?\s*$/i.exec(text);
        if (cmd) return void (await compactNow(cmd[1]?.toLowerCase() as 'instant' | 'summary' | undefined));
        // a new conversation: make the chat first
        if (!chatIdRef.current) {
          const made = await attempt(() => POST<Chat>(`/agents/${agent.id}/chats`));
          if (!made) {
            if (typed == null && box) restoreDraft(box, text);
            return;
          }
          chatIdRef.current = made.id;
          setChatId(made.id);
          onChat.current?.(made);
        }
        taken = tray?.take() || [];
        near.current = true;
        failed.current = null;
        setStatusText('Thinking…');
        await sendMessage({ role: 'user', parts: userParts(text, attachments), metadata: {} });
        if (failed.current) {
          toast(failed.current, 'error');
          if (typed == null && box) restoreDraft(box, text);
          tray?.put(taken);
        }
      } finally {
        sending.current = false;
        setStatusText('');
        await reload(true);
      }
    },
    [busy, tray, sendMessage, compactNow, reload, agent.id],
  );

  const stop = useCallback(() => {
    const id = chatIdRef.current;
    if (id) attempt(() => POST(`/agents/${agent.id}/chats/${id}/stop`));
    void stopStream();
  }, [agent.id, stopStream]);

  if (p.apiRef)
    p.apiRef.current = {
      reload,
      compact: compactNow,
      focus: () => input.current?.focus(),
      setDraft: (t) => {
        if (!input.current) return;
        input.current.value = t;
        input.current.focus();
      },
    };

  // keep to the newest message while you are at the bottom
  useLayoutEffect(() => {
    const el = list.current;
    if (el && near.current) el.scrollTop = el.scrollHeight;
  });
  // previews, videos and Rich answers arrive after the first draw: stay at the bottom as they grow
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const stick = () => {
      if (near.current) el.scrollTop = el.scrollHeight;
    };
    const watch = new MutationObserver(stick);
    watch.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    el.addEventListener('load', stick, true);
    el.addEventListener('loadedmetadata', stick, true);
    return () => {
      watch.disconnect();
      el.removeEventListener('load', stick, true);
      el.removeEventListener('loadedmetadata', stick, true);
    };
  }, []);
  const onScroll = () => {
    const el = list.current;
    if (el) near.current = el.scrollHeight - el.scrollTop - el.clientHeight < (compact ? 80 : 140);
  };

  const latest = latestCompaction(items);
  const dimBefore = latest ? memoryStart(items) : -1;
  const shown = variant === 'mini' ? messages.slice(-14) : variant === 'compact' ? messages.slice(-120) : messages;
  const lastId = messages[messages.length - 1]?.id;
  const chatPath = chatId ? `/agents/${agent.id}/chats/${chatId}` : undefined;
  const rows = shown.map((m) => {
    const seq = m.metadata?.seq;
    return (
      <MessageView
        key={m.id}
        m={m}
        variant={variant}
        busy={busy}
        streaming={streaming && m.id === lastId}
        dim={seq != null && seq < dimBefore}
        onSend={(t) => void send(t)}
        chatPath={chatPath}
        latestCompaction={latest?.item.id ?? null}
        onCompactionSaved={() => void reload()}
      />
    );
  });

  const empty = !messages.length && !busy;
  const statusLine = statusText || (busy ? (approvals.length ? `Waiting for you: ${approvals[0].title}` : 'Working…') : '');
  const composer = (
    <textarea
      ref={input}
      className={compact ? 'ac-input' : undefined}
      rows={variant === 'mini' ? 1 : 2}
      placeholder={compact ? `Message ${agent.name}…  (Enter to send, Shift+Enter for a new line)` : `Message ${agent.name}…`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void send();
        }
      }}
      onInput={(e) => {
        if (compact) return;
        const t = e.currentTarget;
        t.style.height = 'auto';
        t.style.height = `${Math.min(260, t.scrollHeight + 2)}px`;
      }}
    />
  );
  const sendBtn =
    busy && compact ? null : (
      <button className={compact ? 'btn small' : 'btn'} onClick={() => void send()} disabled={busy} title="Send (Enter)">
        {compact ? <Dom make={() => icon('send', 14)} deps={[]} /> : 'Send'}
      </button>
    );
  const stopBtn = busy ? (
    <button className={compact ? 'btn danger small' : 'btn danger'} onClick={stop}>
      {compact ? <Dom make={() => icon('square', 13)} deps={[]} /> : null}Stop
    </button>
  ) : null;

  return (
    <>
      <div ref={list} className={variant === 'mini' ? 'oc-mini-list' : compact ? 'ac-list' : 'messages'} onScroll={onScroll}>
        {empty ? (
          variant === 'mini' ? (
            <p className="empty">No messages yet.</p>
          ) : compact ? (
            <div className="ac-empty">
              <Dom make={() => icon('message-circle', 22)} deps={[]} />
              <p>Say hi to {agent.name}.</p>
              <p className="hint">{agent.specialty || ''}</p>
            </div>
          ) : (
            <div className="empty-chat" style={{ margin: 'auto', textAlign: 'center', maxWidth: '560px', color: 'var(--dim)' }}>
              <div style={{ fontSize: '40px' }}>{agent.emoji || '🤖'}</div>
              <p>
                Ask {agent.name} anything{agent.specialty ? `. Good at: ${agent.specialty}` : ''}.
              </p>
              <div className="chips" style={{ justifyContent: 'center', marginTop: '12px' }}>
                {suggestions(agent).map((t) => (
                  <button key={t} className="chip" onClick={() => p.apiRef?.current?.setDraft(t)}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          rows
        )}
      </div>
      {variant === 'mini' ? null : (
        <div className={compact ? 'ac-approvals' : undefined} style={compact ? undefined : { padding: '0 28px' }}>
          {approvals.map((a) => (
            <Dom key={a.id} className={compact ? undefined : 'oc-approval'} make={() => approvalCard(a)} deps={[a.id]} />
          ))}
        </div>
      )}
      <div className={compact ? 'ac-status' : 'status-line'}>
        {statusLine ? (
          compact ? (
            statusLine
          ) : (
            <>
              <span className="dot busy" />
              {statusLine}
            </>
          )
        ) : null}
      </div>
      {compact ? (
        <>
          {tray ? <Dom make={() => tray.el} deps={[tray]} /> : null}
          <div className="ac-compose">
            {tray ? <Dom make={() => tray.picker} deps={[tray]} /> : null}
            {composer}
            {sendBtn}
            {stopBtn}
          </div>
        </>
      ) : (
        <div className="composer">
          {tray ? <Dom make={() => tray.el} deps={[tray]} /> : null}
          <div className="composer-box">
            {tray ? <Dom make={() => tray.picker} deps={[tray]} /> : null}
            {composer}
            {stopBtn}
            {sendBtn}
          </div>
          <div className="row between" style={{ maxWidth: '1000px', marginTop: '6px' }}>
            {p.footer ? <Dom make={() => p.footer!} deps={[p.footer]} /> : <span />}
            <span className="hint">Enter to send · Shift+Enter for a new line</span>
          </div>
        </div>
      )}
    </>
  );
}

function suggestions(a: ChatAgent): string[] {
  const t = a.tools || [];
  const out: string[] = [];
  if (t.includes('comfyui_run')) out.push('Make an image of a neon city at night');
  if (t.includes('x_draft_post')) out.push('Draft 3 X posts about what I’m building');
  if (t.includes('blender_run_python')) out.push('Build a low-poly island in Blender and render it');
  if (t.includes('ffmpeg')) out.push('Cut the first 30 seconds of a video');
  if (t.includes('ask_agent')) out.push('Plan this with the team: launch week content');
  if (t.includes('list_programs')) out.push('What programs can you use on my PC?');
  if (!out.length) out.push('What can you do?', 'Summarize what you know');
  return out.slice(0, 4);
}
