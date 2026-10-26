// A run this chat view did not start itself (a team turn, a routine, a handoff, one started in another
// tab) still shows live: its events are applied to the chat's items here, and the items shown again.
import type { ChatItem, RunEvent } from '../../shared/types.ts';

/** The items after one live event (a new array; the old one is left as it was). */
export function applyRunEvent(items: readonly ChatItem[], e: RunEvent): ChatItem[] {
  const out = items.slice();
  const last = out[out.length - 1];
  if (e.kind === 'start') {
    // (the message is in the chat already when the view loaded after the run started)
    if (!(last?.type === 'user' && last.text === e.text)) out.push({ type: 'user', text: e.text, from: e.from, ...(e.attachments?.length ? { attachments: e.attachments } : {}), ts: Date.now() });
  } else if (e.kind === 'text') {
    if (last?.type === 'assistant') out[out.length - 1] = { ...last, text: last.text + e.text };
    else out.push({ type: 'assistant', text: e.text, ts: Date.now() });
  } else if (e.kind === 'tool') {
    out.push({ type: 'tool', id: e.id, name: e.name, args: e.args, result: null, status: 'running', ts: Date.now() });
  } else if (e.kind === 'tool_result') {
    const i = out.findLastIndex((x) => x.type === 'tool' && x.id === e.id);
    if (i >= 0) out[i] = { ...(out[i] as Extract<ChatItem, { type: 'tool' }>), result: e.text ?? '', images: e.images || [], isError: !!e.isError, status: e.isError ? 'error' : 'done' };
  }
  return out;
}
