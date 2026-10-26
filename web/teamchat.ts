// A team's group chat: everyone's messages, who is working, @mention suggestions, reply-to, stop.
// The Brain writes here too (from 'brain'): its briefs, follow-ups, and answers to @Brain.
// Other teams too (from 'team:<id>'): what they ask this team after a #Team Name, and their answers.
import { h, mount, state, GET, POST, DEL, attempt, md, ago, avatar, onEvent, confirmBox, toast } from './core.ts';
import { icon } from './icons.ts';
import { attachTray } from './attach.ts';
import { pasteBox } from './pastes.ts';
import { mentionPreviews } from './filepreview.ts';
import { queuedText } from '../shared/queue.ts';
import { parseCommand } from '../shared/commands.ts';
import { commandChips, slashMenu } from './chatcommands.ts';
import type { Agent, BrainBrief, LoopInfo, QueuedMessage, RunEvent, Team, TeamMessage, TeamRef, TeamState } from '../shared/types.ts';

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
  /** the other teams it can ask (#Team Name) */
  others?: TeamRef[];
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
interface TeamChatData {
  team: Team | null;
  /** the other teams (#Team Name) */
  others: TeamRef[];
  messages: TeamMessage[];
  working: string[];
  queued: string[];
  /** your /queue messages, posted when nobody is working (the server keeps them) */
  held: QueuedMessage[];
  /** your /loop and /goal here */
  loop: LoopInfo | null;
  goal: BrainBrief | null;
  replyTo: TeamMessage | null;
  activity: Record<string, string>;
  /** each agent's own session for this team (agentId → chatId): where its turn streams from */
  sessions: Record<string, string>;
  /** whose turn is going now, by the turn events (a state update can lag behind a turn's end) */
  turning: Set<string>;
  alive: boolean;
}
interface MentionOption {
  label: string;
  a?: Agent;
  /** another team, typed as #Name */
  t?: TeamRef;
}

/** Who wrote a message, in a few words (the quote above a reply). */
export function senderName(m: TeamMessage, agentName: (id: string) => string | undefined): string {
  if (m.relay) return `#${m.relay.teamName}`;
  return m.from === 'user' ? 'You' : m.from === 'brain' ? 'Brain' : m.from === 'system' ? 'System' : agentName(m.from) || '';
}

