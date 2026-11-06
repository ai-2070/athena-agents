// A message as it was typed (shared/api/message.ts), for the agent chats and the Brain: its words trimmed, and the
// files attached that count (only uploads of the project).
import { cleanAttachments } from '../uploads.ts';
import { refuse } from './refuse.ts';

export interface Said {
  text: string;
  attachments: string[];
}

/** The message, maybe empty. max: the most characters of it that count. */
export function said(input: { text?: string; attachments?: string[] }, max = Infinity): Said {
  return { text: (input.text ?? '').trim().slice(0, max), attachments: cleanAttachments(input.attachments) };
}

/** The message, refused when there is nothing in it (or `empty`, said when it is). */
export function saidSomething(input: { text?: string; attachments?: string[] }, { max = Infinity, empty = 'Type a message first.' } = {}): Said {
  const s = said(input, max);
  if (!s.text && !s.attachments.length) return refuse(empty);
  return s;
}
