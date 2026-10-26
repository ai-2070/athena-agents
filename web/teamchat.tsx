// A team's group chat: everyone's messages, who is working, @mention suggestions, reply-to, stop.
// The Brain writes here too (from 'brain'): its briefs, follow-ups, and answers to @Brain.
// React; renderTeamChat() puts it into a plain-DOM place (the chat window's tab) and hands back
// focus, mention and destroy. The message box stays uncontrolled: the paste chips, the / menu and
// mention() change its text directly, as typing does.
import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { state, GET, POST, DEL, attempt, md, ago, onEvent, confirmBox, toast } from './core.ts';
import { attachTray } from './attach.ts';
import { pasteBox } from './pastes.ts';
import { mentionPreviews } from './filepreview.ts';
import { queuedText } from '../shared/queue.ts';
import { parseCommand } from '../shared/commands.ts';
import { commandChips, slashMenu } from './chatcommands.ts';
import type { SlashMenu } from './chatcommands.ts';
import { Avatar, DomNode, Icon, mountReact, useAppState } from './ui/react.tsx';
import type { Agent, BrainBrief, LoopInfo, QueuedMessage, RunEvent, Team, TeamMessage, TeamState } from '../shared/types.ts';

// A working agent's turn (and the work behind a reply): the AI SDK pieces load when first needed.
const TurnView = lazy(() => import('./chat/TurnView.tsx').then((m) => ({ default: m.TurnView })));

/** What the server pushes as a 'team' event (ev.event). */
export type TeamEvent =
  | { kind: 'message'; message: TeamMessage }
  | ({ kind: 'state' } & TeamState)
  | { kind: 'routed'; to: string[]; why: string }
  | { kind: 'turn'; agentId: string; state: 'start' | 'end'; chatId?: string }
  | { kind: 'cleared' };
/** GET /api/teams/:id/chat */
export interface TeamChatResponse extends TeamState {
  team: Team;
  messages: TeamMessage[];
  /** each agent's own session for this team (agentId → chatId) */
  sessions?: Record<string, string>;
  /** your /goal for the team, while the Brain follows it */
  goal?: BrainBrief | null;
}
/** What renderTeamChat() hands back. */
export interface TeamChatApi {
  focus: () => void;
  mention: (name: string) => void;
  destroy: () => void;
}
interface TeamChatOptions {
  height?: number;
  fill?: boolean;
}
/** The chat as it stands: changed by the first load and by live events, then drawn. */
interface TeamChatData {
  team: Team | null;
  messages: TeamMessage[];
  working: string[];
  queued: string[];
  /** your /queue messages, posted when nobody is working (the server keeps them) */
  held: QueuedMessage[];
  /** your /loop and /goal here */
  loop: LoopInfo | null;
  goal: BrainBrief | null;
  activity: Record<string, string>;
  /** each agent's own session for this team (agentId → chatId): where its turn streams from */
  sessions: Record<string, string>;
  /** whose turn is going now, by the turn events (a state update can lag behind a turn's end) */
  turning: Set<string>;
}
interface MentionOption {
  label: string;
  a?: Agent;
}

const PLACEHOLDER = 'Message the team… type @ to mention someone';
const blank = (): TeamChatData => ({ team: null, messages: [], working: [], queued: [], held: [], loop: null, goal: null, activity: {}, sessions: {}, turning: new Set() });
const agentOf = (id: string) => state.data?.agents.find((a) => a.id === id);

// The first GET's messages, plus what live events added meanwhile. After a clear the snapshot may be from before it, so only the live ones count.
export function mergeSnapshot(snapshot: TeamMessage[], live: TeamMessage[], clearedSince: boolean): TeamMessage[] {
  if (clearedSince) return live;
  const ids = new Set(snapshot.map((m) => m.id));
  return [...snapshot, ...live.filter((m) => !ids.has(m.id))].sort((a, b) => a.ts - b.ts);
}

