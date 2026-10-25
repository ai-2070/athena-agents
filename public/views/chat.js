// Chat with one agent: streaming answers, tool calls you can open, images inline.
import { h, mount, clear, state, GET, POST, PUT, DEL, attempt, avatar, engineBadge, navigate, md, ago, lightbox, confirmBox, approvalCard, onState } from '../core.js';
import { openTerminal } from './agents.js';
import { modelChip, modelInfo } from '../models.js';

export const flush = true;
export const title = () => 'Chat';

let ctx = null;

export async function render(el, params, { setTitle }) {
  const [agentId, chatId] = params;
  const agent = await GET(`/agents/${agentId}`).catch(() => null);
  if (!agent) {
    mount(el, h('div', { style: { padding: '28px' } }, h('p', 'That agent no longer exists. '), h('a', { href: '#/agents' }, 'Back to agents')));
    return;
  }
  setTitle(`${agent.emoji || ''} ${agent.name}`);
  let chats = await GET(`/agents/${agentId}/chats`);
  if (!chatId) {
    const target = chats[0] || (await POST(`/agents/${agentId}/chats`));
    location.replace(`#/agents/${agentId}/${target.id}`);
    return;
  }
  const chat = await GET(`/agents/${agentId}/chats/${chatId}`).catch(() => null);
  if (!chat) {
    location.replace(`#/agents/${agentId}`);
    return;
  }
  ctx = { el, agent, chat, chats, els: [], status: '', offState: null };
  draw();
  ctx.offState = onState(() => {
    updateRunning();
    drawApprovals();
  });
}

export function unmount() {
  ctx?.offState?.();
  ctx = null;
}

const running = () => (state.data?.runs || []).some((r) => r.chatId === ctx?.chat.id);

function draw() {
  const { el, agent, chat, chats } = ctx;
  ctx.messages = h('div.messages');
  ctx.statusEl = h('div.status-line');
  ctx.approvalsEl = h('div', { style: { padding: '0 28px' } });
  ctx.input = h('textarea', { rows: 2, placeholder: `Message ${agent.name}…` });
  ctx.sendBtn = h('button.btn', { onclick: send }, 'Send');
  ctx.stopBtn = h('button.btn.danger.hidden', { onclick: stop }, 'Stop');
  ctx.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  ctx.input.addEventListener('input', autosize);

  const chatList = h(
    'div.chat-list',
    chats.map((c) => h(`a${c.id === chat.id ? '.on' : ''}`, { href: `#/agents/${agent.id}/${c.id}` }, h('span.t', c.title || 'Chat'), h('span.w', `${ago(c.updatedAt)} · ${c.count} items`))),
  );
  const tools = agent.tools || [];
  mount(
    el,
    h(
      'div.chat-layout',
      h(
        'div.chat-side',
        h(
          'div.chat-agent',
          h('div.row.nowrap', avatar(agent, true), h('div.grow', h('div.name', agent.name), h('div.hint', { style: { marginTop: '2px' } }, agent.specialty || ''))),
          h('div.row.mt', { style: { gap: '6px' } }, h('span.pill', modelInfo(agent).name), h('span.pill', modelInfo(agent).where)),
          h(
            'div.row.mt',
            { style: { gap: '6px' } },
            h('button.btn.small', { onclick: newChat }, '+ New chat'),
            h('button.btn.ghost.small', { onclick: () => navigate(`#/agents/${agent.id}/edit`) }, 'Edit'),
            agent.engine !== 'openai' ? h('button.btn.ghost.small', { onclick: () => openTerminal(agent), title: 'Open this agent in a live terminal' }, 'Terminal') : null,
          ),
          h('details.mt', h('summary.label', { style: { cursor: 'pointer' } }, `${tools.length} tools`), h('div.hint.mono', { style: { marginTop: '6px', fontSize: '11px', lineHeight: '1.7' } }, tools.join(' · '))),
        ),
        chatList,
      ),
      h(
        'div.chat-main',
        h(
          'div.row.between',
          { style: { padding: '10px 28px', borderBottom: '1px solid var(--line)' } },
          h('div.grow', h('span.mono.dim', { style: { fontSize: '12px' } }, chat.title || 'Chat')),
          h('div.row', { style: { gap: '6px' } }, h('button.btn.tiny.ghost', { onclick: rename }, 'Rename'), h('button.btn.tiny.ghost', { onclick: resetMemory, title: 'Keep the messages here but start the agent fresh' }, 'Clear memory'), h('button.btn.tiny.danger', { onclick: removeChat }, 'Delete')),
        ),
        ctx.messages,
        ctx.approvalsEl,
        ctx.statusEl,
        h('div.composer', h('div.composer-box', ctx.input, ctx.stopBtn, ctx.sendBtn), h('div.row.between', { style: { maxWidth: '1000px', marginTop: '6px' } }, modelChip(agent, { onChange: () => reload() }), h('span.hint', 'Enter to send · Shift+Enter for a new line'))),
      ),
    ),
  );
  ctx.els = [];
  for (let i = 0; i < chat.items.length; i++) placeItem(i);
  if (!chat.items.length) ctx.messages.append(emptyHint());
  scrollDown(true);
  updateRunning();
  drawApprovals();
  setTimeout(() => ctx?.input.focus(), 50);
}

