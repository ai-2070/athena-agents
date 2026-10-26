// A saved chat (its items, the server's own format) as OpenUI messages (AG-UI shaped), for the chat UI.
// Each message's id says which item it came from ("m-<seq>", seq = the item's index), so the UI can
// find the item again (for the COMPACTED mark, dimming compacted messages, file previews).
//   user           → UserMessage (attachments as binary parts; their id is the file's path)
//   assistant text → AssistantMessage; the tool calls after it (in the same turn) are its toolCalls,
//                    and each result a ToolMessage (content: JSON { text, images })
//   error, meta, compaction → ActivityMessage (OpenUI shows none of these itself; our UI draws them)
import type { ActivityMessage, AssistantMessage, InputContent, Message, ToolMessage, UserMessage } from '@openuidev/react-headless';
import type { ChatItem } from '../../shared/types.ts';

export const fileUrl = (p: string): string => `/api/file?path=${encodeURIComponent(p)}`;

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv' };
export const mimeOf = (p: string): string => MIME[/\.([a-z0-9]+)$/i.exec(p)?.[1]?.toLowerCase() || ''] || 'application/octet-stream';
const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;

/** What a tool result carries (ToolMessage.content is a string, so it is JSON). */
export interface ToolPayload {
  text: string;
  images: string[];
}
export const toolContent = (text: string | null | undefined, images: readonly string[] = []): string => JSON.stringify({ text: String(text ?? ''), images: [...images] } satisfies ToolPayload);
export function readToolContent(content: string | null | undefined): ToolPayload {
  try {
    const j = JSON.parse(String(content ?? '')) as Partial<ToolPayload>;
    if (j && typeof j === 'object' && 'text' in j) return { text: String(j.text ?? ''), images: Array.isArray(j.images) ? j.images.map(String) : [] };
  } catch {
    /* plain text */
  }
  return { text: String(content ?? ''), images: [] };
}

/** A user message: its text, and the files sent with it as binary parts. */
export function userContent(text: string, attachments: readonly string[] = []): UserMessage['content'] {
  if (!attachments.length) return text;
  return [{ type: 'text', text }, ...attachments.map((p): InputContent => ({ type: 'binary', id: p, mimeType: mimeOf(p), url: fileUrl(p), filename: baseName(p) }))];
}

/** The text and the attached paths of a user message. */
export function readUserContent(m: Pick<UserMessage, 'content'>): { text: string; attachments: string[] } {
  if (typeof m.content === 'string') return { text: m.content, attachments: [] };
  const parts = m.content as InputContent[];
  return {
    text: parts.map((p) => (p.type === 'text' ? p.text : '')).join(''),
    attachments: parts.flatMap((p) => (p.type === 'binary' && p.id ? [p.id] : [])),
  };
}

/** The item a message came from: "m-12" and "m-12-calls" → 12. */
export const seqOf = (id: string): number | null => {
  const m = /^m-(\d+)/.exec(id);
  return m ? Number(m[1]) : null;
};

export type ActivityKind = 'error' | 'meta' | 'compaction';

export function toMessages(items: readonly ChatItem[]): Message[] {
  const out: Message[] = [];
  // the assistant message the next tool calls belong to (only within a turn)
  let open: AssistantMessage | null = null;
  const tools: ToolMessage[] = [];
  const flushTools = () => {
    out.push(...tools);
    tools.length = 0;
  };
  items.forEach((it, seq) => {
    if (it.type === 'tool') {
      if (!open) {
        open = { id: `m-${seq}-calls`, role: 'assistant', content: '', toolCalls: [] };
        out.push(open);
      }
      open.toolCalls = [...(open.toolCalls || []), { id: it.id, type: 'function', function: { name: it.name, arguments: typeof it.args === 'string' ? it.args : JSON.stringify(it.args ?? {}) } }];
      if (it.result != null && it.status !== 'running') tools.push({ id: `m-${seq}-result`, role: 'tool', toolCallId: it.id, content: toolContent(it.result, it.images), ...(it.isError ? { error: it.result || 'Failed' } : {}) });
      return;
    }
    flushTools();
    if (it.type === 'assistant') {
      open = { id: `m-${seq}`, role: 'assistant', content: it.text, toolCalls: [] };
      out.push(open);
      return;
    }
    open = null;
    if (it.type === 'user') out.push({ id: `m-${seq}`, role: 'user', content: userContent(it.text, it.attachments), ...(it.from ? { name: it.from } : {}) });
    else out.push({ id: `m-${seq}`, role: 'activity', activityType: it.type, content: { ...it } } satisfies ActivityMessage);
  });
  flushTools();
  return out;
}