/** The chat's data, kept current by its first load and live events. bump() draws it again. */
function useTeamData(teamId: string): [TeamChatData, () => void, { current: TeamChatData }] {
  const C = useRef<TeamChatData>(blank());
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    let alive = true;
    const c = (C.current = blank());
    // what arrived while the first GET was on its way, so the snapshot can't undo it
    const early = { loading: true, cleared: false, state: false };
    const off = onEvent((ev) => {
      if (!alive) return;
      if (ev.type === 'team' && ev.teamId === teamId) {
        const e = ev.event as TeamEvent;
        if (e.kind === 'message' && !c.messages.some((m) => m.id === e.message.id)) c.messages = [...c.messages, e.message];
        if (e.kind === 'state') {
          Object.assign(c, { working: e.working, queued: e.queued, held: e.held || [], loop: e.loop || null });
          early.state ||= early.loading;
        }
        if (e.kind === 'cleared') {
          // (the agents' sessions are gone with it)
          Object.assign(c, { messages: [], sessions: {}, working: [], held: [], loop: null, turning: new Set() });
          early.cleared ||= early.loading;
        }
        if (e.kind === 'turn' && e.state === 'start') {
          if (e.chatId) c.sessions = { ...c.sessions, [e.agentId]: e.chatId };
          c.turning = new Set(c.turning).add(e.agentId);
        }
        if (e.kind === 'turn' && e.state === 'end') {
          const { [e.agentId]: _gone, ...rest } = c.activity;
          c.activity = rest;
          const next = new Set(c.turning);
          next.delete(e.agentId);
          c.turning = next;
        }
        bump();
      }
      // your /goal: the Brain followed up, or it is reached, stuck or dropped
      if (ev.type === 'brief') {
        const b = ev.brief as BrainBrief;
        if (b.kind !== 'team' || b.targetId !== teamId || !b.goal) return;
        if (b.status === 'open') c.goal = b;
        else if (c.goal?.id === b.id) c.goal = null;
        bump();
      }
      // what a working member is doing right now
      if (ev.type === 'run' && c.working.includes(ev.agentId as string)) {
        const run = ev.event as RunEvent;
        const doing = run.kind === 'tool' ? run.name.replace(/^mcp__dashboard__/, '').replace(/_/g, ' ') : run.kind === 'text' ? 'writing' : null;
        if (doing && c.activity[ev.agentId as string] !== doing) {
          c.activity = { ...c.activity, [ev.agentId as string]: doing };
          bump();
        }
      }
    });
    GET<TeamChatResponse>(`/teams/${teamId}/chat`)
      .then((r) => {
        if (!alive) return;
        c.team = r.team;
        c.messages = mergeSnapshot(r.messages, c.messages, early.cleared);
        // (cleared while it loaded: the snapshot's sessions and who was working are from before)
        if (!early.cleared) {
          c.sessions = { ...(r.sessions || {}), ...c.sessions };
          // who was already working when this opened: their turns are going now
          c.turning = new Set([...c.turning, ...r.working]);
        }
        if (!early.state && !early.cleared) Object.assign(c, { working: r.working, queued: r.queued, held: r.held || [], loop: r.loop || null });
        c.goal ||= r.goal || null;
        bump();
      })
      .catch(() => {})
      .finally(() => (early.loading = false));
    return () => {
      alive = false;
      off();
    };
  }, [teamId, bump]);
  return [C.current, bump, C];
}

// "5m ago" moves on by itself: one clock for every message, ticking while any is shown
let minute = 0;
const clock = (tick: () => void) => {
  const t = setInterval(() => ((minute = Date.now()), tick()), 30_000);
  return () => clearInterval(t);
};
function Ago({ ts }: { ts: number }) {
  useSyncExternalStore(clock, () => minute);
  return <span className="hint">{ago(ts)}</span>;
}