function emptyHint() {
  const a = ctx.agent;
  const ideas = suggestions(a);
  return h(
    'div.empty-chat',
    { style: { margin: 'auto', textAlign: 'center', maxWidth: '560px', color: 'var(--dim)' } },
    h('div', { style: { fontSize: '40px' } }, a.emoji || '🤖'),
    h('p', `Ask ${a.name} anything${a.specialty ? `. Good at: ${a.specialty}` : ''}.`),
    h(
      'div.chips',
      { style: { justifyContent: 'center', marginTop: '12px' } },
      ideas.map((t) => h('button.chip', { onclick: () => ((ctx.input.value = t), ctx.input.focus()) }, t)),
    ),
  );
}

function suggestions(a) {
  const t = a.tools || [];
  const out = [];
  if (t.includes('comfyui_run')) out.push('Make an image of a neon city at night');
  if (t.includes('x_draft_post')) out.push('Draft 3 X posts about what I’m building');
  if (t.includes('blender_run_python')) out.push('Build a low-poly island in Blender and render it');
  if (t.includes('ffmpeg')) out.push('Cut the first 30 seconds of a video');
  if (t.includes('ask_agent')) out.push('Plan this with the team: launch week content');
  if (t.includes('list_programs')) out.push('What programs can you use on my PC?');
  if (!out.length) out.push('What can you do?', 'Summarize what you know');
  return out.slice(0, 4);
}

function renderItem(item) {
  if (item.type === 'user')
    return h('div.msg.user', item.from ? h('div.from', `from ${item.from}`) : null, item.text);
  if (item.type === 'assistant') {
    const el = md(item.text);
    el.className = 'msg assistant';
    return el;
  }
  if (item.type === 'tool') {
    const argText = typeof item.args === 'string' ? item.args : JSON.stringify(item.args || {}, null, 2);
    const brief = typeof item.args === 'object' && item.args ? Object.values(item.args).filter((v) => typeof v === 'string').join(' · ').slice(0, 140) : '';
    const icon = item.status === 'running' ? h('span.dot.busy') : item.isError ? h('span.red', '✕') : h('span.accent', '✓');
    return h(
      `details.tool${item.isError ? '.error' : ''}`,
      h('summary', icon, h('span.tname', item.name), h('span.targ', brief)),
      h(
        'div.tbody',
        h('div.label', 'Input'),
        h('pre', argText),
        item.result != null ? [h('div.label', 'Result'), h('pre', item.result || '(empty)')] : h('div.hint', 'Running…'),
      ),
      item.images?.length ? h('div.tool-images', { style: { padding: '0 12px 12px' } }, item.images.map((src) => h('img', { src, onclick: () => lightbox(src) }))) : null,
    );
  }
  if (item.type === 'error') return h('div.msg.error', item.text);
  if (item.type === 'meta') return h('div.msg.meta', item.text);
  return h('div');
}

// Images shown outside the collapsed tool card so results are visible right away.
function placeItem(i) {
  const item = ctx.chat.items[i];
  const el = renderItem(item);
  let wrap = el;
  if (item.type === 'tool' && item.images?.length) {
    wrap = h('div.col', { style: { gap: '6px' } }, el, h('div.tool-images', item.images.map((src) => h('img', { src, onclick: () => lightbox(src) }))));
    el.querySelector('.tool-images')?.remove();
  }
  const prev = ctx.els[i];
  if (prev) prev.replaceWith(wrap);
  else ctx.messages.append(wrap);
  ctx.els[i] = wrap;
}

function nearBottom() {
  const m = ctx.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 140;
}
function scrollDown(force = false) {
  if (force || nearBottom()) requestAnimationFrame(() => ctx && (ctx.messages.scrollTop = ctx.messages.scrollHeight));
}

function autosize() {
  const t = ctx.input;
  t.style.height = 'auto';
  t.style.height = Math.min(260, t.scrollHeight + 2) + 'px';
}

function updateRunning() {
  if (!ctx) return;
  const r = running();
  ctx.stopBtn.classList.toggle('hidden', !r);
  ctx.sendBtn.disabled = r;
  if (!r) setStatus('');
  else if (!ctx.status) setStatus('Working…');
}

