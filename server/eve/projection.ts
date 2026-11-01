import { readRun, recordEvents } from './state.ts';
import type { SessionStreamEvent } from 'eve/client';
import type { RunEvent } from '../../shared/types.ts';

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Only committed facts become originals. Progress previews are not replay-safe text. */
export function projectEvent(runId: string, source: SessionStreamEvent): { id: string; event: RunEvent }[] {
  const run = readRun(runId);
  if (!run) throw new Error('No such Eve run.');
  const events: RunEvent[] = [];
  switch (source.type) {
    case 'content.delta':
    case 'call.input':
    case 'call.progress':
      return [];
    case 'content.completed':
      if (source.data.kind === 'text' && typeof source.data.value === 'string') events.push({ kind: 'text', text: source.data.value });
      else if (source.data.kind === 'text' && source.data.valueRef) throw new Error('Eve text needs its referenced value before it can be saved.');
      break;
    case 'model.started':
      events.push({ kind: 'model', model: source.data.modelId });
      break;
    case 'call.requested': {
      if (source.data.inputRef && source.data.input === undefined) throw new Error('Eve tool input needs its referenced value before it can be saved.');
      if (source.data.capability.kind === 'tool') events.push({ kind: 'tool', id: source.data.callId, name: source.data.capability.name, args: object(source.data.input) || {} });
      break;
    }
    case 'call.settled': {
      if (!run.events.some((item) => item.event.kind === 'tool' && item.event.id === source.data.callId)) break;
      const output = source.data.output;
      if (source.data.outputRef && output === undefined) throw new Error('Eve tool output needs its referenced value before it can be saved.');
      const record = object(output);
      const text = typeof record?.text === 'string'
        ? record.text : typeof output === 'string' ? output : source.data.error?.message || JSON.stringify(output ?? '(no output)');
      const images = Array.isArray(record?.images) ? record.images.filter((image: unknown): image is string => typeof image === 'string') : [];
      const isError = source.data.outcome !== 'completed' || !!record?.isError;
      events.push({ kind: 'tool_result', id: source.data.callId, text, isError, ...(images.length ? { images } : {}) });
      break;
    }
    case 'context.settled':
      if (source.data.kind === 'compaction' && source.data.outcome === 'completed') events.push({ kind: 'compacted' });
      break;
    default:
      break;
  }
  return recordEvents(runId, source.meta.position, events);
}
