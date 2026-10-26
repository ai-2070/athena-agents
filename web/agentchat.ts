// One agent's chat, for the floating chat window: its latest conversation, streaming replies,
// tools it uses (with images), approvals it waits on, and a composer with Stop.
import { h, mount, state, GET, POST, attempt, md, onEvent, onState, navigate, approvalCard } from './core.ts';
import { icon } from './icons.ts';
import { modelChip } from './models.ts';
import { attachTray, attachmentChips, restoreDraft } from './attach.ts';
import type { Chat, ChatItem, ChatSummary, RunEvent } from '../shared/types.ts';

/** What renderAgentChat() hands back. */
export interface AgentChatApi {
  focus: () => void;
  destroy: () => void;
}
interface AgentChatData {
  chatId: string | null;
  items: ChatItem[];
  /** index of the assistant message being streamed into */
  stream: number | null;
  status: string;
  alive: boolean;
}

// A session the agent keeps for a team chat (marked by teamId; chats made before that only have the title).
export const isTeamSession = (c: ChatSummary): boolean => !!c.teamId || /^Team: /.test(c.title || '');

export function renderAgentChat(container: HTMLElement, agentId: string): AgentChatApi {
  const C: AgentChatData = { chatId: null, items: [], stream: null, status: '', alive: true };
  const agent = () => state.data?.agents.find((a) => a.id === agentId);
  const list = h('div.ac-list');
  const statusEl = h('div.ac-status');
  const approvalsEl = h('div.ac-approvals');
  const input = h('textarea.ac-input', { rows: 2, placeholder: `Message ${agent()?.name || 'the agent'}…  (Enter to send, Shift+Enter for a new line)` });
  const sendBtn = h('button.btn.small', { onclick: () => send(), title: 'Send (Enter)' }, icon('send', 14));
  const stopBtn = h('button.btn.danger.small.hidden', { onclick: () => stop() }, icon('square', 13), 'Stop');
  const tray = attachTray();
  const chipBox = h('span.ac-model');
  const bar = h(
    'div.ac-bar',
    chipBox,
    h('span.grow'),
    h('button.btn.tiny.ghost', { title: 'Start a fresh conversation', onclick: () => fresh() }, icon('plus', 13), 'New chat'),
    h('button.btn.tiny.ghost', { title: 'Open the full chat page', onclick: () => navigate(C.chatId ? `#/agents/${agentId}/${C.chatId}` : `#/agents/${agentId}`) }, icon('maximize-2', 13), 'Full page'),
  );
  const root = h('div.ac', bar, list, approvalsEl, statusEl, tray.el, h('div.ac-compose', tray.picker, input, sendBtn, stopBtn));
  mount(container, root);
  const offDrop = tray.dropZone(root, `Drop files or folders for ${agent()?.name || 'the agent'}`);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // only a run in this conversation (never one of the agent's team sessions)
  const running = () => (C.chatId ? state.data?.runs.find((r) => r.agentId === agentId && r.chatId === C.chatId) : undefined);
  const drawChrome = () => {
    const a = agent();
    if (a) mount(chipBox, modelChip(a, { compact: true }));
    const r = running();
    stopBtn.classList.toggle('hidden', !r);
    sendBtn.classList.toggle('hidden', !!r);
    mount(approvalsEl, (state.data?.approvals || []).filter((x) => x.agentId === agentId).map(approvalCard));
  };

  let frame = false;
  const draw = () => {
    if (frame) return;
    frame = true;
    requestAnimationFrame(() => {
      frame = false;
      if (!C.alive) return;
      const near = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
      const items = C.items.filter((i) => i.type !== 'meta').slice(-80);
      mount(
        list,
        items.length
          ? items.map((i) => {
              if (i.type === 'user') return h('div.ac-msg.user', i.text ? h('div.ac-text', i.text) : null, attachmentChips(i.attachments));
              if (i.type === 'assistant') {
                const m = md(i.text || '');
                m.className = 'ac-text';
                return h('div.ac-msg.agent', m);
              }
              if (i.type === 'tool')
                return h(
                  'div.ac-tool',
                  { class: i.isError ? 'err' : i.status === 'running' ? 'run' : '' },
                  i.status === 'running' ? h('span.dot.busy') : h('span', i.isError ? '✕' : '✓'),
                  h('span', i.name),
                  i.images?.length ? h('div.st-imgs', i.images.slice(0, 6).map((src) => h('img', { src }))) : null,
                );
              if (i.type === 'error') return h('div.ac-msg.err', i.text);
              return null;
            })
          : h('div.ac-empty', icon('message-circle', 22), h('p', `Say hi to ${agent()?.name || 'the agent'}.`), h('p.hint', agent()?.specialty || '')),
      );
      if (near) list.scrollTop = list.scrollHeight;
      statusEl.textContent = C.status;
    });
  };

  // bumped by every load and by send() picking a chat, so a slow, older load can't overwrite a newer choice
  let seq = 0;
  const load = async (chatId: string | null = null) => {
    const my = ++seq;
    let id = chatId;
    if (!id) {
      const chats = await GET<ChatSummary[]>(`/agents/${agentId}/chats`).catch((): ChatSummary[] => []);
      if (my !== seq) return;
      // its own conversations, not the sessions it keeps for each team chat
      id = chats.find((c) => !isTeamSession(c))?.id || null;
    }
    C.chatId = id;
    const items = id ? (await GET<Chat>(`/agents/${agentId}/chats/${id}`).catch(() => ({ items: [] as ChatItem[] }))).items : [];
    if (my !== seq) return;
    C.items = items;
    C.stream = null;
    draw();
    drawChrome();
    list.scrollTop = list.scrollHeight;
  };

  let sending = false;
  async function send() {
    // busy: keep the text in the composer (the server would refuse it anyway)
    if ((!input.value.trim() && !tray.count()) || running() || sending) return;
    sending = true;
    try {
      if (tray.busy()) C.status = 'Uploading files…';
      draw();
      const attachments = await tray.ready();
      C.status = '';
      draw();
      if (!attachments) return;
      // what is in the box now (more may have been typed while the files uploaded)
      const text = input.value.trim();
      if (!text && !attachments.length) return;
      input.value = '';
      const taken = tray.take();
      const undo = () => (restoreDraft(input, text), tray.put(taken));
      if (!C.chatId) {
        const c = await attempt(() => POST<Chat>(`/agents/${agentId}/chats`));
        if (!c) return undo();
        seq++;
        C.chatId = c.id;
      }
      const r = await attempt(() => POST(`/agents/${agentId}/chats/${C.chatId}/messages`, { text, attachments }));
      if (!r) undo();
    } finally {
      sending = false;
    }
  }
  async function stop() {
    const r = running();
    if (r) await attempt(() => POST(`/runs/${r.id}/stop`));
  }
  async function fresh() {
    const c = await attempt(() => POST<Chat>(`/agents/${agentId}/chats`));
    if (c) load(c.id);
  }

  const offEv = onEvent((ev) => {
    if (!C.alive || ev.type !== 'run' || ev.agentId !== agentId) return;
    // only this conversation (team chats and handoffs run in other sessions)
    if (!C.chatId || ev.chatId !== C.chatId) return;
    const e = ev.event as RunEvent;
    const items = C.items;
    if (e.kind === 'start') {
      const last = items[items.length - 1];
      if (!(last?.type === 'user' && last.text === e.text)) items.push({ type: 'user', text: e.text, attachments: e.attachments });
      C.stream = null;
      C.status = 'Thinking…';
    } else if (e.kind === 'text') {
      if (C.stream == null || items[C.stream]?.type !== 'assistant') {
        items.push({ type: 'assistant', text: '' });
        C.stream = items.length - 1;
      }
      (items[C.stream] as Extract<ChatItem, { type: 'assistant' }>).text += e.text;
      C.status = 'Writing…';
    } else if (e.kind === 'tool') {
      C.stream = null;
      items.push({ type: 'tool', id: e.id, name: e.name, status: 'running' });
      C.status = `Using ${e.name}…`;
    } else if (e.kind === 'tool_result') {
      const it = [...items].reverse().find((x) => x.type === 'tool' && x.id === e.id);
      if (it) Object.assign(it, { status: 'done', isError: e.isError, images: e.images });
    } else if (e.kind === 'status') C.status = e.text || '';
    else if (e.kind === 'done' || e.kind === 'error') {
      C.status = '';
      // the saved chat has everything, including anything streamed before this opened
      load(C.chatId);
    }
    draw();
  });
  const offState = onState(() => C.alive && drawChrome());
  load();
  return {
    focus: () => input.focus(),
    destroy: () => {
      C.alive = false;
      offEv?.();
      offState?.();
      offDrop();
      // the tab closed: unsent attachments go too
      tray.discard();
    },
  };
}
