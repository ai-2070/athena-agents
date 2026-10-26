// One agent's conversation, on OpenUI: its chat state (react-headless) holds the messages and streams
// our runs; the list and the composer are ours, in the dashboard's look. Used by the full chat page
// (views/chat.ts) and the floating chat window's agent tabs (agentchat.ts, compact).
//   - our sends go through OpenUI (processMessage → llm.ts → the server), streaming as they come
//   - runs this view didn't start (team turns, routines, handoffs, another tab) are shown live from
//     the server's events (live.ts), and the saved chat is loaded again when any run ends
//   - our own rows: COMPACTED marks, errors and notes; file previews with Show in Explorer / Finder;
//     answers in OpenUI Lang (Rich answers) as live components
import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChatProvider, useThread, useThreadList, useToolActivities } from '@openuidev/react-headless';
import type { ActivityMessage, AssistantMessage, ChatStorage, Message, ToolActivity, UserMessage } from '@openuidev/react-headless';
import { GET, POST, attempt, toast, state, onState, onEvent, md, approvalCard, lightbox } from '../core.ts';
import { restoreDraft } from '../attach.ts';
import type { AttachTray } from '../attach.ts';
import { compactionMark } from '../compactmark.ts';
import { filePreviews } from '../filepreview.ts';
import { findFileMentions } from '../mentions.ts';
import { icon } from '../icons.ts';
import { latestCompaction, memoryStart } from '../../shared/compaction.ts';
import { dashboardLLM } from './llm.ts';
import { applyRunEvent } from './live.ts';
import { readToolContent, readUserContent, seqOf, toMessages, userContent } from './convert.ts';
import type { AppState, Chat, ChatItem, CompactionItem, RunEvent } from '../../shared/types.ts';

const RichAnswer = lazy(() => import('./rich.tsx'));

export interface ChatAgent {
  id: string;
  name: string;
  emoji?: string;
  specialty?: string;
  tools?: string[];
}

export interface ChatViewApi {
  /** Load the saved chat again (after a rename, Clear memory, a compaction…). */
  reload: () => Promise<void>;
  /** Compact the chat now (the Compact button; /compact). */
  compact: (mode?: 'instant' | 'summary') => Promise<void>;
  focus: () => void;
  setDraft: (text: string) => void;
}

export interface ChatViewProps {
  agent: ChatAgent;
  /** The conversation; null: a new one, made when the first message is sent. */
  chatId: string | null;
  /** The floating window's small version. */
  compact?: boolean;
  /** Files for the next message (the host owns it, so it can make the whole page a drop zone). */
  tray: AttachTray;
  /** Shown under the composer (the model chip). */
  footer?: HTMLElement | null;
  /** The chat as it was (re)loaded, or made by the first message. */
  onChat?: (chat: Chat) => void;
  apiRef?: { current: ChatViewApi | null };
}

// ---------- helpers ----------
/** The page's shared state (agents, runs, approvals), kept current. */
function useAppState(): AppState | null {
  const [data, setData] = useState(state.data);
  useEffect(() => onState((d) => setData(d)), []);
  return data;
}

