// One agent's conversation, on the Vercel AI SDK (useChat): the saved chat as UI messages, a message
// you send streams in as its run goes (text as written, tool calls as they happen), and a run started
// anywhere else (a team turn, a routine, another tab) is picked up and streamed too (a resume: the
// turn so far, then the rest). The server speaks the AI SDK's UI message stream (server/uistream.ts).
// Used by the full chat page (views/chat.tsx), the floating window's agent tabs (agentchat.tsx, compact)
// and the Station's agent panel (mini).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { useChat } from '@ai-sdk/react';
import { attempt, toast, state, onState, onEvent, approvalCard } from '../core.ts';
import { rpcAt } from '../client/rpc.ts';
import type { AttachTray } from '../attach.tsx';
import { COMPOSER_BTNS, COMPOSER_TEXT } from '../attach.tsx';
import { pasteBox } from '../pastes.ts';
import { icon } from '../icons.ts';
import { Dot } from '../ui/marks.tsx';

import { TaskPanel } from '../tasks.tsx';
import { Dom, Handoffs, MessageView, isRichCode } from './parts.tsx';
import type { Variant } from './parts.tsx';
import { beforeTurn, handoffMap, handoffsIn, searchText, toUIMessages, userParts } from './messages.ts';
import { WINDOW_FROM, Windowed } from './window.tsx';
import { useFind } from '../ui/find.tsx';
import { Button } from '../ui/button.tsx';
import { estimateHeight, messageSig } from './estimate.ts';
import { chatTransport } from './transport.ts';
import { projectAt } from '../client/connection.ts';
import { ChatProject } from './project.ts';
import { agentMentions, insertMention } from './mention.ts';
import { attachMentionEditor } from './mentioneditor.ts';
import type { MentionAgent } from './mention.ts';
import { agentRef } from '../../shared/agentref.ts';
import { queuedText } from '../../shared/queue.ts';
import { goalText, parseCommand, showsGoal, slashSuggestions } from '../../shared/commands.ts';
import type { SlashOption } from '../../shared/commands.ts';
import { goalLine, loopLine } from '../chatcommands.ts';
import { QueuedList, keepLostEdit } from '../queuedlist.tsx';
import type { ChatMessage } from './messages.ts';
import type { AppState, BrainBrief, Chat, ChatItem, LoopInfo, QueuedMessage, Agent } from '../../shared/types.ts';

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
  /** Shown in the composer footer (the model chip). */
  footer?: HTMLElement | null;
  /** The chat as it was (re)loaded, or made by the first message. */
  onChat?: (chat: Chat) => void;
  apiRef?: { current: ChatViewApi | null };
  /** The agents of the chat's project, when it isn't the open one (an Overview pane): the ones @ offers. */
  agents?: Agent[];
  /** The chat's project, when it isn't the open one (an Overview pane): its requests go there, and runs, approvals
   *  and events of other projects (a copied project has the same agent and chat ids) are left out. */
  projectId?: string;
}

/** The page's shared state (agents, runs, approvals), kept current. */
function useAppState(): AppState | null {
  const [data, setData] = useState(state.data);
  useEffect(() => onState((d) => setData(d)), []);
  return data;
}

export { chatTransport } from './transport.ts';

