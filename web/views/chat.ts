// Chat with one agent: the agent and its chats on the left; the conversation itself is the AI SDK chat
// (web/chat): streaming answers, tool calls you can open, images, file previews, COMPACTED marks.
import { h, mount, GET, POST, PUT, DEL, attempt, avatar, navigate, ago, confirmBox } from '../core.ts';
import { openTerminal } from './agents.ts';
import { modelChip, modelInfo } from '../models.ts';
import { kTokens } from '../../shared/compaction.ts';
import { attachTray } from '../attach.ts';
import type { AttachTray } from '../attach.ts';
import type { AgentDetail } from './agents.ts';
import type { MountedChat } from '../chat/mount.tsx';
import type { Chat, ChatSummary } from '../../shared/types.ts';

export const flush = true;
export const title = (): string => 'Chat';

interface ChatCtx {
  el: HTMLElement;
  agent: AgentDetail;
  chat: Chat;
  chats: ChatSummary[];
  /** Files waiting to go with the next message (the whole page takes dropped files). */
  tray: AttachTray;
  offDrop: () => void;
  convo: MountedChat | null;
  titleEl: HTMLSpanElement;
  listEl: HTMLDivElement;
  memoryEl: HTMLSpanElement;
}

/** GET /api/agents/:id/chats/:cid/memory */
interface MemoryInfo {
  tokens: number;
  window: number;
  compactAt: number;
  percent: number;
  auto: boolean;
}

let ctx: ChatCtx | null = null;

export async function render(el: HTMLElement, params: string[] = [], view?: { setTitle(t: string): void }): Promise<void> {
  const { setTitle } = view!;
  const [agentId, chatId] = params;
  const agent = await GET<AgentDetail>(`/agents/${agentId}`).catch(() => null);
  if (!agent) {
    mount(el, h('div', { style: { padding: '28px' } }, h('p', 'That agent no longer exists. '), h('a', { href: '#/agents' }, 'Back to agents')));
    return;
  }
  setTitle(`${agent.emoji || ''} ${agent.name}`);
  const chats = await GET<ChatSummary[]>(`/agents/${agentId}/chats`);
  if (!chatId) {
    const target = chats[0] || (await POST<Chat>(`/agents/${agentId}/chats`));
    location.replace(`#/agents/${agentId}/${target.id}`);
    return;
  }
  const chat = await GET<Chat>(`/agents/${agentId}/chats/${chatId}`).catch(() => null);
  if (!chat) {
    location.replace(`#/agents/${agentId}`);
    return;
  }
  const tray = attachTray();
  const mine: ChatCtx = {
    el,
    agent,
    chat,
    chats,
    tray,
    offDrop: tray.dropZone(el, `Drop files or folders for ${agent.name}`),
    convo: null,
    titleEl: h('span.mono.dim', { style: { fontSize: '12px' } }),
    listEl: h('div.chat-list'),
    memoryEl: h('span.pill.mem', { title: 'How full the agent’s memory of this chat is' }),
  };
  ctx = mine;
  const body = draw();
  const { mountChat } = await import('../chat/mount.tsx');
  // (left the page while it loaded)
  if (ctx !== mine) return;
  mine.convo = mountChat(body, {
    agent: { id: agent.id, name: agent.name, emoji: agent.emoji, specialty: agent.specialty, tools: agent.tools },
    chatId: chat.id,
    tray,
    footer: modelChip(agent, { onChange: () => mine.convo?.api.current?.reload() }),
    onChat: (c) => {
      if (ctx !== mine) return;
      mine.chat = c;
      drawHead();
      refreshList();
    },
  });
  setTimeout(() => mine.convo?.api.current?.focus(), 80);
}

export function unmount(): void {
  ctx?.convo?.destroy();
  ctx?.offDrop();
  // leaving the page: unsent attachments go too
  ctx?.tray.discard();
  ctx = null;
}