/** What highlights @Names and #Teams in a message (group 1: an @name, group 2: a #team). */
export function mentionPattern(names: string[], teams: string[]): RegExp {
  const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const longest = (xs: string[]) => [...xs].sort((a, b) => b.length - a.length).map(esc).join('|');
  return new RegExp(`@(${longest(names)})${teams.length ? `|(?<![\\w#&/])#(${longest(teams)})(?![\\w-])` : ''}`, 'gi');
}

// The first GET's messages, plus what live events added meanwhile. After a clear the snapshot may be from before it, so only the live ones count.
export function mergeSnapshot(snapshot: TeamMessage[], live: TeamMessage[], clearedSince: boolean): TeamMessage[] {
  if (clearedSince) return live;
  const ids = new Set(snapshot.map((m) => m.id));
  return [...snapshot, ...live.filter((m) => !ids.has(m.id))].sort((a, b) => a.ts - b.ts);
}

export function renderTeamChat(container: HTMLElement, teamId: string, { height = 360, fill = false }: TeamChatOptions = {}): TeamChatApi {
  const C: TeamChatData = { team: null, others: [], messages: [], working: [], queued: [], held: [], loop: null, goal: null, replyTo: null, activity: {}, sessions: {}, turning: new Set(), alive: true };
  // fill: grow with the window it sits in (the chat window); otherwise a fixed height
  const list = h('div.tc-list', fill ? {} : { style: { maxHeight: `${height}px` } });
  const status = h('div.tc-status');
  const heldEl = h('div.queued-list.compact.hidden');
  const chipsEl = h('div.cmd-chips.compact.hidden');
  const replyChip = h('div.tc-reply.hidden');
  const PLACEHOLDER = 'Message the team… type @ to mention someone';
  const input = h('textarea.tc-input', { rows: 2, placeholder: PLACEHOLDER });
  const suggest = h('div.tc-suggest.hidden');
  const slash = slashMenu(input, 'team', { run: () => void send() });
  const sendBtn = h('button.btn.small', { onclick: () => send(), title: 'Send (Enter)' }, icon('send', 14));
  const stopBtn = h('button.btn.danger.small.hidden', { onclick: () => stop(), title: 'Stop the whole team' }, icon('square', 13), 'Stop');
  const tray = attachTray();
  // long pasted text, folded into a chip until it is sent
  const pastes = pasteBox();
  const offPastes = pastes.attach(input);
  const root = h(`div.tc${fill ? '.fill' : ''}`, list, chipsEl, heldEl, status, replyChip, tray.el, pastes.el, h('div.tc-compose', tray.picker, h('div.tc-field', input, suggest, slash.el), sendBtn, stopBtn), h('div.tc-foot', h('span.hint', 'Enter to send · @Name gives it to one agent · @everyone for all · @Brain asks the Brain · #Team asks another team · / for commands · drop or paste files to attach'), h('button.btn.tiny.ghost', { onclick: clear }, 'Clear chat')));
  mount(container, root);
  const offDrop = tray.dropZone(root, 'Drop files or folders for the team');

  const agent = (id: string) => state.data?.agents.find((a) => a.id === id);

  // A working agent's turn, streamed in as it goes (its text and tool calls; web/chat/TurnView), and the
  // work behind a finished reply, opened on demand. Kept across redraws (the same element comes back).
  const loadTurns = () => import('./chat/mount.tsx');
  const live = new Map<string, { el: HTMLElement; chatId: string; destroy?: () => void }>();
  const work = new Map<string, { el: HTMLDetailsElement; destroy?: () => void }>();
  const endLive = (agentId: string) => {
    live.get(agentId)?.destroy?.();
    live.delete(agentId);
  };
  const liveTurn = (agentId: string): HTMLElement | null => {
    const chatId = C.sessions[agentId];
    if (!chatId) return null;
    let t = live.get(agentId);
    if (t && t.chatId !== chatId) endLive(agentId), (t = undefined);
    if (!t) {
      const a = agent(agentId);
      const body = h('div.tc-live-body');
      const turn: { el: HTMLElement; chatId: string; destroy?: () => void } = { el: h('div.tc-msg.tc-live', h('div.tc-who', a ? avatar(a) : h('div.avatar', icon('bot', 14)), h('b', a?.name || 'Agent'), h('span.hint', 'working…')), body), chatId };
      t = turn;
      live.set(agentId, turn);
      void loadTurns().then(({ mountTurn }) => {
        if (live.get(agentId) === turn && C.alive) turn.destroy = mountTurn(body, { agentId, chatId, live: true }).destroy;
      });
    }
    return t.el;
  };
  const workFor = (m: TeamMessage): HTMLDetailsElement | null => {
    const turn = m.turn;
    if (!turn || m.from === 'user' || m.from === 'system') return null;
    let w = work.get(m.id);
    if (!w) {
      const body = h('div.tc-work-body');
      const el = h('details.tc-work', h('summary', icon('wrench', 12), 'Show the work'), body);
      const entry: { el: HTMLDetailsElement; destroy?: () => void } = { el };
      el.addEventListener('toggle', () => {
        if (!el.open || entry.destroy) return;
        entry.destroy = () => {};
        void loadTurns().then(({ mountTurn }) => {
          if (C.alive) entry.destroy = mountTurn(body, { agentId: m.from, chatId: turn.chatId, from: turn.from, to: turn.to, empty: 'No steps were saved for this reply.' }).destroy;
        });
      });
      w = entry;
      work.set(m.id, w);
    }
    return w.el;
  };
  const dropTurns = () => {
    for (const id of [...live.keys()]) endLive(id);
    for (const w of work.values()) w.destroy?.();
    work.clear();
  };
  const members = () => (C.team?.members || []).map(agent).filter((a): a is Agent => Boolean(a));

  // highlight @Names in a message
  const renderText = (text: string) => {
    const el = md(text);
    el.className = 'tc-text';
    const re = mentionPattern(members().map((a) => a.name).concat(['everyone', 'Brain']), [...C.others.map((t) => t.name), ...(C.team ? [C.team.name] : [])]);
    const walk = (node: Node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3 && re.test(child.textContent!)) {
          re.lastIndex = 0;
          const frag = document.createDocumentFragment();
          let last = 0;
          // (the match's offset is next to last: the pattern has one group without other teams, two with)
          child.textContent!.replace(re, (m: string, ...rest: unknown[]) => {
            const idx = rest[rest.length - 2] as number;
            frag.append(child.textContent!.slice(last, idx), h(`span.tc-mention${m.startsWith('#') ? '.tc-team' : ''}`, m));
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
  };

  // Messages are built once and kept while they stay the same: redrawing the thread (each team event,
  // each word a working agent streams) must not rebuild them, or every message replays its entrance
  // and the whole thread flickers. The list is put in order in place, so kept messages never leave it.
  const shown = new Map<string, { sig: string; el: HTMLElement; when?: HTMLElement; ts: number }>();
  const messageEl = (m: TeamMessage): HTMLElement => {
    const brain = m.from === 'brain';
    const relay = m.relay;
    const t = relay ? C.others.find((x) => x.id === relay.teamId) : null;
    const a = m.from === 'user' || m.from === 'system' || brain || relay ? null : agent(m.from);
    const parent = m.replyTo ? C.messages.find((x) => x.id === m.replyTo) : null;
    // what it is drawn from (not its "5m ago": that is updated in place)
    const sig = JSON.stringify([m.text, m.attachments, m.mentions, m.turn, parent?.text, a?.name, a?.emoji, a?.color, t?.name, t?.color, t?.mark, C.team?.lead === m.from, members().map((x) => x.name), C.others.map((x) => x.name)]);
    const hit = shown.get(m.id);
    if (hit && hit.sig === sig) {
      if (hit.when) hit.when.textContent = ago(hit.ts);
      return hit.el;
    }
    if (m.from === 'system') {
      const el = h('div.tc-sys', m.text);
      shown.set(m.id, { sig, el, ts: m.ts });
      return el;
    }
    const when = h('span.hint', ago(m.ts));
    const el = h(
      `div.tc-msg${m.from === 'user' ? '.me' : ''}${relay ? '.tc-relay' : ''}`,
      relay ? { style: { '--team-color': t?.color || 'var(--ice)' } } : {},
      h(
        'div.tc-who',
        a ? avatar(a) : brain ? h('div.avatar.brain-av', icon('brain', 14)) : relay ? h('div.avatar.tc-team-av', t?.mark || '#') : h('div.avatar.tc-you', icon('users', 14)),
        h('b', a ? a.name : brain ? 'Brain' : relay ? `#${t?.name || relay.teamName}` : m.from === 'user' ? 'You' : 'Someone'),
        relay ? h('span.tc-relay-tag', relay.answers ? `answered · ${relay.byName}` : `asks this team · ${relay.byName}`) : null,
        a && a.id === C.team?.lead ? h('span.tc-lead', '★ lead') : null,
        when,
        h('span.grow'),
        a ? h('button.tc-act', { title: `Reply to ${a.name}`, onclick: () => setReply(m) }, icon('message-circle', 13)) : null,
      ),
      parent ? h('div.tc-quote', `↪ ${senderName(parent, (id) => agent(id)?.name)}: ${String(parent.text).slice(0, 90)}`) : null,
      m.text ? renderText(m.text) : null,
      mentionPreviews(m.text, m.attachments, { compact: true, key: `team:${m.id}` }),
      workFor(m),
      m.mentions?.length && m.from !== 'user' ? h('div.tc-handoff', icon('send', 11), `handed to ${m.mentions.map((id) => agent(id)?.name).filter(Boolean).join(', ')}`) : null,
    );
    shown.set(m.id, { sig, el, when, ts: m.ts });
    return el;
  };
  // the list's children in this order, moving only what is out of place (a kept node never leaves)
  const place = (nodes: Node[]) => {
    nodes.forEach((n, i) => {
      if (list.childNodes[i] !== n) list.insertBefore(n, list.childNodes[i] ?? null);
    });
    while (list.childNodes.length > nodes.length) list.lastChild!.remove();
  };
  let empty: HTMLElement | null = null;

  // Staying at the newest message: by where you scrolled, not measured at a redraw (a live turn or a
  // preview grows between redraws, which made a redraw think you had scrolled away). While you are at
  // the bottom, it follows anything that grows: text streaming in, a turn's steps, images loading.
  let stick = true;
  const follow = () => {
    if (stick) list.scrollTop = list.scrollHeight;
  };
  list.addEventListener('scroll', () => (stick = list.scrollHeight - list.scrollTop - list.clientHeight < 80));
  const grows = new MutationObserver(follow);
  grows.observe(list, { childList: true, subtree: true, characterData: true });
  list.addEventListener('load', follow, true);
  list.addEventListener('loadedmetadata', follow, true);

  // who is working and who is next (a working agent's live events only change this)
  const drawStatus = () => {
    if (!C.alive) return;
    const busy = [...C.working, ...C.queued.filter((q) => !C.working.includes(q))];
    mount(
      status,
      C.working.map((id) => h('span.tc-typing', h('span.dot.busy'), id === 'brain' ? 'The Brain is answering…' : `${agent(id)?.name || 'Agent'} is working${C.activity[id] ? ` · ${C.activity[id]}` : '…'}`)),
      C.queued.filter((q) => !C.working.includes(q)).map((id) => h('span.tc-typing.queued', icon('clock', 12), `${agent(id)?.name || 'Agent'} is next`)),
    );
    stopBtn.classList.toggle('hidden', !busy.length);
    input.placeholder = busy.length ? 'The team is working… /queue a message to send when it is done' : PLACEHOLDER;
    drawHeld();
    drawChips();
  };

  // your /loop and /goal (× ends one)
  let chipsSig = '';
  const drawChips = () => {
    const sig = JSON.stringify([C.loop, C.goal?.id, C.goal?.followUps]);
    if (sig === chipsSig) return;
    chipsSig = sig;
    commandChips(chipsEl, {
      loop: C.loop,
      goal: C.goal,
      onStopLoop: () => void attempt(() => DEL(`/teams/${teamId}/loop`)),
      onClearGoal: () => void attempt(() => DEL(`/teams/${teamId}/goal`)).then((r) => r && ((C.goal = null), drawChips())),
    });
  };

  // your /queue messages, in the order they will go (× takes one back)
  let heldSig = '';
  const drawHeld = () => {
    const sig = JSON.stringify(C.held.map((q) => q.id));
    if (sig === heldSig) return;
    heldSig = sig;
    heldEl.classList.toggle('hidden', !C.held.length);
    mount(
      heldEl,
      C.held.length ? h('div.queued-head', 'Sends when the team is done') : null,
      C.held.map((q) =>
        h(
          'div.queued-msg',
          icon('clock', 12),
          h('span.queued-text', q.text || `${q.attachments?.length || 0} file(s)`),
          h('button.tc-act', { title: "Don't send this", 'aria-label': "Don't send this", onclick: () => unqueue(q) }, icon('x', 12)),
        ),
      ),
    );
  };
  const unqueue = (q: QueuedMessage) => {
    C.held = C.held.filter((x) => x.id !== q.id);
    drawHeld();
    void attempt(() => DEL(`/teams/${teamId}/queue/${q.id}`));
  };
  const stop = async () => {
    const r = await attempt(() => POST<{ unqueued?: QueuedMessage[] }>(`/teams/${teamId}/stop`));
    // what you queued comes back to the box, so stopping never loses it
    const back = r?.unqueued || [];
    if (back.length) pastes.restore(back.map((q) => q.text).filter(Boolean).join('\n\n'));
    if (back.some((q) => q.attachments?.length)) toast('Your queued messages are back in the box. Attach their files again.');
  };

  // (at most once a frame, however many events come)
  let frame = 0;
  const draw = () => {
    if (!C.alive || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawNow();
    });
  };
  const drawNow = () => {
    if (!C.alive) return;
    for (const id of [...shown.keys()]) if (!C.messages.some((m) => m.id === id)) shown.delete(id);
    empty = C.messages.length ? null : empty || h('div.tc-empty', icon('message-square', 22), h('p', C.team?.lead ? `Write to the team. ${agent(C.team.lead)?.name} (lead) takes it and brings in the others.` : 'Write to the team. The best fit answers, or @mention someone.'));
    // whose turn is going now, streaming in, after the messages
    const turns = [...C.turning].map(liveTurn).filter((x): x is HTMLElement => !!x);
    place([...(empty ? [empty] : C.messages.map(messageEl)), ...turns]);
    for (const id of [...live.keys()]) if (!C.turning.has(id)) endLive(id);
    follow();
    drawStatus();
  };

  const setReply = (m: TeamMessage | null) => {
    C.replyTo = m;
    replyChip.classList.toggle('hidden', !m);
    if (!m) return mount(replyChip);
    mount(replyChip, icon('message-circle', 12), `Replying to ${agent(m.from)?.name}`, h('button.tc-act', { onclick: () => setReply(null) }, icon('x', 12)));
    input.focus();
  };

  // @ suggestions
  let sIndex = 0;
  const suggestions = (): { start: number; opts: MentionOption[] } | null => {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const m = /(^|\s)([@#])([\w .-]{0,30})$/.exec(before);
    if (!m) return null;
    const q = m[3].toLowerCase();
    const all: MentionOption[] = m[2] === '#' ? C.others.map((t) => ({ label: t.name, t })) : [...members().map((a) => ({ label: a.name, a })), { label: 'everyone' }, { label: 'Brain' }];
    const opts = all.filter((o) => o.label.toLowerCase().startsWith(q) || o.label.toLowerCase().includes(q));
    return { start: pos - m[3].length - 1, opts };
  };
  const drawSuggest = () => {
    const s = suggestions();
    if (!s || !s.opts.length) return suggest.classList.add('hidden');
    sIndex = Math.min(sIndex, s.opts.length - 1);
    mount(
      suggest,
      s.opts.map((o, i) =>
        h(
          `button.tc-sopt${i === sIndex ? '.on' : ''}`,
          { onmousedown: (e) => (e.preventDefault(), pickSuggest(o)) },
          o.a ? avatar(o.a) : o.t ? h('div.avatar.tc-team-av', { style: { '--team-color': o.t.color || 'var(--ice)' } }, o.t.mark || '#') : icon(o.label === 'Brain' ? 'brain' : 'users', 14),
          `${o.t ? '#' : '@'}${o.label}`,
          o.label === 'Brain' && !o.t ? h('span.hint', 'ask the Brain') : null,
          o.a?.specialty ? h('span.hint', o.a.specialty) : o.t ? h('span.hint', o.t.description || 'ask this team') : null,
        ),
      ),
    );
    suggest.classList.remove('hidden');
  };
  const pickSuggest = (o: MentionOption) => {
    const s = suggestions();
    if (!s) return;
    const pos = input.selectionStart;
    input.value = `${input.value.slice(0, s.start)}${o.t ? '#' : '@'}${o.label} ${input.value.slice(pos)}`;
    const caret = s.start + o.label.length + 2;
    input.setSelectionRange(caret, caret);
    suggest.classList.add('hidden');
    input.focus();
  };
  input.addEventListener('input', () => {
    sIndex = 0;
    drawSuggest();
    slash.update();
  });
  input.addEventListener('keydown', (e) => {
    if (slash.key(e)) return void e.stopPropagation();
    const open = !suggest.classList.contains('hidden');
    const s = open ? suggestions() : null;
    if (open && s && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      sIndex = (sIndex + (e.key === 'ArrowDown' ? 1 : -1) + s.opts.length) % s.opts.length;
      drawSuggest();
      return;
    }
    if (open && s && (e.key === 'Tab' || e.key === 'Enter')) {
      e.preventDefault();
      pickSuggest(s.opts[sIndex]);
      return;
    }
    if (e.key === 'Escape' && open) return e.preventDefault(), suggest.classList.add('hidden');
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
    e.stopPropagation();
  });

  // /stop, /resume, /resend, /goal: done now (files in the tray stay for your next message)
  async function command(name: string, rest: string, typed: string) {
    input.value = '';
    slash.update();
    pastes.sync();
    if (name === 'stop') return stop();
    if (name === 'goal' && !rest) {
      const r = await attempt(() => GET<TeamChatResponse>(`/teams/${teamId}/chat`));
      return void (r && toast(r.goal ? `Goal: ${r.goal.goal || r.goal.text}` : 'No goal yet. Type /goal and what done looks like.'));
    }
    type Done = { goal?: BrainBrief | null; queued?: QueuedMessage };
    const r = await attempt(() => POST<Done>(`/teams/${teamId}/${name}`, name === 'goal' ? { text: rest } : {}));
    if (!r) return pastes.restore(typed);
    if (name === 'goal') {
      C.goal = r.goal || null;
      drawChips();
    }
    const held = r.queued;
    if (held && !C.held.some((q) => q.id === held.id)) {
      C.held = [...C.held, held];
      drawHeld();
    }
  }

  let sending = false;
  async function send() {
    // (with pasted text put back: a long goal pasted in goes in full)
    const now = parseCommand(pastes.text(), 'team');
    if (now && ['stop', 'resume', 'resend', 'goal'].includes(now.name)) return command(now.name, now.rest, pastes.text().trim());
    if ((!input.value.trim() && !tray.count()) || sending) return;
    sending = true;
    try {
      if (tray.busy()) mount(status, h('span.tc-typing', h('span.dot.busy'), 'Uploading files…'));
      const attachments = await tray.ready();
      draw();
      if (!attachments) return;
      // what is in the box now (more may have been typed while the files uploaded)
      const typed = pastes.text().trim();
      // "/loop [15m] [5x] …": posted again and again (with the files), or /loop off
      const cmd = parseCommand(typed, 'team');
      if (cmd?.name === 'loop') {
        input.value = '';
        slash.update();
        pastes.sync();
        const taken = tray.take();
        const r = await attempt(() => POST<{ loop: LoopInfo | null }>(`/teams/${teamId}/loop`, { text: cmd.rest, attachments }));
        if (!r) return void (pastes.restore(typed), tray.put(taken));
        C.loop = r.loop;
        return drawChips();
      }
      if (cmd && cmd.name !== 'queue') return command(cmd.name, cmd.rest, typed);
      // "/queue …": posted once nobody is working (now, if nobody is)
      const queued = queuedText(typed);
      const text = queued ?? typed;
      if (!text && !attachments.length) return void (typed && toast('Write the message after /queue'));
      input.value = '';
      slash.update();
      pastes.sync();
      const taken = tray.take();
      const body = { text, replyTo: C.replyTo?.id || null, attachments };
      type Sent = { message?: TeamMessage; queued?: QueuedMessage };
      const r = await attempt((): Promise<Sent> => (queued != null ? POST<Sent>(`/teams/${teamId}/queue`, body) : POST<TeamMessage>(`/teams/${teamId}/messages`, body).then((message) => ({ message }))));
      if (!r) {
        pastes.restore(typed);
        tray.put(taken);
        return;
      }
      setReply(null);
      const held = r.queued;
      if (held && !C.held.some((q) => q.id === held.id)) {
        C.held = [...C.held, held];
        drawHeld();
      }
    } finally {
      sending = false;
    }
  }

  async function clear() {
    if (!(await confirmBox('Clear this team chat? Each agent also forgets the conversation.', { ok: 'Clear', danger: true }))) return;
    await attempt(() => POST(`/teams/${teamId}/clear`));
  }

  // what arrived while the first GET was on its way, so the snapshot can't undo it
  const early = { loading: true, cleared: false, state: false };
  const off = onEvent((ev) => {
    if (!C.alive) return;
    if (ev.type === 'team' && ev.teamId === teamId) {
      const e = ev.event as TeamEvent;
      if (e.kind === 'message' && !C.messages.some((m) => m.id === e.message.id)) C.messages.push(e.message);
      if (e.kind === 'state') {
        Object.assign(C, { working: e.working, queued: e.queued, held: e.held || [], loop: e.loop || null });
        early.state ||= early.loading;
      }
      if (e.kind === 'cleared') {
        // (the agents' sessions are gone with it)
        C.messages = [];
        C.sessions = {};
        C.working = [];
        C.held = [];
        C.loop = null;
        C.turning.clear();
        dropTurns();
        early.cleared ||= early.loading;
      }
      if (e.kind === 'turn' && e.state === 'start') {
        if (e.chatId) C.sessions[e.agentId] = e.chatId;
        C.turning.add(e.agentId);
      }
      if (e.kind === 'turn' && e.state === 'end') {
        delete C.activity[e.agentId];
        C.turning.delete(e.agentId);
        endLive(e.agentId);
      }
      draw();
    }
    // your /goal: the Brain followed up, or it is reached, stuck or dropped
    if (ev.type === 'brief') {
      const b = ev.brief as BrainBrief;
      if (b.kind !== 'team' || b.targetId !== teamId || !b.goal) return;
      if (b.status === 'open') C.goal = b;
      else if (C.goal?.id === b.id) C.goal = null;
      drawChips();
    }
    // what a working member is doing right now
    if (ev.type === 'run' && C.working.includes(ev.agentId as string)) {
      const agentId = ev.agentId as string;
      const run = ev.event as RunEvent;
      if (run.kind === 'tool') C.activity[agentId] = run.name.replace(/^mcp__dashboard__/, '').replace(/_/g, ' ');
      else if (run.kind === 'text') C.activity[agentId] = 'writing';
      // (only the status line: the thread itself didn't change)
      drawStatus();
    }
  });

  GET<TeamChatResponse>(`/teams/${teamId}/chat`)
    .then((r) => {
      C.team = r.team;
      C.others = r.others || [];
      C.messages = mergeSnapshot(r.messages, C.messages, early.cleared);
      // (cleared while it loaded: the snapshot's sessions and who was working are from before)
      if (!early.cleared) {
        C.sessions = { ...(r.sessions || {}), ...C.sessions };
        // who was already working when this opened: their turns are going now
        for (const id of r.working) C.turning.add(id);
      }
      if (!early.state && !early.cleared) Object.assign(C, { working: r.working, queued: r.queued, held: r.held || [], loop: r.loop || null });
      C.goal ||= r.goal || null;
      draw();
    })
    .catch(() => {})
    .finally(() => (early.loading = false));
  draw();
  return {
    focus: () => input.focus(),
    // start a message to someone: "@Name "
    mention: (name: string) => {
      const tag = `@${name} `;
      if (!input.value.includes(tag)) input.value = `${tag}${input.value}`;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    destroy: () => {
      C.alive = false;
      cancelAnimationFrame(frame);
      grows.disconnect();
      dropTurns();
      off();
      offDrop();
      offPastes();
      // the tab closed: unsent attachments go too
      tray.discard();
    },
  };
}