export function ChatView(p: ChatViewProps) {
  const { agent } = p;
  const at = projectAt(p.projectId);
  /** Whether a run, approval or event (by its project) is this chat's: the pane's project, or the open one. */
  const ours = (projectId: unknown) => {
    const mine = p.projectId || state.data?.project?.id;
    return !projectId || !mine || projectId === mine;
  };
  const oursRef = useRef(ours);
  oursRef.current = ours;
  const variant: Variant = p.variant || (p.compact ? 'compact' : 'full');
  const compact = variant !== 'full';
  const tray = p.tray || null;
  const app = useAppState();
  const chatIdRef = useRef<string | null>(p.chatId);
  const [chatId, setChatId] = useState<string | null>(p.chatId);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [statusText, setStatusText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  // long pasted text, folded into a chip until it is sent
  const [pastes] = useState(pasteBox);
  useEffect(() => (input.current ? pastes.attach(input.current) : undefined), [pastes]);
  // something to send in the box (words or files): Send; nothing while it works: Stop
  const [filled, setFilled] = useState(false);
  const refill = useCallback(() => setFilled(!!input.current?.value.trim() || (tray?.count() ?? 0) > 0), [tray]);
  useEffect(() => tray?.listen(refill), [tray, refill]);
  /** Put text back in the box (a failed send, what Stop brought back). */
  const restore = useCallback(
    (text: string) => {
      pastes.restore(text);
      refill();
    },
    [pastes, refill],
  );
  // the queued message being changed (its id)
  const [editing, setEditing] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  // why the last send failed; refused: the server never took it (so the text goes back in the box)
  const failed = useRef<{ message: string; refused: boolean } | null>(null);
  // your /queue messages, waiting for the agent to be done here (the server keeps them)
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const queuedRef = useRef(queued);
  queuedRef.current = queued;
  // the next queued message started while this view was still streaming the turn before it
  const missedStart = useRef(false);
  // your /loop and /goal here (the server keeps them)
  const [loop, setLoop] = useState<LoopInfo | null>(null);
  const [goal, setGoal] = useState<BrainBrief | null>(null);
  // the agent's harness's own / commands (a Claude Code agent's), for the / menu
  const [harness, setHarness] = useState<{ name: string; about: string }[]>([]);
  const onChat = useRef(p.onChat);
  onChat.current = p.onChat;
  // one id for this view's useChat, even when its first message makes the chat
  const [viewId] = useState(() => p.chatId || `new-${agent.id}-${Math.random().toString(36).slice(2, 8)}`);

  // the server answered the last send (so it has the message): a failure after that is the run's, not the send's
  const accepted = useRef(false);
  const transport = useMemo(() => chatTransport(agent.id, () => chatIdRef.current, () => (accepted.current = true), at), [agent.id, at]);
  const { messages, setMessages, sendMessage, status, stop: stopStream, resumeStream } = useChat<ChatMessage>({
    id: viewId,
    transport,
    onData: (part) => {
      if (part.type === 'data-status') setStatusText((part.data as { text: string }).text);
    },
    // a refusal (busy, a bad request) and a send that never reached the server (no connection) fail before
    // the server answers with a stream; a run that failed, as an error in its stream (the message was sent and
    // is in the chat)
    onError: (e) => (failed.current = { message: e.message || 'Could not send.', refused: !accepted.current }),
  });
  const streaming = status === 'submitted' || status === 'streaming';
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;

  const serverRunning = !!chatId && !!app?.runs.some((r) => r.chatId === chatId && ours(r.projectId));
  const busy = streaming || serverRunning;
  // it works for a team or another agent here: they wait on its answer, so a message can't change its course
  const helping = !!chatId && !!app?.runs.some((r) => r.chatId === chatId && ours(r.projectId) && (r.depth ?? 0) > 0);
  const approvals = (app?.approvals || []).filter((a) => a.agentId === agent.id && ours(a.projectId));

  // the saved chat, shown as it is. after: a stream just ended (its flag may not have caught up yet)
  const reload = useCallback(async (after = false) => {
    const id = chatIdRef.current;
    if (!id) return;
    const saved = await rpcAt(at).agents.chats.get({ id: agent.id, chatId: id }).catch(() => null);
    if (!saved || chatIdRef.current !== id) return;
    setItems(saved.items);
    setQueued(saved.queued || []);
    setLoop(saved.loop || null);
    setGoal(saved.goal || null);
    // (while a stream is going it keeps its own message; the saved chat comes when it ends)
    if (after || !streamingRef.current) setMessages(toUIMessages(saved.items));
    onChat.current?.(saved);
  }, [agent.id, at, setMessages]);

  // pick up a run going in this chat: the messages before its turn, then the turn streamed in
  const following = useRef(false);
  // done once following (or sending) has wound up, the saved chat loaded again
  const followDone = useRef<Promise<void> | null>(null);
  const sendDone = useRef<Promise<void> | null>(null);
  const follow = useCallback(async () => {
    if (streamingRef.current || following.current || !chatIdRef.current) return;
    following.current = true;
    let finished = () => {};
    followDone.current = new Promise<void>((r) => (finished = r));
    try {
      setMessages((m) => beforeTurn(m));
      setStatusText('Working…');
      await resumeStream();
    } finally {
      following.current = false;
      setStatusText('');
      await reload(true);
      catchUp();
      finished();
    }
  }, [resumeStream, reload, setMessages]);
  // a queued message started while a turn was streaming here: stream that one in too, once this
  // view has seen its own stream end (the effect runs after that render)
  const [ended, setEnded] = useState(0);
  const catchUp = () => setEnded((n) => n + 1);
  useEffect(() => {
    if (!missedStart.current || streaming || sending.current || following.current) return;
    missedStart.current = false;
    void follow();
  }, [ended, streaming, follow]);

  useEffect(() => {
    void (async () => {
      await reload();
      if (chatIdRef.current && state.data?.runs.some((r) => r.chatId === chatIdRef.current && oursRef.current(r.projectId))) await follow();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a run starting here from elsewhere, compactions, and runs ending without a stream (missed ones)
  useEffect(
    () =>
      onEvent((ev) => {
        if (!oursRef.current(ev.projectId)) return;
        // your /goal here: the Brain followed up, or it is reached, stuck or dropped
        if (ev.type === 'brief') {
          const b = ev.brief as BrainBrief;
          if (b.kind !== 'agent' || !b.goal || !chatIdRef.current || b.chatId !== chatIdRef.current) return;
          return void setGoal((g) => (b.status === 'open' && showsGoal(b) ? b : g?.id === b.id ? null : g));
        }
        if (!chatIdRef.current || ev.chatId !== chatIdRef.current) return;
        if (ev.type === 'compacted' || ev.type === 'chat-note') {
          if (!streamingRef.current) void reload();
          return;
        }
        if (ev.type === 'loop') return void setLoop((ev.loop as LoopInfo | null) || null);
        if (ev.type === 'queue') return void setQueued((ev.queued as QueuedMessage[]) || []);
        if (ev.type !== 'run') return;
        const kind = (ev.event as { kind?: string })?.kind;
        // (the server starts a queued message right as the turn before it ends: this view may still be streaming that one)
        if (kind === 'start' && (streamingRef.current || sending.current || following.current) && queuedRef.current.length) missedStart.current = true;
        if (kind === 'start' && !streamingRef.current && !sending.current) void reload().then(follow);
        else if ((kind === 'done' || kind === 'error') && !streamingRef.current && !sending.current) void reload();
      }),
    [reload, follow],
  );

  const sending = useRef(false);
  const steering = useRef(false);
  const send = useCallback(
    async (typed?: string) => {
      const box = input.current;
      if (steering.current) return;
      // (a button in an earlier answer: not while it works)
      if (busy && typed != null) return void toast(`${agent.name} is working. Wait for it, or write a message to change its course.`);
      if (busy && helping) return void toast(`${agent.name} is working for a team or another agent here. /queue your message for when it is done.`);
      // while it works: this message changes its course (the run going now stops, this one goes next)
      const steer = busy;
      if (sending.current && !steer) return;
      const draft = typed ?? box?.value.trim() ?? '';
      if (!draft && !tray?.count()) return;
      if (steer) {
        // (stop reading the turn going now; once that has wound up, this message takes its place)
        steering.current = true;
        try {
          void stopStream();
          await Promise.allSettled([sendDone.current, followDone.current]);
        } finally {
          steering.current = false;
        }
        if (sending.current) return;
      }
      sending.current = true;
      let finished = () => {};
      sendDone.current = new Promise<void>((r) => (finished = r));
      let taken: ReturnType<AttachTray['take']> = [];
      try {
        if (tray?.busy()) setStatusText('Uploading files…');
        const attachments = typed != null || !tray ? [] : await tray.ready();
        setStatusText('');
        if (!attachments) return;
        // what is in the box now (more may have been typed while the files uploaded)
        const typedNow = typed ?? (box ? pastes.text().trim() : '');
        // "/queue …" while it isn't working: nothing to wait for, so it goes now
        const text = typed == null ? (queuedText(typedNow) ?? typedNow) : typedNow;
        if (!text && !attachments.length) return void (typedNow && toast('Write the message after /queue'));
        if (typed == null && box) {
          box.value = '';
          box.style.height = '';
          pastes.sync();
          refill();
        }
        // a new conversation: make the chat first
        if (!chatIdRef.current) {
          const made = await attempt(() => rpcAt(at).agents.chats.create({ id: agent.id }));
          if (!made) {
            if (typed == null && box) restore(text);
            return;
          }
          chatIdRef.current = made.id;
          setChatId(made.id);
          onChat.current?.(made);
        }
        // (a button in an answer sends no files: the ones staged stay for the next message)
        taken = typed != null ? [] : tray?.take() || [];
        near.current = true;
        failed.current = null;
        accepted.current = false;
        setStatusText('Thinking…');
        await sendMessage({ role: 'user', parts: userParts(text, attachments), metadata: {} }, steer ? { body: { steer: true } } : undefined);
        // (set by onError while it streamed)
        const fail = failed.current as { message: string; refused: boolean } | null;
        if (fail) {
          toast(fail.message, 'error');
          if (fail.refused) {
            if (typed == null && box) restore(text);
            tray?.put(taken);
          }
        }
      } finally {
        sending.current = false;
        setStatusText('');
        await reload(true);
        catchUp();
        finished();
      }
    },
    [busy, helping, tray, pastes, sendMessage, stopStream, reload, refill, restore, agent.id, agent.name],
  );

  // "/queue …" while the agent works: the server holds it and sends it when this turn is done
  const queueing = useRef(false);
  const queueNext = useCallback(async () => {
    const box = input.current;
    const id = chatIdRef.current;
    if (!box || !id || queueing.current) return;
    queueing.current = true;
    try {
      const attachments = tray ? await tray.ready() : [];
      if (!attachments) return;
      // (what is in the box now: more may have been typed while the files uploaded)
      const all = pastes.text();
      const text = queuedText(all) ?? all.trim();
      if (!text && !attachments.length) return void toast('Write the message after /queue');
      box.value = '';
      box.style.height = '';
      pastes.sync();
      refill();
      const taken = tray?.take() || [];
      const r = await attempt(() => rpcAt(at).agents.chats.queue({ id: agent.id, chatId: id, text, attachments }));
      if (!r) {
        restore(`/queue ${text}`);
        tray?.put(taken);
        return;
      }
      const added = 'queued' in r ? r.queued : undefined;
      if (added) setQueued((q) => (q.some((x) => x.id === added.id) ? q : [...q, added]));
    } finally {
      queueing.current = false;
    }
  }, [agent.id, at, tray, pastes, refill, restore]);
  const unqueue = useCallback(
    (q: QueuedMessage) => {
      const id = chatIdRef.current;
      if (!id) return;
      setQueued((list) => list.filter((x) => x.id !== q.id));
      void attempt(() => rpcAt(at).agents.chats.unqueue({ id: agent.id, chatId: id, queueId: q.id }));
    },
    [agent.id, at],
  );
  const keepEdit = (text: string) => keepLostEdit(text, input.current, restore);
  const editQueued = async (q: QueuedMessage, text: string) => {
    const id = chatIdRef.current;
    if (!id) return;
    const put = (t: string) => setQueued((list) => list.map((x) => (x.id === q.id ? { ...x, text: t } : x)));
    put(text);
    const r = await attempt(() => rpcAt(at).agents.chats.editQueued({ id: agent.id, chatId: id, queueId: q.id, text }));
    // not saved: it shows what will go after all; already sent: the change comes to the box
    if (!r) put(q.text);
    else if (r.queued === null) keepEdit(text);
  };
  const orderQueued = (ids: string[]) => {
    const id = chatIdRef.current;
    if (!id) return;
    setQueued((list) => ids.map((x) => list.find((q) => q.id === x)).filter((q): q is QueuedMessage => !!q));
    void attempt(() => rpcAt(at).agents.chats.orderQueue({ id: agent.id, chatId: id, ids }));
  };
  // the chat, made now if this is a new conversation (for a command that needs one)
  const ensureChat = async (): Promise<string | null> => {
    if (chatIdRef.current) return chatIdRef.current;
    const made = await attempt(() => rpcAt(at).agents.chats.create({ id: agent.id }));
    if (!made) return null;
    chatIdRef.current = made.id;
    setChatId(made.id);
    onChat.current?.(made);
    return made.id;
  };

  // /stop, /resume, /resend, /loop, /goal, /learn (whether it is working or not)
  // fromBox: typed in the box (it is cleared, and comes back if the command fails); not a chip's ×
  const command = async (name: string, rest: string, fromBox = true) => {
    const box = input.current;
    if (!box) return;
    // (with pasted text put back: a long goal pasted in goes in full)
    const typed = fromBox ? pastes.text().trim() : '';
    if (fromBox) {
      box.value = '';
      box.style.height = '';
      pastes.sync();
      refill();
      setSlash(null);
    }
    const back = () => void (fromBox && restore(typed));
    if (name === 'stop') return void stop();
    const id = await ensureChat();
    if (!id) return back();
    const calls = rpcAt(at).agents.chats;
    const here = { id: agent.id, chatId: id };
    if (name === 'goal' && !rest) return void toast(goal ? `Goal: ${goalText(goal)}` : 'No goal yet. Type /goal and what done looks like.');
    if (name === 'loop') {
      // (with the files in the tray: each loop message carries them; not when it is ended)
      const off = /^(off|stop|end|cancel)$/i.test(rest);
      const attachments = tray && !off ? await tray.ready() : [];
      if (!attachments) return back();
      const taken = off ? [] : tray?.take() || [];
      const r = await attempt(() => calls.loop({ ...here, text: rest, attachments }));
      if (!r) return void (back(), tray?.put(taken));
      return setLoop(r.loop);
    }
    if (name === 'learn') {
      // the files in the tray are what to learn from, as much as the words
      const attachments = tray ? await tray.ready() : [];
      if (!attachments) return back();
      const taken = tray?.take() || [];
      const r = await attempt(() => calls.learn({ ...here, text: rest, attachments }));
      if (!r) return void (back(), tray?.put(taken));
      const added = 'queued' in r ? r.queued : undefined;
      if (added) setQueued((q) => (q.some((x) => x.id === added.id) ? q : [...q, added]));
      return;
    }
    if (name === 'goal') {
      const r = await attempt(() => calls.goal({ ...here, text: rest }));
      if (!r) return back();
      return setGoal(r.goal || null);
    }
    if (name !== 'resend' && name !== 'resume') return back();
    const r = await attempt(async () => (name === 'resend' ? await calls.resend(here) : await calls.resume(here)));
    if (!r) return back();
    const added = 'queued' in r ? r.queued : undefined;
    if (added) setQueued((q) => (q.some((x) => x.id === added.id) ? q : [...q, added]));
  };

  // Enter: a command; a /queue while it works waits its turn; anything else is sent (when it isn't working)
  const submit = () => {
    const box = input.current;
    const cmd = box ? parseCommand(pastes.text(), 'agent') : null;
    if (cmd && cmd.name !== 'queue') return void command(cmd.name, cmd.rest);
    // (from the text with pastes put back: a long paste shows as a chip in the box)
    if (box && queuedText(pastes.text()) != null && (busy || sending.current)) return void queueNext();
    void send();
  };

  const stop = useCallback(async () => {
    const id = chatIdRef.current;
    void stopStream();
    if (!id) return;
    const r = await attempt(() => rpcAt(at).agents.chats.stop({ id: agent.id, chatId: id }));
    // what you queued comes back to the box, so stopping never loses it
    const back = r?.unqueued || [];
    if (back.length) restore(back.map((q) => q.text).filter(Boolean).join('\n\n'));
    if (back.some((q) => q.attachments?.length)) toast('Your queued messages are back in the box. Attach their files again.');
  }, [agent.id, at, stopStream, restore]);

  if (p.apiRef)
    p.apiRef.current = {
      reload,
      focus: () => input.current?.focus(),
      setDraft: (t) => {
        if (!input.current) return;
        input.current.value = t;
        pastes.sync();
        refill();
        input.current.focus();
      },
    };

  // keep to the newest message while you are at the bottom
  useLayoutEffect(() => {
    const el = list.current;
    if (el && near.current) el.scrollTop = el.scrollHeight;
  });
  // previews, videos and Rich answers arrive after the first draw: stay at the bottom as they grow
  // (style too: a long chat's list grows as its messages are measured)
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const stick = () => {
      if (near.current) el.scrollTop = el.scrollHeight;
    };
    const watch = new MutationObserver(stick);
    watch.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    // (the list itself gets shorter when the window is resized or the box below it grows, which is no
    //  mutation to see: without this the newest message ends up cut off at the bottom)
    const size = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(stick);
    size?.observe(el);
    el.addEventListener('load', stick, true);
    el.addEventListener('loadedmetadata', stick, true);
    return () => {
      watch.disconnect();
      size?.disconnect();
      el.removeEventListener('load', stick, true);
      el.removeEventListener('loadedmetadata', stick, true);
    };
  }, []);
  const onScroll = () => {
    const el = list.current;
    if (el) near.current = el.scrollHeight - el.scrollTop - el.clientHeight < (compact ? 80 : 140);
  };

  // @ to pick another agent: a menu above the box while the caret is in an "@…"
  const [mention, setMention] = useState<{ start: number; options: MentionAgent[]; active: number } | null>(null);
  // / for commands: a menu above the box while it holds just "/" and the start of a name
  const [slash, setSlash] = useState<{ options: SlashOption[]; active: number } | null>(null);
  useEffect(() => {
    void rpcAt(at).agents.commands({ id: agent.id })
      .then((list) => setHarness(Array.isArray(list) ? list : []))
      .catch(() => {});
  }, [agent.id, at]);
  const lookForSlash = () => {
    const options = slashSuggestions(input.current?.value || '', 'agent', harness);
    setSlash((was) => (options.length ? { options, active: was && was.options.length === options.length ? Math.min(was.active, options.length - 1) : 0 } : null));
  };
  const pickSlash = (o: SlashOption) => {
    const box = input.current;
    if (!box) return;
    // ours with nothing after it runs now; the rest wait for what comes after (a harness command goes as typed)
    box.value = o.args || o.harness ? `/${o.name} ` : `/${o.name}`;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    setSlash(null);
    if (!o.args && !o.harness) submit();
  };
  const onSlashKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!slash || e.nativeEvent.isComposing) return false;
    const n = slash.options.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setSlash({ ...slash, active: (slash.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
    else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') pickSlash(slash.options[slash.active]);
    else if (e.key === 'Escape') {
      e.stopPropagation();
      setSlash(null);
    } else return false;
    e.preventDefault();
    return true;
  };
  const others = p.agents || app?.agents || [];
  // @ mentions of other agents show as pills while you write, as in team chats
  const othersRef = useRef(others);
  othersRef.current = others;
  useEffect(() => {
    const box = input.current;
    if (!box) return;
    return attachMentionEditor(box, () => othersRef.current.filter((a) => a.id !== agent.id && a.name.trim()).map((a) => `@${agentRef(a, othersRef.current)}`));
  }, [agent.id, at]);
  // (it can only hand work on with ask_agent, which the Delegate tools give it)
  const canDelegate = !!others.find((a) => a.id === agent.id)?.toolGroups?.includes('agents');
  const lookForMention = () => {
    const box = input.current;
    const found = box && box.selectionStart === box.selectionEnd ? agentMentions(box.value, box.selectionStart, others, agent.id) : null;
    setMention((was) => (found ? { ...found, active: was && was.start === found.start ? Math.min(was.active, found.options.length - 1) : 0 } : null));
  };
  const pickMention = (a: MentionAgent) => {
    const box = input.current;
    if (!box || !mention) return;
    // with the id when the name is shared, so ask_agent reaches this one
    const r = insertMention(box.value, mention.start, box.selectionStart, agentRef(a, others));
    box.value = r.text;
    box.setSelectionRange(r.caret, r.caret);
    box.focus();
    setMention(null);
  };
  // arrows move through the menu, Enter or Tab picks, Escape closes it. true: the key was used.
  const onMentionKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!mention || e.nativeEvent.isComposing) return false;
    const n = mention.options.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setMention({ ...mention, active: (mention.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
    else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') pickMention(mention.options[mention.active]);
    else if (e.key === 'Escape') {
      // (and not the chat window)
      e.stopPropagation();
      setMention(null);
    } else return false;
    e.preventDefault();
    return true;
  };

  // (a long chat draws only the messages near the screen, so the whole of it can be shown)
  const shown = variant === 'mini' ? messages.slice(-14) : messages;
  const windowed = variant !== 'mini' && shown.length >= WINDOW_FROM;
  const lastId = messages[messages.length - 1]?.id;
  const owner = useMemo(() => ({ agentId: agent.id, chatId }), [agent.id, chatId]);
  // (await_agent shows the agent its handle went to: the same map while words stream in)
  const handoffKey = handoffsIn(messages);
  const handoffs = useMemo(() => handoffMap(handoffKey), [handoffKey]);
  const row = (m: ChatMessage) => {
    return (
      <MessageView
        key={m.id}
        m={m}
        variant={variant}
        busy={busy}
        streaming={streaming && m.id === lastId}
        dim={false}
        onSend={(t) => void send(t)}
        owner={owner}
      />
    );
  };
  // Ctrl+F (⌘F): a long chat draws only some of its messages, so the search reads them all and scrolls to the one it found
  const revealRow = useRef<((i: number) => void) | null>(null);
  const find = useFind(list, windowed ? { count: shown.length, text: (i) => searchText(shown[i]), reveal: (i) => revealRow.current?.(i) } : null);
  const rows = windowed ? (
    <Windowed items={shown} scroller={list} atEnd={near.current} gap={compact ? 16 : 20} estimate={(m, width) => estimateHeight(m, width, compact)} memoKey={(m) => `${agent.id}/${chatId || viewId}/${compact ? 'c' : ''}${m.id}/${messageSig(m)}`} render={row} reveal={revealRow} />
  ) : (
    shown.map(row)
  );

  const empty = !messages.length && !busy;
  // what the streaming message is doing now: writing, or using a tool (a status line from the server,
  // like "Compacting the chat…", comes first)
  const lastPart = streaming ? messages[messages.length - 1]?.parts.at(-1) : undefined;
  const doing = lastPart?.type === 'dynamic-tool' && lastPart.state !== 'output-available' && lastPart.state !== 'output-error' ? `Using ${lastPart.toolName}…` : lastPart?.type === 'text' ? 'Writing…' : '';
  const generic = !statusText || /^(Thinking|Working)…$/.test(statusText);
  const statusLine = (approvals.length && busy ? `Waiting for you: ${approvals[0].title}` : '') || (generic && doing) || statusText || (busy ? 'Working…' : '');
  // (click, keyup and blur are read on the box around it: the pill editor that takes the textarea's place gets them)
  const composer = (
    <div
      className="relative flex min-w-0 flex-1"
      onClick={lookForMention}
      onKeyUp={(e) => {
        if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key)) lookForMention();
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) (setMention(null), setSlash(null));
      }}
    >
      <textarea
        ref={input}
        className={variant === 'mini' ? 'max-h-50 min-h-11.5 flex-1 resize-none' : `dock-input w-full ${COMPOSER_TEXT}`}
        rows={variant === 'mini' ? 1 : 2}
        placeholder={helping ? `${agent.name} is working for a team or another agent… /queue a message for when it is done` : busy ? `${agent.name} is working… Write to change course now, or /queue a message for when it is done` : compact ? `Message ${agent.name}…  (Enter to send, @ for another agent)` : `Message ${agent.name}…`}
        onKeyDown={(e) => {
          if (onSlashKey(e) || onMentionKey(e)) return;
          // Up in an empty box: change the last queued message
          if (e.key === 'ArrowUp' && !e.currentTarget.value && queued.length && !e.altKey && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            return setEditing(queued[queued.length - 1].id);
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        onInput={(e) => {
          lookForMention();
          lookForSlash();
          refill();
          if (variant === 'mini') return;
          // grows with the text (its max height stops it, then it scrolls)
          const t = e.currentTarget;
          t.style.height = 'auto';
          t.style.height = `${t.scrollHeight + 2}px`;
        }}
      />
      {slash ? (
        <div className="tc-suggest slash-menu" role="listbox">
          {slash.options.map((o, i) => (
            <button
              key={`${o.harness ? 'h' : 'd'}-${o.name}`}
              type="button"
              role="option"
              aria-selected={i === slash.active}
              className={i === slash.active ? 'tc-sopt on items-baseline' : 'tc-sopt items-baseline'}
              onMouseDown={(e) => {
                e.preventDefault();
                pickSlash(o);
              }}
            >
              <b className="slash-name flex-none font-mono text-[12.5px] leading-[normal] font-semibold text-accent">/{o.name}</b>
              {o.args ? <span className="flex-none font-mono text-[11.5px] leading-[normal] text-faint">{o.args}</span> : null}
              <span className="hint min-w-0">{o.harness ? `${o.about || 'Claude Code command'} · Claude Code` : o.about}</span>
            </button>
          ))}
        </div>
      ) : null}
      {mention ? (
        <div className="tc-suggest mention-menu" role="listbox">
          {mention.options.map((a, i) => (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={i === mention.active}
              className={i === mention.active ? 'tc-sopt on' : 'tc-sopt'}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(a);
              }}
            >
              <span className="avatar" style={{ '--agent-color': a.color || 'var(--color-accent)' } as CSSProperties}>
                {a.emoji || '🤖'}
              </span>
              <span className="min-w-0 shrink-0 truncate font-medium">@{a.name}</span>
              {a.specialty ? <span className="hint">{a.specialty}</span> : null}
            </button>
          ))}
          {canDelegate ? null : <div className="hint mention-note mt-1 border-t border-line px-2.5 pt-2 pb-1.5 text-[12px]">To pass work on, {agent.name} needs Delegate turned on in its tools.</div>}
        </div>
      ) : null}
    </div>
  );
  // one button under the paperclip: Send, or Stop while it works and there is nothing to send
  const working = streaming || serverRunning;
  const sendBtn =
    working && !filled ? (
      <Button key="stop" variant="danger" size={variant === 'mini' ? 'small' : 'default'} className={variant === 'mini' ? undefined : compact ? 'rounded-full' : 'size-8! px-0'} onClick={() => void stop()} title={`Stop ${agent.name}`} aria-label="Stop">
        <Dom make={() => icon('square', variant === 'mini' ? 13 : 14)} deps={[]} />
      </Button>
    ) : (
      <Button key="send" size={variant === 'mini' ? 'small' : 'default'} className={variant === 'mini' ? undefined : compact ? 'rounded-full' : 'size-8! px-0'} onClick={submit}  title={working ? `Send now: ${agent.name} stops what it is doing and takes this up (Enter)` : 'Send (Enter)'} aria-label="Send">
        <Dom make={() => icon(variant === 'mini' ? 'send' : 'arrow-up', variant === 'mini' ? 14 : 16)} deps={[]} />
      </Button>
    );

  // your /goal and /loop here (× ends one)
  const chips =
    goal || loop ? (
      <div className={compact ? 'cmd-chips compact' : 'cmd-chips'}>
        {goal ? (
          <div className="cmd-chip goal">
            <Dom make={() => icon('target', 13)} deps={[]} />
            <span className="min-w-0 flex-1 truncate">
              <b>Goal: </b>
              {goalText(goal)}
            </span>
            <span className="hint">{goalLine(goal)}</span>
            <button type="button" className="tc-act" title="Drop this goal" aria-label="Drop this goal" onClick={() => void command('goal', 'clear', false)}>
              <Dom make={() => icon('x', 12)} deps={[]} />
            </button>
          </div>
        ) : null}
        {loop ? (
          <div className="cmd-chip loop">
            <Dom make={() => icon('repeat', 13)} deps={[]} />
            <span className="min-w-0 flex-1 truncate">
              <b>Loop: </b>
              {loop.text}
            </span>
            <span className="hint">{loopLine(loop)}</span>
            <button type="button" className="tc-act" title="Stop the loop" aria-label="Stop the loop" onClick={() => void command('loop', 'off', false)}>
              <Dom make={() => icon('x', 12)} deps={[]} />
            </button>
          </div>
        ) : null}
      </div>
    ) : null;

  // your /queue messages, in the order they will go (click one to change it, drag to reorder, × takes one back)
  const queuedList = (
    <QueuedList
      items={queued}
      head={`Sends when ${agent.name} is done`}
      compact={compact}
      editing={editing}
      onEditing={setEditing}
      onSave={(q, text) => void editQueued(q, text)}
      onRemove={unqueue}
      onOrder={orderQueued}
      onLeave={() => input.current?.focus()}
      onLost={(_q, text) => keepEdit(text)}
      // (sent into the turn going on: it leaves the list once read, or goes next if the turn ends first)
      hint={(q) => (q.reading ? 'Sent. It reads this at its next step' : null)}
    />
  );

  return (
    <ChatProject.Provider value={p.projectId}>
      <Handoffs.Provider value={handoffs}>
      {find}
      {variant !== 'mini' && <div className={compact ? '' : 'px-10 max-md:px-4'}><TaskPanel view={`agent:${agent.id}`} scope={{ kind: 'agent', id: agent.id }} chatId={chatId || undefined} projectId={p.projectId} /></div>}
      <div ref={list} className={variant === 'mini' ? 'oc-mini-list flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto py-2' : compact ? 'ac-list [mask-image:linear-gradient(to_bottom,transparent_0,#000_12px,#000_calc(100%-14px),transparent_100%)] flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1 pt-1 pb-2' : 'messages'} onScroll={onScroll}>
        {empty ? (
          variant === 'mini' ? (
            <p className="empty">No messages yet.</p>
          ) : compact ? (
            <div className="m-auto py-12 text-center text-dim">
              <Dom make={() => icon('message-circle', 22)} deps={[]} />
              <p className="mt-2.5 mb-0">Say hi to {agent.name}.</p>
              <p className="hint mt-1.5 mb-0">{agent.specialty || ''}</p>
            </div>
          ) : (
            <div className="empty-chat m-auto w-full max-w-[520px] py-12 text-center text-dim">
              <div className="mx-auto grid size-14 place-items-center rounded-[16px] border border-line bg-panel text-[30px] leading-none shadow-[inset_0_1px_0_var(--glass-spec)]">{agent.emoji || '🤖'}</div>
              <p className="mt-5 mb-0 text-[17px] font-semibold tracking-tight text-ink">Ask {agent.name} anything</p>
              {agent.specialty ? <p className="mx-auto mt-1.5 mb-0 max-w-[44ch] text-[13.5px] leading-normal text-dim">{agent.specialty}</p> : null}
              {/* a few things to try: each puts its words in the message box */}
              <div className={`mt-7 grid gap-2 text-left ${suggestions(agent).length > 1 ? 'sm:grid-cols-2' : 'mx-auto max-w-[300px]'}`}>
                {suggestions(agent).map((t) => (
                  <button key={t} className="group/try flex w-full cursor-pointer items-start gap-2.5 rounded-box border border-line bg-panel px-3.5 py-3 text-left text-[13px] leading-snug text-dim shadow-[inset_0_1px_0_var(--glass-spec)] transition-[transform,background-color,color,border-color] duration-150 active:scale-[0.98] motion-reduce:transition-none hover:border-line-2 hover:bg-panel-2 hover:text-ink" onClick={() => p.apiRef?.current?.setDraft(t)}>
                    <Dom className="mt-px flex-none text-faint group-hover/try:text-accent" make={() => icon('sparkles', 14)} deps={[]} />
                    <span className="min-w-0 flex-1">{t}</span>
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
        <div className={compact ? 'empty:hidden' : 'px-10 max-md:px-4'}>
          {approvals.map((a) => (
            <Dom key={a.id} className={compact ? undefined : 'mb-3 max-w-[860px]'} make={() => approvalCard(a)} deps={[a.id]} />
          ))}
        </div>
      )}
      {chips}
      {queuedList}
      <div className={compact ? 'min-h-5 pt-1 text-[12.5px] leading-[normal] text-dim' : 'status-line flex min-h-6 items-center gap-2 px-10 pt-2 text-[12.5px] leading-[normal] text-dim max-md:px-4'}>
        {statusLine ? (
          compact ? (
            statusLine
          ) : (
            <>
              <Dot tone="busy" />
              {statusLine}
            </>
          )
        ) : null}
      </div>
      {compact ? (
        <>
          {tray ? <Dom make={() => tray.el} deps={[tray]} /> : null}
          <Dom make={() => pastes.el} deps={[pastes]} />
          {variant === 'mini' ? (
            <div className="flex items-end gap-2">
              {composer}
              {tray ? <Dom make={() => tray.picker} deps={[tray]} /> : null}
              {sendBtn}
            </div>
          ) : (
            <div className="dock-composer relative">
              {composer}
              <div className={`${COMPOSER_BTNS} items-center px-2 pt-1 pb-2`} style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                {p.footer ? <span className="mr-auto min-w-0"><Dom make={() => p.footer!} deps={[p.footer]} /></span> : null}
                {tray ? <Dom make={() => tray.picker} deps={[tray]} /> : null}
                {sendBtn}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="composer">
          {/* files, the box and its buttons, and the model: the width comes from the column the page puts this in */}
          <div>
            {tray ? <Dom make={() => tray.el} deps={[tray]} /> : null}
            <Dom make={() => pastes.el} deps={[pastes]} />
            <div className="dock-composer relative">
              {composer}
              <div className={`${COMPOSER_BTNS} items-center px-2 pt-1 pb-2`} style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                {p.footer ? <span className="mr-auto inline-flex min-w-0 items-center [&_.model-chip]:h-7 [&_.model-chip]:rounded-ctl [&_.model-chip]:border-transparent [&_.model-chip]:bg-transparent [&_.model-chip]:px-2 [&_.model-chip]:py-0 [&_.model-chip]:text-dim [&_.model-chip]:hover:bg-panel-2 [&_.model-chip]:hover:text-ink"><Dom make={() => p.footer!} deps={[p.footer]} /></span> : null}
                {tray ? <Dom make={() => tray.picker} deps={[tray]} /> : null}
                {sendBtn}
              </div>
            </div>
          </div>
        </div>
      )}
      </Handoffs.Provider>
    </ChatProject.Provider>
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
