// A team's group chat: everyone's messages, who is working, @mention suggestions, reply-to, stop.
import { h, mount, state, GET, POST, attempt, md, ago, avatar, onEvent, confirmBox } from './core.ts';
import { icon } from './icons.ts';
import type { Agent, RunEvent, Team, TeamMessage, TeamState } from '../shared/types.ts';

/** What the server pushes as a 'team' event (ev.event). */
export type TeamEvent =
  | { kind: 'message'; message: TeamMessage }
  | ({ kind: 'state' } & TeamState)
  | { kind: 'routed'; to: string[]; why: string }
  | { kind: 'turn'; agentId: string; state: 'start' | 'end' }
  | { kind: 'cleared' };
/** GET /api/teams/:id/chat */
export interface TeamChatResponse extends TeamState {
  team: Team;
  messages: TeamMessage[];
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
  messages: TeamMessage[];
  working: string[];
  queued: string[];
  replyTo: TeamMessage | null;
  activity: Record<string, string>;
  alive: boolean;
}
interface MentionOption {
  label: string;
  a?: Agent;
}

export function renderTeamChat(container: HTMLElement, teamId: string, { height = 360, fill = false }: TeamChatOptions = {}): TeamChatApi {
  const C: TeamChatData = { team: null, messages: [], working: [], queued: [], replyTo: null, activity: {}, alive: true };
  // fill: grow with the window it sits in (the chat window); otherwise a fixed height
  const list = h('div.tc-list', fill ? {} : { style: { maxHeight: `${height}px` } });
  const status = h('div.tc-status');
  const replyChip = h('div.tc-reply.hidden');
  const input = h('textarea.tc-input', { rows: 2, placeholder: 'Message the team… type @ to mention someone' });
  const suggest = h('div.tc-suggest.hidden');
  const sendBtn = h('button.btn.small', { onclick: () => send(), title: 'Send (Enter)' }, icon('send', 14));
  const stopBtn = h('button.btn.danger.small.hidden', { onclick: () => attempt(() => POST(`/teams/${teamId}/stop`)), title: 'Stop the whole team' }, icon('square', 13), 'Stop');
  mount(
    container,
    h(`div.tc${fill ? '.fill' : ''}`, list, status, replyChip, h('div.tc-compose', h('div.tc-field', input, suggest), sendBtn, stopBtn), h('div.tc-foot', h('span.hint', 'Enter to send · @Name gives it to one agent · @everyone for all'), h('button.btn.tiny.ghost', { onclick: clear }, 'Clear chat'))),
  );

  const agent = (id: string) => state.data?.agents.find((a) => a.id === id);
  const members = () => (C.team?.members || []).map(agent).filter((a): a is Agent => Boolean(a));

  // highlight @Names in a message
  const renderText = (text: string) => {
    const el = md(text);
    el.className = 'tc-text';
    const names = members().map((a) => a.name).concat(['everyone']).sort((a, b) => b.length - a.length);
    const re = new RegExp(`@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    const walk = (node: Node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3 && re.test(child.textContent!)) {
          re.lastIndex = 0;
          const frag = document.createDocumentFragment();
          let last = 0;
          child.textContent!.replace(re, (m: string, _n: string, idx: number) => {
            frag.append(child.textContent!.slice(last, idx), h('span.tc-mention', m));
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

  const draw = () => {
    if (!C.alive) return;
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    mount(
      list,
      C.messages.length
        ? C.messages.map((m) => {
            if (m.from === 'system') return h('div.tc-sys', m.text);
            const a = m.from === 'user' ? null : agent(m.from);
            const parent = m.replyTo ? C.messages.find((x) => x.id === m.replyTo) : null;
            return h(
              `div.tc-msg${m.from === 'user' ? '.me' : ''}`,
              h(
                'div.tc-who',
                a ? avatar(a) : h('div.avatar.tc-you', icon('users', 14)),
                h('b', a ? a.name : m.from === 'user' ? 'You' : 'Someone'),
                a && a.id === C.team?.lead ? h('span.tc-lead', '★ lead') : null,
                h('span.hint', ago(m.ts)),
                h('span.grow'),
                a ? h('button.tc-act', { title: `Reply to ${a.name}`, onclick: () => setReply(m) }, icon('message-circle', 13)) : null,
              ),
              parent ? h('div.tc-quote', `↪ ${parent.from === 'user' ? 'You' : agent(parent.from)?.name || ''}: ${String(parent.text).slice(0, 90)}`) : null,
              renderText(m.text),
              m.mentions?.length && m.from !== 'user' ? h('div.tc-handoff', icon('send', 11), `handed to ${m.mentions.map((id) => agent(id)?.name).filter(Boolean).join(', ')}`) : null,
            );
          })
        : h('div.tc-empty', icon('message-square', 22), h('p', C.team?.lead ? `Write to the team. ${agent(C.team.lead)?.name} (lead) takes it and brings in the others.` : 'Write to the team. The best fit answers, or @mention someone.')),
    );
    if (near) list.scrollTop = list.scrollHeight;
    const busy = [...C.working, ...C.queued.filter((q) => !C.working.includes(q))];
    mount(
      status,
      C.working.map((id) => h('span.tc-typing', h('span.dot.busy'), `${agent(id)?.name || 'Agent'} is working${C.activity[id] ? ` · ${C.activity[id]}` : '…'}`)),
      C.queued.filter((q) => !C.working.includes(q)).map((id) => h('span.tc-typing.queued', icon('clock', 12), `${agent(id)?.name || 'Agent'} is next`)),
    );
    stopBtn.classList.toggle('hidden', !busy.length);
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
    const m = /(^|\s)@([\w .-]{0,30})$/.exec(before);
    if (!m) return null;
    const q = m[2].toLowerCase();
    const opts: MentionOption[] = [...members().map((a) => ({ label: a.name, a })), { label: 'everyone' }].filter((o) => o.label.toLowerCase().startsWith(q) || o.label.toLowerCase().includes(q));
    return { start: pos - m[2].length - 1, opts };
  };
  const drawSuggest = () => {
    const s = suggestions();
    if (!s || !s.opts.length) return suggest.classList.add('hidden');
    sIndex = Math.min(sIndex, s.opts.length - 1);
    mount(suggest, s.opts.map((o, i) => h(`button.tc-sopt${i === sIndex ? '.on' : ''}`, { onmousedown: (e) => (e.preventDefault(), pickSuggest(o)) }, o.a ? avatar(o.a) : icon('users', 14), `@${o.label}`, o.a?.specialty ? h('span.hint', o.a.specialty) : null)));
    suggest.classList.remove('hidden');
  };
  const pickSuggest = (o: MentionOption) => {
    const s = suggestions();
    if (!s) return;
    const pos = input.selectionStart;
    input.value = `${input.value.slice(0, s.start)}@${o.label} ${input.value.slice(pos)}`;
    const caret = s.start + o.label.length + 2;
    input.setSelectionRange(caret, caret);
    suggest.classList.add('hidden');
    input.focus();
  };
  input.addEventListener('input', () => {
    sIndex = 0;
    drawSuggest();
  });
  input.addEventListener('keydown', (e) => {
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

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const r = await attempt(() => POST<TeamMessage>(`/teams/${teamId}/messages`, { text, replyTo: C.replyTo?.id || null }));
    if (!r) input.value = text;
    else setReply(null);
  }

  async function clear() {
    if (!(await confirmBox('Clear this team chat? Each agent also forgets the conversation.', { ok: 'Clear', danger: true }))) return;
    await attempt(() => POST(`/teams/${teamId}/clear`));
  }

  const off = onEvent((ev) => {
    if (!C.alive) return;
    if (ev.type === 'team' && ev.teamId === teamId) {
      const e = ev.event as TeamEvent;
      if (e.kind === 'message' && !C.messages.some((m) => m.id === e.message.id)) C.messages.push(e.message);
      if (e.kind === 'state') Object.assign(C, { working: e.working, queued: e.queued });
      if (e.kind === 'cleared') C.messages = [];
      if (e.kind === 'turn' && e.state === 'end') delete C.activity[e.agentId];
      draw();
    }
    // what a working member is doing right now
    if (ev.type === 'run' && C.working.includes(ev.agentId as string)) {
      const agentId = ev.agentId as string;
      const run = ev.event as RunEvent;
      if (run.kind === 'tool') C.activity[agentId] = run.name.replace(/^mcp__dashboard__/, '').replace(/_/g, ' ');
      else if (run.kind === 'text') C.activity[agentId] = 'writing';
      draw();
    }
  });

  GET<TeamChatResponse>(`/teams/${teamId}/chat`).then((r) => {
    Object.assign(C, { team: r.team, messages: r.messages, working: r.working, queued: r.queued });
    draw();
  }).catch(() => {});
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
      off();
    },
  };
}
