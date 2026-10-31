import type { TeamMessage } from '../shared/types.ts';
import { attachmentNames } from './uploads.ts';

const CONTEXT_CHARS = 9000;
const EARLIER_BUDGET = 2000;
const SHORTENED = ' [message shortened]';
const EARLIER = 'Earlier in this chat (shortened):';

const preview = (text: string, chars: number) => text.length > chars ? text.slice(0, chars) + SHORTENED : text;
const bounded = (text: string, chars: number) => text.length > chars ? text.slice(0, chars - SHORTENED.length) + SHORTENED : text;

/** Files are named here; their actual paths are attached separately to the turn. */
export function teamMessage(m: TeamMessage, name: (m: TeamMessage) => string): string {
  return `${bounded(name(m), 256)}: ${preview(String(m.text), 2500)}${m.attachments?.length ? ` [attached: ${attachmentNames(m.attachments)}]` : ''}`;
}

/** Bounded context, with explicit counts for what cannot be represented. This is not a full summary. */
export function teamDigest(messages: TeamMessage[], name: (m: TeamMessage) => string): string {
  const recent: string[] = [];
  let size = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const line = bounded(teamMessage(messages[i], name), CONTEXT_CHARS);
    const added = line.length + (recent.length ? 2 : 0);
    if (size + added > CONTEXT_CHARS) break;
    recent.unshift(line);
    size += added;
    cut = i;
  }
  if (!cut) return recent.join('\n\n');

  const counts = (n: number) => `${cut} earlier ${cut === 1 ? 'message' : 'messages'}: ${n} ${n === 1 ? 'preview' : 'previews'}; ${cut - n} not shown.`;
  // Reserve the longest possible count, then the oldest preview, before filling from the recent end.
  const reserve = `${cut} earlier messages: ${cut} previews; ${cut} not shown.`.length;
  const available = EARLIER_BUDGET - EARLIER.length - reserve - 2;
  const line = (m: TeamMessage) => {
    const chars = m.from === 'user' || m.from === 'brain' ? 400 : 120;
    const files = m.attachments?.length ? ` [attached: ${bounded(attachmentNames(m.attachments), 200)}]` : '';
    return `${bounded(name(m), 160)}: ${preview(String(m.text), chars)}${files}`;
  };
  const oldest = line(messages[0]);
  const selected = [oldest];
  size = oldest.length;
  const newer: string[] = [];
  for (let i = cut - 1; i > 0; i--) {
    const next = line(messages[i]);
    if (size + next.length + 1 > available) break;
    newer.unshift(next);
    size += next.length + 1;
  }
  selected.push(...newer);
  const earlier = `${EARLIER}\n${selected.join('\n')}\n${counts(selected.length)}`;
  return `${earlier}\n\nRecent in this chat:\n${recent.join('\n\n')}`;
}