function setStatus(text) {
  ctx.status = text;
  mount(ctx.statusEl, text ? [h('span.dot.busy'), text] : []);
}

function drawApprovals() {
  if (!ctx) return;
  const mine = (state.data?.approvals || []).filter((a) => a.agentId === ctx.agent.id);
  mount(ctx.approvalsEl, mine.map((a) => h('div', { style: { maxWidth: '860px', marginBottom: '10px' } }, approvalCard(a))));
  if (mine.length) {
    setStatus(`Waiting for you: ${mine[0].title}`);
    scrollDown(true);
  }
}

async function send() {
  const text = ctx.input.value.trim();
  if (!text || running()) return;
  ctx.input.value = '';
  autosize();
  const r = await attempt(() => POST(`/agents/${ctx.agent.id}/chats/${ctx.chat.id}/messages`, { text }));
  if (!r) ctx.input.value = text;
}

function stop() {
  attempt(() => POST(`/agents/${ctx.agent.id}/chats/${ctx.chat.id}/stop`));
}

async function newChat() {
  const c = await attempt(() => POST(`/agents/${ctx.agent.id}/chats`));
  if (c) navigate(`#/agents/${ctx.agent.id}/${c.id}`);
}

async function rename() {
  const { promptBox } = await import('../core.js');
  const t = await promptBox('Rename chat', { value: ctx.chat.title });
  if (t) {
    await attempt(() => PUT(`/agents/${ctx.agent.id}/chats/${ctx.chat.id}`, { title: t }));
    reload();
  }
}

async function resetMemory() {
  await attempt(() => PUT(`/agents/${ctx.agent.id}/chats/${ctx.chat.id}`, { reset: true }), 'The agent will start fresh from your next message');
  reload();
}

async function removeChat() {
  if (!(await confirmBox('Delete this chat?', { ok: 'Delete', danger: true }))) return;
  await attempt(() => DEL(`/agents/${ctx.agent.id}/chats/${ctx.chat.id}`));
  navigate(`#/agents/${ctx.agent.id}`);
}

async function reload() {
  if (!ctx) return;
  const [chat, chats] = await Promise.all([GET(`/agents/${ctx.agent.id}/chats/${ctx.chat.id}`), GET(`/agents/${ctx.agent.id}/chats`)]);
  if (!ctx) return;
  ctx.chat = chat;
  ctx.chats = chats;
  const keepInput = ctx.input.value;
  draw();
  ctx.input.value = keepInput;
}

// ---------- live updates ----------
export function onEvent(ev) {
  if (!ctx || ev.type !== 'run' || ev.chatId !== ctx.chat.id) return;
  const e = ev.event;
  const items = ctx.chat.items;
  const empty = ctx.messages.querySelector('.empty-chat');
  if (empty) empty.remove();
  if (e.kind === 'start') {
    const last = items[items.length - 1];
    if (!(last?.type === 'user' && last.text === e.text)) {
      items.push({ type: 'user', text: e.text, from: e.from, ts: Date.now() });
      placeItem(items.length - 1);
    }
    ctx.streaming = null;
    setStatus('Thinking…');
    scrollDown(true);
  } else if (e.kind === 'text') {
    if (ctx.streaming == null || items[ctx.streaming]?.type !== 'assistant') {
      items.push({ type: 'assistant', text: '', ts: Date.now() });
      ctx.streaming = items.length - 1;
    }
    items[ctx.streaming].text += e.text;
    scheduleRender(ctx.streaming);
    setStatus('Writing…');
  } else if (e.kind === 'tool') {
    ctx.streaming = null;
    items.push({ type: 'tool', id: e.id, name: e.name, args: e.args, result: null, status: 'running' });
    placeItem(items.length - 1);
    setStatus(`Using ${e.name}…`);
    scrollDown();
  } else if (e.kind === 'tool_result') {
    const i = items.findLastIndex((x) => x.type === 'tool' && x.id === e.id);
    if (i >= 0) {
      Object.assign(items[i], { result: e.text, images: e.images || [], isError: e.isError, status: e.isError ? 'error' : 'done' });
      placeItem(i);
    }
    setStatus('Thinking…');
    scrollDown();
  } else if (e.kind === 'status') {
    setStatus(e.text);
  } else if (e.kind === 'done' || e.kind === 'error') {
    setStatus('');
    reload().then(() => scrollDown(true));
  }
}

let renderQueued = new Set();
let framePending = false;
function scheduleRender(i) {
  renderQueued.add(i);
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    if (!ctx) return;
    for (const idx of renderQueued) placeItem(idx);
    renderQueued = new Set();
    const el = ctx.els[ctx.streaming];
    if (el) el.classList.add('cursor');
    scrollDown();
  });
}
