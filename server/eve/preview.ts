import { emit } from '../store.ts';
import { readBinding, readRun } from './state.ts';
import type { SessionStreamEvent } from 'eve/client';
import type { ChatItem } from '../../shared/types.ts';

// Text the model is still writing, shown live as it comes. It is never saved: a progress record may be missing,
// and only the completed part is the original (projection.ts). Kept in memory per run.
interface Preview {
  /** the last progress record shown: a stream read again after a reconnect doesn't show it twice */
  at: { line: number; index: number };
  /** each part being written: its kind (from its first record) and the text shown of it so far */
  parts: Map<string, { kind?: string; text: string }>;
}
const previews = new Map<string, Preview>();

const after = (a: { line: number; index: number }, b: { line: number; index: number } | null | undefined) =>
  !b || a.line > b.line || (a.line === b.line && a.index > b.index);

/** Shows a piece of text the model is writing to whoever follows the run. */
export function showDelta(runId: string, source: SessionStreamEvent): void {
  if (source.type !== 'content.delta') return;
  const run = readRun(runId);
  if (!run || !['queued', 'running', 'waiting'].includes(run.status)) return;
  const position = source.meta.position;
  // (already completed: it is in the chat; or the end of the turn before the one this run follows)
  if (!run.cursor || !after(position, run.cursor) || (run.adopted && !run.turnId)) return;
  if (source.scope?.turnId && run.turnId && source.scope.turnId !== run.turnId) return;
  let preview = previews.get(runId);
  if (preview && !after(position, preview.at)) return;
  if (!preview) previews.set(runId, (preview = { at: position, parts: new Map() }));
  preview.at = position;
  const { partId, kind, delta } = source.data;
  let part = preview.parts.get(partId);
  if (!part) preview.parts.set(partId, (part = { text: '' }));
  if (kind) part.kind = kind;
  // only answer text (not reasoning, nor a part whose first record went missing)
  if (part.kind !== 'text' || !delta) return;
  part.text += delta;
  const binding = readBinding(run.bindingId);
  if (!binding) return;
  emit('run', {
    runId,
    agentId: binding.agentId,
    chatId: binding.chatId,
    projectId: binding.projectId,
    event: { kind: 'text', text: delta },
  });
}

/** The text of a completed part that wasn't shown yet: all of it, unless what was shown is its start. */
export function unshownText(runId: string, partId: string | undefined, text: string): string {
  const parts = previews.get(runId)?.parts;
  const shown = (partId && parts?.get(partId)?.text) || '';
  if (partId) parts?.delete(partId);
  return shown && text.startsWith(shown) ? text.slice(shown.length) : text;
}

/** The turn so far with the text still being written, for a view that opens in the middle of it. */
export function withPreview(items: readonly ChatItem[], runId: string): readonly ChatItem[] {
  const parts = previews.get(runId)?.parts;
  const writing = [...(parts?.values() || [])].filter((part) => part.kind === 'text' && part.text);
  if (!writing.length) return items;
  return [...items, ...writing.map((part): ChatItem => ({ type: 'assistant', text: part.text, ts: Date.now() }))];
}

export function forgetPreview(runId: string): void {
  previews.delete(runId);
}