// The page around the conversation; returns where the conversation goes.
function draw(): HTMLElement {
  const { el, agent } = ctx!;
  const tools = agent.tools || [];
  const body = h('div.chat-body');
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
        ctx!.listEl,
      ),
      h(
        'div.chat-main',
        h(
          'div.row.between',
          { style: { padding: '10px 28px', borderBottom: '1px solid var(--line)' } },
          h('div.grow', ctx!.titleEl),
          h(
            'div.row',
            { style: { gap: '6px' } },
            ctx!.memoryEl,
            h('button.btn.tiny.ghost', { onclick: () => ctx?.convo?.api.current?.compact(), title: 'Compact the agent’s memory of this chat now: older messages become a short history, the latest stay in full (or type /compact)' }, 'Compact'),
            h('button.btn.tiny.ghost', { onclick: rename }, 'Rename'),
            h('button.btn.tiny.ghost', { onclick: resetMemory, title: 'Keep the messages here but start the agent fresh' }, 'Clear memory'),
            h('button.btn.tiny.danger', { onclick: removeChat }, 'Delete'),
          ),
        ),
        body,
      ),
    ),
  );
  drawHead();
  drawList();
  return body;
}

function drawHead(): void {
  if (!ctx) return;
  ctx.titleEl.textContent = ctx.chat.title || 'Chat';
  drawMemory();
}

function drawList(): void {
  if (!ctx) return;
  const { agent, chat, chats } = ctx;
  mount(ctx.listEl, chats.map((c) => h(`a${c.id === chat.id ? '.on' : ''}`, { href: `#/agents/${agent.id}/${c.id}` }, h('span.t', c.title || 'Chat'), h('span.w', `${ago(c.updatedAt)} · ${c.count} items`))));
}

async function refreshList(): Promise<void> {
  const mine = ctx;
  if (!mine) return;
  const chats = await GET<ChatSummary[]>(`/agents/${mine.agent.id}/chats`).catch(() => null);
  if (ctx !== mine || !chats) return;
  mine.chats = chats;
  drawList();
}

// The memory meter next to Compact.
let memorySeq = 0;
async function drawMemory(): Promise<void> {
  if (!ctx) return;
  const my = ++memorySeq;
  const m = await GET<MemoryInfo>(`/agents/${ctx.agent.id}/chats/${ctx.chat.id}/memory`).catch(() => null);
  if (!ctx || my !== memorySeq || !m) return;
  ctx.memoryEl.textContent = `Memory ${m.percent}%`;
  ctx.memoryEl.classList.toggle('warn', m.tokens >= m.compactAt * 0.8);
  ctx.memoryEl.title = `About ${kTokens(m.tokens)} of ${kTokens(m.window)} tokens. ${m.auto ? `Compacts by itself at ${kTokens(m.compactAt)} (Settings > Chat memory).` : 'Automatic compaction is off (Settings > Chat memory).'}`;
}

async function newChat(): Promise<void> {
  const c = await attempt(() => POST<Chat>(`/agents/${ctx!.agent.id}/chats`));
  if (c) navigate(`#/agents/${ctx!.agent.id}/${c.id}`);
}

async function rename(): Promise<void> {
  const { promptBox } = await import('../core.ts');
  const t = await promptBox('Rename chat', { value: ctx!.chat.title });
  if (t && (await attempt(() => PUT(`/agents/${ctx!.agent.id}/chats/${ctx!.chat.id}`, { title: t })))) await ctx?.convo?.api.current?.reload();
}

async function resetMemory(): Promise<void> {
  if (await attempt(() => PUT(`/agents/${ctx!.agent.id}/chats/${ctx!.chat.id}`, { reset: true }), 'The agent will start fresh from your next message')) await ctx?.convo?.api.current?.reload();
}

async function removeChat(): Promise<void> {
  if (!(await confirmBox('Delete this chat?', { ok: 'Delete', danger: true }))) return;
  await attempt(() => DEL(`/agents/${ctx!.agent.id}/chats/${ctx!.chat.id}`));
  navigate(`#/agents/${ctx!.agent.id}`);
}
