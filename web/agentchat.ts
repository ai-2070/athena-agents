// One agent's chat, for the floating chat window: its latest conversation as the OpenUI chat (web/chat,
// the small version): streaming replies, tools it uses (with images), file previews, approvals it waits
// on, and a composer with Stop. The bar above picks the model, starts a new chat or opens the full page.
import { h, mount, state, GET, POST, attempt, navigate, onState } from './core.ts';
import { icon } from './icons.ts';
import { modelChip } from './models.ts';
import { attachTray } from './attach.ts';
import type { MountedChat } from './chat/mount.tsx';
import type { Chat, ChatSummary } from '../shared/types.ts';

/** What renderAgentChat() hands back. */
export interface AgentChatApi {
  focus: () => void;
  destroy: () => void;
}

// A session the agent keeps for a team chat (marked by teamId; chats made before that only have the title).
export const isTeamSession = (c: ChatSummary): boolean => !!c.teamId || /^Team: /.test(c.title || '');

export function renderAgentChat(container: HTMLElement, agentId: string): AgentChatApi {
  let chatId: string | null = null;
  let alive = true;
  let convo: MountedChat | null = null;
  const agent = () => state.data?.agents.find((a) => a.id === agentId);
  const tray = attachTray();
  const chipBox = h('span.ac-model');
  const body = h('div.ac-body');
  const bar = h(
    'div.ac-bar',
    chipBox,
    h('span.grow'),
    h('button.btn.tiny.ghost', { title: 'Start a fresh conversation', onclick: () => fresh() }, icon('plus', 13), 'New chat'),
    h('button.btn.tiny.ghost', { title: 'Open the full chat page', onclick: () => navigate(chatId ? `#/agents/${agentId}/${chatId}` : `#/agents/${agentId}`) }, icon('maximize-2', 13), 'Full page'),
  );
  const root = h('div.ac', bar, body);
  mount(container, root);
  const offDrop = tray.dropZone(root, `Drop files or folders for ${agent()?.name || 'the agent'}`);
  const drawChrome = () => {
    const a = agent();
    if (a) mount(chipBox, modelChip(a, { compact: true }));
  };

  // bumped by every open, so a slow, older one can't replace a newer choice
  let seq = 0;
  const open = async (id: string | null | undefined) => {
    const my = ++seq;
    let pick = id ?? null;
    if (id === undefined) {
      const chats = await GET<ChatSummary[]>(`/agents/${agentId}/chats`).catch((): ChatSummary[] => []);
      // its own conversations, not the sessions it keeps for each team chat
      pick = chats.find((c) => !isTeamSession(c))?.id || null;
    }
    const { mountChat } = await import('./chat/mount.tsx');
    const a = agent();
    if (!alive || my !== seq || !a) return;
    chatId = pick;
    convo?.destroy();
    convo = mountChat(body, {
      agent: { id: a.id, name: a.name, emoji: a.emoji, specialty: a.specialty },
      chatId: pick,
      compact: true,
      tray,
      // (a first message makes the chat)
      onChat: (c: Chat) => (chatId = c.id),
    });
  };
  async function fresh() {
    const c = await attempt(() => POST<Chat>(`/agents/${agentId}/chats`));
    if (c) await open(c.id);
  }

  const offState = onState(() => alive && drawChrome());
  drawChrome();
  void open(undefined);
  return {
    focus: () => convo?.api.current?.focus(),
    destroy: () => {
      alive = false;
      convo?.destroy();
      offState?.();
      offDrop();
      // the tab closed: unsent attachments go too
      tray.discard();
    },
  };
}
