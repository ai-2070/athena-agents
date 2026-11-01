// Search saved originals, including entries that the agent's current model memory has compacted.
import { agents, chats } from './store.ts';
import { listTeams, teamMessages } from './teams.ts';
import type { ChatItem, ConversationHit, ConversationRead, ConversationReadResult, ConversationSearch, ConversationSearchResult } from '../shared/types.ts';

const pageNumber = (value: unknown, fallback: number, max: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback;

function ownText(item: ChatItem): string {
  if (item.type === 'tool') return ['search_conversations', 'read_conversation', 'recall_history'].includes(item.name) ? '' : `${item.name}\n${JSON.stringify(item.args ?? {})}\n${item.result || ''}`;
  if (item.type === 'compaction') return ''; // Search the originals rather than copies in checkpoints.
  return item.text + (item.type === 'user' && item.attachments?.length ? `\nAttached: ${item.attachments.join(', ')}` : '');
}

function memberTeams(agentId: string, teamId?: string) {
  return listTeams().filter((t) => t.members.includes(agentId) && (!teamId || t.id === teamId));
}

export function searchConversations(agentId: string, args: ConversationSearch): ConversationSearchResult {
  if (!agents.get(agentId)) throw new Error('Only saved dashboard agents can search conversations.');
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query || query.length > 1000) throw new Error('Give search words, up to 1000 characters.');
  if (args.scope && !['own', 'team', 'all'].includes(args.scope)) throw new Error('Scope must be own, team or all.');
  const scope = args.scope || 'all';
  const words = query.toLowerCase().split(/\s+/);
  const offset = pageNumber(args.offset, 0, Number.MAX_SAFE_INTEGER);
  const limit = Math.max(1, pageNumber(args.limit, 10, 20));
  const hits: ConversationHit[] = [];
  const match = (hit: Omit<ConversationHit, 'excerpt'>, text: string) => {
    const low = text.toLowerCase();
    if (!words.every((word) => low.includes(word))) return;
    const at = low.indexOf(words[0]);
    hits.push({ ...hit, title: hit.title.slice(0, 200), author: hit.author.slice(0, 256), excerpt: text.slice(Math.max(0, at - 120), at + 400) });
  };
  if (scope !== 'team') {
    for (const summary of chats.list(agentId)) {
      const chat = chats.get(agentId, summary.id);
      if (!chat) continue;
      chat.items.forEach((item, i) => match({ source: 'own', conversationId: chat.id, title: chat.title, messageId: String(i), author: item.type === 'user' ? item.from || 'user' : item.type === 'assistant' ? agentId : item.type, ts: item.ts || chat.createdAt }, ownText(item)));
    }
  }
  if (scope !== 'own') {
    const teams = memberTeams(agentId, args.teamId);
    if (args.teamId && !teams.length) throw new Error('That team conversation is not available to you.');
    for (const team of teams) {
      for (const m of teamMessages(team.id)) {
        match({ source: 'team', conversationId: team.id, title: team.name, messageId: m.id, author: m.from, ts: m.ts }, `${m.text}${m.attachments?.length ? `\nAttached: ${m.attachments.join(', ')}` : ''}`);
      }
    }
  }
  hits.sort((a, b) => b.ts - a.ts || a.conversationId.localeCompare(b.conversationId) || a.messageId.localeCompare(b.messageId));
  const page = hits.slice(offset, offset + limit);
  // Leave room below the engines' tool-result limits, including JSON escaping.
  while (page.length > 1 && JSON.stringify(page).length > 18000) page.pop();
  return { hits: page, total: hits.length, nextOffset: offset + page.length < hits.length ? offset + page.length : null };
}

/** Long originals are read in explicit character pages; an oversized message can always be read to its end. */
export function readConversation(agentId: string, args: ConversationRead): ConversationReadResult {
  if (!agents.get(agentId)) throw new Error('Only saved dashboard agents can read conversations.');
  let text: string;
  let title: string;
  if (args.source === 'own') {
    const chat = chats.get(agentId, args.conversationId);
    const index = /^\d+$/.test(String(args.messageId)) ? Number(args.messageId) : -1;
    const item = chat?.items[index];
    if (!chat || !item) throw new Error('That conversation message is not available to you.');
    text = ownText(item);
    title = chat.title;
  } else if (args.source === 'team') {
    const team = memberTeams(agentId, args.conversationId)[0];
    if (!team) throw new Error('That conversation message is not available to you.');
    const message = teamMessages(team.id).find((m) => m.id === args.messageId);
    if (!message) throw new Error('That conversation message is not available to you.');
    text = `${message.text}${message.attachments?.length ? `\nAttached: ${message.attachments.join(', ')}` : ''}`;
    title = team.name;
  } else throw new Error('Source must be own or team.');
  const offset = pageNumber(args.offset, 0, Number.MAX_SAFE_INTEGER);
  const limit = Math.max(1, pageNumber(args.limit, 8000, 16000));
  let end = Math.min(text.length, offset + limit);
  const page = (): ConversationReadResult => ({ source: args.source, conversationId: args.conversationId, messageId: args.messageId, title: title.slice(0, 200), text: text.slice(offset, end), totalChars: text.length, offset, nextOffset: end < text.length ? end : null });
  while (end > offset && JSON.stringify(page()).length > 20000) end = offset + Math.floor((end - offset) / 2);
  return page();
}