/** A piece of the page built with plain DOM (approval cards, the COMPACTED mark, file previews…). */
const Dom = memo(function Dom({ make, deps, className }: { make: () => Node | null; deps: readonly unknown[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = make();
    ref.current?.replaceChildren(...(node ? [node] : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return <div ref={ref} className={className} style={className ? undefined : { display: 'contents' }} />;
}, (a, b) => a.className === b.className && a.deps.length === b.deps.length && a.deps.every((d, i) => Object.is(d, b.deps[i])));

const Markdown = memo(function Markdown({ text, className }: { text: string; className: string }) {
  // (md() is marked + DOMPurify, as everywhere in the dashboard)
  const html = useMemo(() => md(text).innerHTML, [text]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});

function Previews({ paths, compact }: { paths: readonly string[]; compact?: boolean }) {
  const key = paths.join('\n');
  if (!paths.length) return null;
  return <Dom make={() => filePreviews(paths, { compact })} deps={[key, compact]} />;
}

/** OpenUI Lang (a Rich answer) rather than markdown: "root = Card(…)" and other statements. */
export const isRichCode = (text: string): boolean => /^\s*root\s*=\s*[A-Z]\w*\(/m.test(text) && !/^\s*```/.test(text);

const brief = (input: unknown): string =>
  input && typeof input === 'object' ? Object.values(input as Record<string, unknown>).filter((v) => typeof v === 'string').join(' · ').slice(0, 140) : typeof input === 'string' ? input.slice(0, 140) : '';

// ---------- rows ----------
function ToolCard({ t, compact, busy }: { t: ToolActivity; compact?: boolean; busy: boolean }) {
  const done = t.status === 'complete' || t.status === 'error';
  const result = done ? readToolContent(t.result) : null;
  const images = result?.images || [];
  const running = !done && busy;
  const mark = running ? <span className="dot busy" /> : t.isError ? <span className="red">✕</span> : done ? <span className="accent">✓</span> : <span className="faint">·</span>;
  if (compact)
    return (
      <div className={`ac-tool${t.isError ? ' err' : running ? ' run' : ''}`}>
        {mark}
        <span>{t.toolName}</span>
        {images.length ? (
          <div className="st-imgs">
            {images.slice(0, 6).map((src) => (
              <img key={src} src={src} onClick={() => lightbox(src)} />
            ))}
          </div>
        ) : null}
      </div>
    );
  const input = t.toolCall.function.arguments;
  let pretty = input;
  try {
    pretty = JSON.stringify(JSON.parse(input || '{}'), null, 2);
  } catch {
    /* as sent */
  }
  return (
    <div className="col" style={{ gap: '6px' }}>
      <details className={`tool${t.isError ? ' error' : ''}`}>
        <summary>
          {mark}
          <span className="tname">{t.toolName}</span>
          <span className="targ">{brief(t.input)}</span>
        </summary>
        <div className="tbody">
          <div className="label">Input</div>
          <pre>{pretty}</pre>
          {result ? (
            <>
              <div className="label">Result</div>
              <pre>{result.text || '(empty)'}</pre>
            </>
          ) : (
            <div className="hint">{running ? 'Running…' : 'Did not finish.'}</div>
          )}
        </div>
      </details>
      {images.length ? (
        <div className="tool-images">
          {images.map((src) => (
            <img key={src} src={src} onClick={() => lightbox(src)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AssistantTurn({ m, all, compact, busy, streaming, dim, onSend }: { m: AssistantMessage; all: Message[]; compact?: boolean; busy: boolean; streaming: boolean; dim: boolean; onSend: (t: string) => void }) {
  const tools = useToolActivities(m, all);
  const text = m.content || '';
  const rich = !!text && isRichCode(text);
  const mentions = useMemo(() => (rich ? [] : findFileMentions(text)), [text, rich]);
  const cls = dim ? ' compacted' : '';
  return (
    <>
      {text ? (
        rich ? (
          <div className={`msg assistant rich${cls}`}>
            <Suspense fallback={<pre className="hint">{text}</pre>}>
              <RichAnswer code={text} streaming={streaming} onSend={onSend} />
            </Suspense>
          </div>
        ) : compact ? (
          <div className={`ac-msg agent${cls}`}>
            <Markdown text={text} className="ac-text" />
          </div>
        ) : (
          <Markdown text={text} className={`msg assistant${streaming ? ' cursor' : ''}${cls}`} />
        )
      ) : null}
      {mentions.length ? <Previews paths={mentions} compact={compact} /> : null}
      {tools.map((t) => (
        <ToolCard key={t.id} t={t} compact={compact} busy={busy} />
      ))}
    </>
  );
}

function UserBubble({ m, compact, dim }: { m: UserMessage; compact?: boolean; dim: boolean }) {
  const { text, attachments } = readUserContent(m);
  const paths = useMemo(() => [...attachments, ...findFileMentions(text)], [text, attachments.join('\n')]);
  return (
    <>
      <div className={`${compact ? 'ac-msg user' : 'msg user'}${dim ? ' compacted' : ''}`}>
        {m.name && !compact ? <div className="from">from {m.name}</div> : null}
        {text ? compact ? <div className="ac-text">{text}</div> : text : null}
      </div>
      {paths.length ? <Previews paths={paths} compact={compact} /> : null}
    </>
  );
}

// ---------- the conversation ----------
interface ThreadProps extends ChatViewProps {
  bridge: { loaded: (chat: Chat) => void; failed?: (message: string) => void };
  sending: { current: boolean };
  setStatus: (s: string) => void;
  status: string;
}

function Thread(p: ThreadProps) {
  const { agent, compact, tray } = p;
  const messages = useThread((s) => s.messages);
  const ourRun = useThread((s) => s.isRunning);
  const processMessage = useThread((s) => s.processMessage);
  const setMessages = useThread((s) => s.setMessages);
  const cancelMessage = useThread((s) => s.cancelMessage);
  const selectThread = useThreadList((s) => s.selectThread);
  const chatId = useThreadList((s) => s.selectedThreadId);
  const app = useAppState();
  const [items, setItems] = useState<ChatItem[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const chatIdRef = useRef(chatId);
  chatIdRef.current = chatId;
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  const pendingReload = useRef(false);
  // why the last send failed (the server's message), set by the adapter
  const failed = useRef<string | null>(null);
  p.bridge.failed = (m) => (failed.current = m);

  const serverRunning = !!chatId && !!app?.runs.some((r) => r.chatId === chatId);
  const busy = ourRun || serverRunning;
  const approvals = (app?.approvals || []).filter((a) => a.agentId === agent.id);

  // the saved chat, shown as it is
  const show = useCallback(
    (chat: Chat) => {
      setItems(chat.items);
      setMessages(toMessages(chat.items));
      p.onChat?.(chat);
    },
    [setMessages, p.onChat],
  );
  p.bridge.loaded = (chat) => {
    setItems(chat.items);
    p.onChat?.(chat);
  };
  const reload = useCallback(async () => {
    const id = chatIdRef.current;
    if (!id) return;
    const chat = await GET<Chat>(`/agents/${agent.id}/chats/${id}`).catch(() => null);
    if (chat && chatIdRef.current === id) show(chat);
  }, [agent.id, show]);

  useEffect(() => {
    if (p.chatId) selectThread(p.chatId);
  }, [p.chatId, selectThread]);

  // runs this view didn't start, and compactions: shown live, then the saved chat
  useEffect(() => {
    let frame = 0;
    return onEvent((ev) => {
      if (!chatIdRef.current || ev.chatId !== chatIdRef.current) return;
      if (ev.type === 'compacted') {
        if (p.sending.current) pendingReload.current = true;
        else void reload();
        return;
      }
      if (ev.type !== 'run' || p.sending.current) return;
      const e = ev.event as RunEvent;
      if (e.kind === 'status') return p.setStatus(e.text);
      if (e.kind === 'done' || e.kind === 'error') {
        p.setStatus('');
        return void reload();
      }
      if (e.kind === 'start') p.setStatus('Thinking…');
      const next = applyRunEvent(itemsRef.current, e);
      itemsRef.current = next;
      setItems(next);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setMessages(toMessages(itemsRef.current)));
    });
  }, [reload, setMessages]);

  const compactNow = useCallback(
    async (mode?: 'instant' | 'summary') => {
      const id = chatIdRef.current;
      if (!id) return void toast('Nothing to compact yet');
      p.setStatus(mode === 'summary' ? 'Compacting: the Brain’s model is writing a summary…' : 'Compacting…');
      const r = await attempt(
        () => POST<{ compacted: boolean; message?: string }>(`/agents/${agent.id}/chats/${id}/compact`, mode ? { mode } : {}),
        (x) => (x.compacted ? 'Compacted: the agent now remembers the older messages as a short history' : x.message || 'Nothing to compact yet'),
      );
      p.setStatus('');
      if (r?.compacted) await reload();
    },
    [agent.id, reload],
  );

  const send = useCallback(
    async (typed?: string) => {
      const box = input.current;
      if (p.sending.current || busy) return;
      const draft = typed ?? box?.value.trim() ?? '';
      if (!draft && !tray.count()) return;
      p.sending.current = true;
      let taken: ReturnType<AttachTray['take']> = [];
      try {
        if (tray.busy()) p.setStatus('Uploading files…');
        const attachments = typed != null ? [] : await tray.ready();
        p.setStatus('');
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
        taken = tray.take();
        near.current = true;
        p.setStatus('Thinking…');
        failed.current = null;
        await processMessage({ role: 'user', content: userContent(text, attachments) });
        if (failed.current) {
          toast(failed.current, 'error');
          if (typed == null && box) restoreDraft(box, text);
          tray.put(taken);
        }
      } finally {
        p.sending.current = false;
        p.setStatus('');
        pendingReload.current = false;
        await reload();
      }
    },
    [busy, tray, processMessage, compactNow, reload],
  );
  const stop = useCallback(() => {
    if (ourRun) cancelMessage();
    else if (chatIdRef.current) attempt(() => POST(`/agents/${agent.id}/chats/${chatIdRef.current}/stop`));
  }, [ourRun, cancelMessage, agent.id]);

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
  const shown = compact ? messages.slice(-120) : messages;
  const lastAssistant = messages.findLast((m) => m.role === 'assistant')?.id;
  const chatPath = chatId ? `/agents/${agent.id}/chats/${chatId}` : undefined;
  const rows = shown.map((m) => {
    const seq = seqOf(m.id);
    const dim = seq != null && seq < dimBefore;
    if (m.role === 'user') return <UserBubble key={m.id} m={m} compact={compact} dim={dim} />;
    if (m.role === 'assistant') return <AssistantTurn key={m.id} m={m} all={messages} compact={compact} busy={busy} streaming={ourRun && m.id === lastAssistant} dim={dim} onSend={(t) => void send(t)} />;
    if (m.role !== 'activity') return null;
    const it = (m as ActivityMessage).content as ChatItem;
    if (it.type === 'compaction')
      return <Dom key={m.id} make={() => compactionMark(it as CompactionItem, { chatPath, latest: latest?.item.id === (it as CompactionItem).id, busy, compact, onSaved: () => void reload() })} deps={[(it as CompactionItem).id, (it as CompactionItem).text, latest?.item.id, busy, chatPath]} />;
    if (it.type === 'error') return <div key={m.id} className={compact ? 'ac-msg err' : 'msg error'}>{it.text}</div>;
    if (it.type === 'meta') return compact ? null : <div key={m.id} className="msg meta">{it.text}</div>;
    return null;
  });

  const empty = !messages.length && !busy;
  const ideas = suggestions(agent);
  const composer = (
    <textarea
      ref={input}
      className={compact ? 'ac-input' : undefined}
      rows={2}
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
  const sendBtn = (
    <button className={compact ? 'btn small' : 'btn'} onClick={() => void send()} disabled={busy} title="Send (Enter)" style={busy && compact ? { display: 'none' } : undefined}>
      {compact ? <Dom make={() => icon('send', 14)} deps={[]} /> : 'Send'}
    </button>
  );
  const stopBtn = busy ? (
    <button className={compact ? 'btn danger small' : 'btn danger'} onClick={stop}>
      {compact ? <Dom make={() => icon('square', 13)} deps={[]} /> : null}Stop
    </button>
  ) : null;
  const statusText = p.status || (busy ? (approvals.length ? `Waiting for you: ${approvals[0].title}` : 'Working…') : '');

  return (
    <>
      <div ref={list} className={compact ? 'ac-list' : 'messages'} onScroll={onScroll}>
        {empty ? (
          compact ? (
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
                {ideas.map((t) => (
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
      <div className={compact ? 'ac-approvals' : undefined} style={compact ? undefined : { padding: '0 28px' }}>
        {approvals.map((a) => (
          <Dom key={a.id} className={compact ? undefined : 'oc-approval'} make={() => approvalCard(a)} deps={[a.id]} />
        ))}
      </div>
      <div className={compact ? 'ac-status' : 'status-line'}>
        {statusText ? (
          compact ? (
            statusText
          ) : (
            <>
              <span className="dot busy" />
              {statusText}
            </>
          )
        ) : null}
      </div>
      {compact ? (
        <>
          <Dom make={() => tray.el} deps={[tray]} />
          <div className="ac-compose">
            <Dom make={() => tray.picker} deps={[tray]} />
            {composer}
            {sendBtn}
            {stopBtn}
          </div>
        </>
      ) : (
        <div className="composer">
          <Dom make={() => tray.el} deps={[tray]} />
          <div className="composer-box">
            <Dom make={() => tray.picker} deps={[tray]} />
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

export function ChatView(props: ChatViewProps) {
  const [status, setStatus] = useState('');
  const sending = useRef(false);
  const bridge = useRef<{ loaded: (chat: Chat) => void; failed?: (m: string) => void }>({ loaded: () => {} }).current;
  const agentId = props.agent.id;
  // the server keeps the chats; OpenUI only reads one and makes one for a first message
  const storage = useMemo<ChatStorage>(
    () => ({
      thread: {
        listThreads: async () => ({ threads: [] }),
        getMessages: async (id) => {
          const chat = await GET<Chat>(`/agents/${agentId}/chats/${id}`);
          bridge.loaded(chat);
          return toMessages(chat.items);
        },
        createThread: async () => {
          const chat = await POST<Chat>(`/agents/${agentId}/chats`);
          bridge.loaded(chat);
          return { id: chat.id, title: chat.title, createdAt: chat.createdAt };
        },
        updateThread: async (t) => t,
        deleteThread: async () => {},
      },
    }),
    [agentId, bridge],
  );
  const llm = useMemo(
    () =>
      dashboardLLM(agentId, {
        onStatus: setStatus,
        onSendFailed: (m) => bridge.failed?.(m),
        isRunning: (chatId) => !!state.data?.runs.some((r) => r.chatId === chatId),
      }),
    [agentId, bridge],
  );
  return (
    <ChatProvider llm={llm} storage={storage}>
      <Thread {...props} bridge={bridge} sending={sending} status={status} setStatus={setStatus} />
    </ChatProvider>
  );
}
