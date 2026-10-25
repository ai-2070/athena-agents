// One agent's chat, for the floating chat window: its latest conversation, streaming replies,
// tools it uses (with images), approvals it waits on, and a composer with Stop.
import { h, mount, state, GET, POST, attempt, md, onEvent, onState, navigate, approvalCard } from './core.js';
import { icon } from './icons.js';
import { modelChip } from './models.js';

export function renderAgentChat(container, agentId) {
  const C = { chatId: null, items: [], stream: null, status: '', alive: true };
  const agent = () => state.data?.agents.find((a) => a.id === agentId);
  const list = h('div.ac-list');
  const statusEl = h('div.ac-status');
  const approvalsEl = h('div.ac-approvals');
  const input = h('textarea.ac-input', { rows: 2, placeholder: `Message ${agent()?.name || 'the agent'}…  (Enter to send, Shift+Enter for a new line)` });
  const sendBtn = h('button.btn.small', { onclick: () => send(), title: 'Send (Enter)' }, icon('send', 14));
  const stopBtn = h('button.btn.danger.small.hidden', { onclick: () => stop() }, icon('square', 13), 'Stop');
  const chipBox = h('span.ac-model');
  const bar = h(
    'div.ac-bar',
    chipBox,
    h('span.grow'),
    h('button.btn.tiny.ghost', { title: 'Start a fresh conversation', onclick: () => fresh() }, icon('plus', 13), 'New chat'),
    h('button.btn.tiny.ghost', { title: 'Open the full chat page', onclick: () => navigate(C.chatId ? `#/agents/${agentId}/${C.chatId}` : `#/agents/${agentId}`) }, icon('maximize-2', 13), 'Full page'),
  );
  mount(container, h('div.ac', bar, list, approvalsEl, statusEl, h('div.ac-compose', input, sendBtn, stopBtn)));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  const running = () => state.data?.runs.find((r) => r.agentId === agentId && (!C.chatId || r.chatId === C.chatId));
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
              if (i.type === 'user') return h('div.ac-msg.user', h('div.ac-text', i.text));
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

  const load = async (chatId = null) => {
    let id = chatId;
    if (!id) {
      const chats = await GET(`/agents/${agentId}/chats`).catch(() => []);
      // its own conversations, not the sessions it keeps for each team chat
      id = chats.find((c) => !/^Team: /.test(c.title || ''))?.id || null;
    }
    C.chatId = id;
    C.items = id ? (await GET(`/agents/${agentId}/chats/${id}`).catch(() => ({ items: [] }))).items : [];
    C.stream = null;
    draw();
    drawChrome();
    list.scrollTop = list.scrollHeight;
  };

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (!C.chatId) {
      const c = await attempt(() => POST(`/agents/${agentId}/chats`));
      if (!c) return (input.value = text);
      C.chatId = c.id;
    }
    const r = await attempt(() => POST(`/agents/${agentId}/chats/${C.chatId}/messages`, { text }));
    if (!r) input.value = text;
  }
  async function stop() {
    const r = running();
    if (r) await attempt(() => POST(`/runs/${r.id}/stop`));
  }
  async function fresh() {
    const c = await attempt(() => POST(`/agents/${agentId}/chats`));
    if (c) load(c.id);
  }

  const offEv = onEvent((ev) => {
    if (!C.alive || ev.type !== 'run' || ev.agentId !== agentId) return;
    // only this conversation (team chats and handoffs run in other sessions)
    if (!C.chatId || ev.chatId !== C.chatId) return;
    const e = ev.event;
    const items = C.items;
    if (e.kind === 'start') {
      const last = items[items.length - 1];
      if (!(last?.type === 'user' && last.text === e.text)) items.push({ type: 'user', text: e.text });
      C.stream = null;
      C.status = 'Thinking…';
    } else if (e.kind === 'text') {
      if (C.stream == null || items[C.stream]?.type !== 'assistant') {
        items.push({ type: 'assistant', text: '' });
        C.stream = items.length - 1;
      }
      items[C.stream].text += e.text;
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
    },
  };
}