/** A message's text with @Names picked out (not inside code). */
function textWithMentions(text: string, names: readonly string[]): HTMLElement {
  const el = md(text);
  el.className = 'tc-text';
  const all = [...names, 'everyone', 'Brain'].sort((a, b) => b.length - a.length);
  const re = new RegExp(`@(${all.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const walk = (node: Node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3 && re.test(child.textContent!)) {
        re.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        child.textContent!.replace(re, (m: string, _n: string, idx: number) => {
          const tag = document.createElement('span');
          tag.className = 'tc-mention';
          tag.textContent = m;
          frag.append(child.textContent!.slice(last, idx), tag);
          last = idx + m.length;
          return m;
        });
        frag.append(child.textContent!.slice(last));
        child.replaceWith(frag);
      } else if (child.nodeType === 1 && (child as Element).tagName !== 'CODE' && (child as Element).tagName !== 'PRE') walk(child);
    }
  };
  walk(el);
  return el;
}

/** "Show the work": the steps and tool calls behind a reply, loaded when opened. */
function Work({ m }: { m: TeamMessage }) {
  const [opened, setOpened] = useState(false);
  const turn = m.turn!;
  return (
    <details className="tc-work" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && setOpened(true)}>
      <summary>
        <Icon name="wrench" size={12} />
        Show the work
      </summary>
      <div className="tc-work-body">
        {opened ? (
          <Suspense fallback={null}>
            <TurnView agentId={m.from} chatId={turn.chatId} from={turn.from} to={turn.to} empty="No steps were saved for this reply." />
          </Suspense>
        ) : null}
      </div>
    </details>
  );
}

/** One message. Memo: a message drawn once stays as it is while others arrive or stream in. */
const Message = memo(function Message({ m, parent, author, lead, names, onReply }: { m: TeamMessage; parent: TeamMessage | null; author: Agent | undefined; lead: boolean; names: string; onReply: (m: TeamMessage) => void }) {
  if (m.from === 'system') return <div className="tc-sys">{m.text}</div>;
  const brain = m.from === 'brain';
  const nameOf = (from: string) => (from === 'user' ? 'You' : from === 'brain' ? 'Brain' : agentOf(from)?.name || '');
  return (
    <div className={`tc-msg${m.from === 'user' ? ' me' : ''}`}>
      <div className="tc-who">
        {author ? (
          <Avatar agent={author} />
        ) : brain ? (
          <div className="avatar brain-av"><Icon name="brain" size={14} /></div>
        ) : (
          <div className="avatar tc-you"><Icon name="users" size={14} /></div>
        )}
        <b>{author ? author.name : brain ? 'Brain' : m.from === 'user' ? 'You' : 'Someone'}</b>
        {lead ? <span className="tc-lead">★ lead</span> : null}
        <Ago ts={m.ts} />
        <span className="grow" />
        {author ? (
          <button className="tc-act" title={`Reply to ${author.name}`} aria-label={`Reply to ${author.name}`} onClick={() => onReply(m)}>
            <Icon name="message-circle" size={13} />
          </button>
        ) : null}
      </div>
      {parent ? <div className="tc-quote">{`↪ ${nameOf(parent.from)}: ${String(parent.text).slice(0, 90)}`}</div> : null}
      {m.text ? <DomNode className="dom-contents" make={() => textWithMentions(m.text, names ? names.split('\n') : [])} deps={[m.text, names]} /> : null}
      <DomNode className="dom-contents" make={() => mentionPreviews(m.text, m.attachments, { compact: true, key: `team:${m.id}` })} deps={[m.id, m.text, JSON.stringify(m.attachments || [])]} />
      {m.turn && m.from !== 'user' && m.from !== 'system' ? <Work m={m} /> : null}
      {m.mentions?.length && m.from !== 'user' ? (
        <div className="tc-handoff">
          <Icon name="send" size={11} />
          {`handed to ${m.mentions.map((id) => agentOf(id)?.name).filter(Boolean).join(', ')}`}
        </div>
      ) : null}
    </div>
  );
});

/** A working agent's turn, streamed in as it goes (its text and tool calls). */
function LiveTurn({ agentId, chatId }: { agentId: string; chatId: string }) {
  const a = agentOf(agentId);
  return (
    <div className="tc-msg tc-live">
      <div className="tc-who">
        {a ? <Avatar agent={a} /> : <div className="avatar"><Icon name="bot" size={14} /></div>}
        <b>{a?.name || 'Agent'}</b>
        <span className="hint">working…</span>
      </div>
      <div className="tc-live-body">
        <Suspense fallback={null}>
          <TurnView agentId={agentId} chatId={chatId} live />
        </Suspense>
      </div>
    </div>
  );
}

/** The parts the box shares with renderTeamChat's focus() and mention(). */
interface BoxRef {
  input: HTMLTextAreaElement | null;
}

function TeamChat({ teamId, height, fill, box }: { teamId: string; height: number; fill: boolean; box: BoxRef }) {
  useAppState(); // (names, avatars and who is lead follow the app state)
  const [C, bump, store] = useTeamData(teamId);
  const [replyTo, setReplyTo] = useState<TeamMessage | null>(null);
  const [suggest, setSuggest] = useState<{ start: number; opts: MentionOption[]; index: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [slash, setSlash] = useState<SlashMenu | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const chips = useRef<HTMLDivElement>(null);
  const tray = useMemo(() => attachTray(), []);
  // long pasted text, folded into a chip until it is sent
  const pastes = useMemo(() => pasteBox(), []);
  const sending = useRef(false);

  const members = (C.team?.members || []).map(agentOf).filter((a): a is Agent => Boolean(a));
  const names = members.map((a) => a.name).join('\n');
  const busy = [...C.working, ...C.queued.filter((q) => !C.working.includes(q))];

  // ---- staying at the newest message: by where you scrolled, not measured at a redraw (a live turn or a
  // preview grows between redraws). While you are at the bottom, it follows anything that grows.
  const stick = useRef(true);
  const follow = useCallback(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, []);
  useLayoutEffect(follow);
  useEffect(() => {
    const el = list.current!;
    const grows = new MutationObserver(follow);
    grows.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener('load', follow, true);
    el.addEventListener('loadedmetadata', follow, true);
    return () => {
      grows.disconnect();
      el.removeEventListener('load', follow, true);
      el.removeEventListener('loadedmetadata', follow, true);
    };
  }, [follow]);

  // ---- your /loop and /goal (× ends one)
  const chipsSig = JSON.stringify([C.loop, C.goal?.id, C.goal?.followUps]);
  useEffect(() => {
    if (!chips.current) return;
    commandChips(chips.current, {
      loop: store.current.loop,
      goal: store.current.goal,
      onStopLoop: () => void attempt(() => DEL(`/teams/${teamId}/loop`)),
      onClearGoal: () => void attempt(() => DEL(`/teams/${teamId}/goal`)).then((r) => r && ((store.current.goal = null), bump())),
    });
  }, [chipsSig, teamId, store, bump]);

  const unqueue = (q: QueuedMessage) => {
    store.current.held = store.current.held.filter((x) => x.id !== q.id);
    bump();
    void attempt(() => DEL(`/teams/${teamId}/queue/${q.id}`));
  };
  const stop = async () => {
    const r = await attempt(() => POST<{ unqueued?: QueuedMessage[] }>(`/teams/${teamId}/stop`));
    // what you queued comes back to the box, so stopping never loses it
    const back = r?.unqueued || [];
    if (back.length) pastes.restore(back.map((q) => q.text).filter(Boolean).join('\n\n'));
    if (back.some((q) => q.attachments?.length)) toast('Your queued messages are back in the box. Attach their files again.');
  };
  const reply = useCallback((m: TeamMessage | null) => {
    setReplyTo(m);
    if (m) input.current?.focus();
  }, []);
  const clear = async () => {
    if (!(await confirmBox('Clear this team chat? Each agent also forgets the conversation.', { ok: 'Clear', danger: true }))) return;
    await attempt(() => POST(`/teams/${teamId}/clear`));
  };
  const held = (q: QueuedMessage | undefined) => {
    if (q && !store.current.held.some((x) => x.id === q.id)) {
      store.current.held = [...store.current.held, q];
      bump();
    }
  };
  const emptyBox = () => {
    input.current!.value = '';
    slashRef.current?.update();
    pastes.sync();
  };

  // /stop, /resume, /resend, /goal: done now (files in the tray stay for your next message)
  const command = async (name: string, rest: string, typed: string) => {
    emptyBox();
    if (name === 'stop') return stop();
    if (name === 'goal' && !rest) {
      const r = await attempt(() => GET<TeamChatResponse>(`/teams/${teamId}/chat`));
      return void (r && toast(r.goal ? `Goal: ${r.goal.goal || r.goal.text}` : 'No goal yet. Type /goal and what done looks like.'));
    }
    type Done = { goal?: BrainBrief | null; queued?: QueuedMessage };
    const r = await attempt(() => POST<Done>(`/teams/${teamId}/${name}`, name === 'goal' ? { text: rest } : {}));
    if (!r) return pastes.restore(typed);
    if (name === 'goal') {
      store.current.goal = r.goal || null;
      bump();
    }
    held(r.queued);
  };

  const send = async () => {
    const box = input.current!;
    // (with pasted text put back: a long goal pasted in goes in full)
    const now = parseCommand(pastes.text(), 'team');
    if (now && ['stop', 'resume', 'resend', 'goal'].includes(now.name)) return command(now.name, now.rest, pastes.text().trim());
    if ((!box.value.trim() && !tray.count()) || sending.current) return;
    sending.current = true;
    try {
      if (tray.busy()) setUploading(true);
      const attachments = await tray.ready();
      setUploading(false);
      if (!attachments) return;
      // what is in the box now (more may have been typed while the files uploaded)
      const typed = pastes.text().trim();
      // "/loop [15m] [5x] …": posted again and again (with the files), or /loop off
      const cmd = parseCommand(typed, 'team');
      if (cmd?.name === 'loop') {
        emptyBox();
        const taken = tray.take();
        const r = await attempt(() => POST<{ loop: LoopInfo | null }>(`/teams/${teamId}/loop`, { text: cmd.rest, attachments }));
        if (!r) return void (pastes.restore(typed), tray.put(taken));
        store.current.loop = r.loop;
        return bump();
      }
      if (cmd && cmd.name !== 'queue') return command(cmd.name, cmd.rest, typed);
      // "/queue …": posted once nobody is working (now, if nobody is)
      const queued = queuedText(typed);
      const text = queued ?? typed;
      if (!text && !attachments.length) return void (typed && toast('Write the message after /queue'));
      emptyBox();
      const taken = tray.take();
      const body = { text, replyTo: replyRef.current?.id || null, attachments };
      type Sent = { message?: TeamMessage; queued?: QueuedMessage };
      const r = await attempt((): Promise<Sent> => (queued != null ? POST<Sent>(`/teams/${teamId}/queue`, body) : POST<TeamMessage>(`/teams/${teamId}/messages`, body).then((message) => ({ message }))));
      if (!r) {
        pastes.restore(typed);
        tray.put(taken);
        return;
      }
      setReplyTo(null);
      held(r.queued);
    } finally {
      sending.current = false;
    }
  };
  // the box's own listeners (native: the paste chips and the / menu change its text as typing does) read these
  const sendRef = useRef(send);
  sendRef.current = send;
  const replyRef = useRef(replyTo);
  replyRef.current = replyTo;
  const membersRef = useRef(members);
  membersRef.current = members;
  const slashRef = useRef<SlashMenu | null>(null);
  const suggestRef = useRef(suggest);
  suggestRef.current = suggest;

  const pick = (o: MentionOption) => {
    const ta = input.current!;
    const pos = ta.selectionStart;
    const m = /(^|\s)@([\w .-]{0,30})$/.exec(ta.value.slice(0, pos));
    if (!m) return;
    const start = pos - m[2].length - 1;
    ta.value = `${ta.value.slice(0, start)}@${o.label} ${ta.value.slice(pos)}`;
    const caret = start + o.label.length + 2;
    ta.setSelectionRange(caret, caret);
    setSuggest(null);
    ta.focus();
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;

  // ---- the box: @ suggestions, the / menu, Enter to send
  useEffect(() => {
    const ta = input.current!;
    box.input = ta;
    const menu = slashMenu(ta, 'team', { run: () => void sendRef.current() });
    slashRef.current = menu;
    setSlash(menu);
    const offPastes = pastes.attach(ta);
    const find = (index = 0): { start: number; opts: MentionOption[]; index: number } | null => {
      const pos = ta.selectionStart;
      const m = /(^|\s)@([\w .-]{0,30})$/.exec(ta.value.slice(0, pos));
      if (!m) return null;
      const q = m[2].toLowerCase();
      const opts: MentionOption[] = [...membersRef.current.map((a) => ({ label: a.name, a })), { label: 'everyone' }, { label: 'Brain' }].filter((o) => o.label.toLowerCase().startsWith(q) || o.label.toLowerCase().includes(q));
      return opts.length ? { start: pos - m[2].length - 1, opts, index: Math.min(index, opts.length - 1) } : null;
    };
    const onInput = () => {
      setSuggest(find());
      menu.update();
    };
    const onKey = (e: KeyboardEvent) => {
      if (menu.key(e)) return void e.stopPropagation();
      const s = suggestRef.current && find(suggestRef.current.index);
      if (s && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setSuggest({ ...s, index: (s.index + (e.key === 'ArrowDown' ? 1 : -1) + s.opts.length) % s.opts.length });
        return;
      }
      if (s && (e.key === 'Tab' || e.key === 'Enter')) {
        e.preventDefault();
        pickRef.current(s.opts[s.index]);
        return;
      }
      if (e.key === 'Escape' && suggestRef.current) return e.preventDefault(), setSuggest(null);
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void sendRef.current();
      }
      e.stopPropagation();
    };
    ta.addEventListener('input', onInput);
    ta.addEventListener('keydown', onKey);
    return () => {
      ta.removeEventListener('input', onInput);
      ta.removeEventListener('keydown', onKey);
      offPastes();
      if (box.input === ta) box.input = null;
    };
  }, [pastes, box]);

  // ---- files: dropped on the chat, and gone with it
  useEffect(() => {
    const off = tray.dropZone(root.current!, 'Drop files or folders for the team');
    return () => {
      off();
      // the tab closed: unsent attachments go too
      tray.discard();
    };
  }, [tray]);

  const turns = [...C.turning].filter((id) => C.sessions[id]);
  const lead = C.team?.lead;
  return (
    <div className={`tc${fill ? ' fill' : ''}`} ref={root}>
      <div
        className="tc-list"
        ref={list}
        style={fill ? undefined : { maxHeight: `${height}px` }}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {C.messages.length ? (
          C.messages.map((m) => (
            <Message
              key={m.id}
              m={m}
              parent={m.replyTo ? C.messages.find((x) => x.id === m.replyTo) || null : null}
              author={m.from === 'user' || m.from === 'system' || m.from === 'brain' ? undefined : agentOf(m.from)}
              lead={!!lead && lead === m.from}
              names={names}
              onReply={reply}
            />
          ))
        ) : (
          <div className="tc-empty">
            <Icon name="message-square" size={22} />
            <p>{lead ? `Write to the team. ${agentOf(lead)?.name} (lead) takes it and brings in the others.` : 'Write to the team. The best fit answers, or @mention someone.'}</p>
          </div>
        )}
        {/* whose turn is going now, streaming in, after the messages */}
        {turns.map((id) => (
          <LiveTurn key={`${id}:${C.sessions[id]}`} agentId={id} chatId={C.sessions[id]} />
        ))}
      </div>
      <div className="cmd-chips compact hidden" ref={chips} />
      <div className={`queued-list compact${C.held.length ? '' : ' hidden'}`}>
        {C.held.length ? <div className="queued-head">Sends when the team is done</div> : null}
        {C.held.map((q) => (
          <div key={q.id} className="queued-msg">
            <Icon name="clock" size={12} />
            <span className="queued-text">{q.text || `${q.attachments?.length || 0} file(s)`}</span>
            <button className="tc-act" title="Don't send this" aria-label="Don't send this" onClick={() => unqueue(q)}>
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>
      {/* who is working and who is next */}
      <div className="tc-status" aria-live="polite">
        {uploading ? (
          <span className="tc-typing">
            <span className="dot busy" />
            Uploading files…
          </span>
        ) : (
          <>
            {C.working.map((id) => (
              <span key={id} className="tc-typing">
                <span className="dot busy" />
                {id === 'brain' ? 'The Brain is answering…' : `${agentOf(id)?.name || 'Agent'} is working${C.activity[id] ? ` · ${C.activity[id]}` : '…'}`}
              </span>
            ))}
            {C.queued
              .filter((q) => !C.working.includes(q))
              .map((id) => (
                <span key={`q:${id}`} className="tc-typing queued">
                  <Icon name="clock" size={12} />
                  {`${agentOf(id)?.name || 'Agent'} is next`}
                </span>
              ))}
          </>
        )}
      </div>
      <div className={`tc-reply${replyTo ? '' : ' hidden'}`}>
        {replyTo ? (
          <>
            <Icon name="message-circle" size={12} />
            {`Replying to ${agentOf(replyTo.from)?.name}`}
            <button className="tc-act" aria-label="Don't reply" onClick={() => reply(null)}>
              <Icon name="x" size={12} />
            </button>
          </>
        ) : null}
      </div>
      <DomNode className="dom-contents" make={() => tray.el} deps={[tray]} />
      <DomNode className="dom-contents" make={() => pastes.el} deps={[pastes]} />
      <div className="tc-compose">
        <DomNode as="span" className="dom-contents" make={() => tray.picker} deps={[tray]} />
        <div className="tc-field">
          <textarea className="tc-input" ref={input} rows={2} aria-label="Message the team" placeholder={busy.length ? 'The team is working… /queue a message to send when it is done' : PLACEHOLDER} />
          <div className={`tc-suggest${suggest ? '' : ' hidden'}`} role="listbox" aria-label="Mention">
            {suggest?.opts.map((o, i) => (
              <button
                key={o.label}
                className={`tc-sopt${i === suggest.index ? ' on' : ''}`}
                role="option"
                aria-selected={i === suggest.index}
                onMouseDown={(e) => (e.preventDefault(), pick(o))}
              >
                {o.a ? <Avatar agent={o.a} /> : <Icon name={o.label === 'Brain' ? 'brain' : 'users'} size={14} />}
                {`@${o.label}`}
                {o.label === 'Brain' ? <span className="hint">ask the Brain</span> : null}
                {o.a?.specialty ? <span className="hint">{o.a.specialty}</span> : null}
              </button>
            ))}
          </div>
          {slash ? <DomNode as="span" className="dom-contents" make={() => slash.el} deps={[slash]} /> : null}
        </div>
        <button className="btn small" title="Send (Enter)" aria-label="Send" onClick={() => void send()}>
          <Icon name="send" size={14} />
        </button>
        <button className={`btn danger small${busy.length ? '' : ' hidden'}`} title="Stop the whole team" onClick={() => void stop()}>
          <Icon name="square" size={13} />
          Stop
        </button>
      </div>
      <div className="tc-foot">
        <span className="hint">Enter to send · @Name gives it to one agent · @everyone for all · @Brain asks the Brain · / for commands · drop or paste files to attach</span>
        <button className="btn tiny ghost" onClick={() => void clear()}>Clear chat</button>
      </div>
    </div>
  );
}

export function renderTeamChat(container: HTMLElement, teamId: string, { height = 360, fill = false }: TeamChatOptions = {}): TeamChatApi {
  const box: BoxRef = { input: null };
  const root = mountReact(container, <TeamChat teamId={teamId} height={height} fill={fill} box={box} />);
  return {
    focus: () => box.input?.focus(),
    // start a message to someone: "@Name "
    mention: (name: string) => {
      const input = box.input;
      if (!input) return;
      const tag = `@${name} `;
      if (!input.value.includes(tag)) input.value = `${tag}${input.value}`;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    destroy: () => root.unmount(),
  };
}
