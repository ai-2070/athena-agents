import { joinDelivery, readRun, recordEvents, recordTurn } from './state.ts';
import { operationsForRun, saveOperation } from './operations.ts';
import { cancelDurableApproval } from '../approvals.ts';
import type { SessionStreamEvent } from 'eve/client';
import type { RunEvent } from '../../shared/types.ts';

const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export class EveProjectionError extends Error {}

/** Only committed facts become originals. Progress previews are not replay-safe text. */
export function projectEvent(runId: string, source: SessionStreamEvent): { id: string; event: RunEvent }[] {
  const run = readRun(runId);
  if (!run) throw new Error('No such Eve run.');
  const position = source.meta.position;
  if (run.cursor && (position.line < run.cursor.line || position.line === run.cursor.line && position.index <= run.cursor.index)) return [];
  // (a run following a turn Eve started with a late message reads from that message on: the end of the
  // turn before, still going when the message came, isn't its own)
  if (run.adopted && !run.turnId && source.type !== 'delivery.consumed') return recordEvents(runId, position, []);
  const events: RunEvent[] = [];
  let partId: string | undefined;
  switch (source.type) {
    case 'delivery.consumed':
      if (source.data.deliveryId === run.deliveryId) recordTurn(runId, source.data.turnId);
      // a message sent while it worked, taken into its turn
      else if (run.turnId && source.data.turnId === run.turnId) joinDelivery(runId, source.data.deliveryId);
      break;
    case 'interaction.opened': {
      const subject = source.data.subject;
      if (source.data.request.kind !== 'approval' || !('callId' in subject) || source.data.origin) throw new EveProjectionError('This Eve interaction is not an Athena tool approval.');
      const operation = operationsForRun(runId).find((item) => item.callId === subject.callId);
      if (!operation || !(operation.approvalId || operation.questionId)) throw new EveProjectionError('This Eve approval has no saved Athena operation.');
      if (operation.interactionId && operation.interactionId !== source.data.interactionId) throw new EveProjectionError('This operation already has an Eve interaction.');
      saveOperation({ ...operation, interactionId: source.data.interactionId });
      break;
    }
    case 'interaction.settled': {
      const operation = operationsForRun(runId).find((item) => item.interactionId === source.data.interactionId);
      if (!operation) break;
      const withdrawn = !['accepted', 'declined'].includes(source.data.outcome);
      if (withdrawn) cancelDurableApproval(operation.id, 'This tool request is no longer active.');
      saveOperation({ ...operation, interactionSettled: true, ...(withdrawn && ['waiting', 'prepared'].includes(operation.status) ? { status: 'cancelled' } : {}) });
      break;
    }
    case 'content.delta':
    case 'call.input':
    case 'call.progress':
      return [];
    case 'content.completed':
      if (source.data.kind === 'text' && typeof source.data.value === 'string') {
        events.push({ kind: 'text', text: source.data.value });
        partId = source.data.partId;
      }
      else if (source.data.kind === 'text' && source.data.valueRef) throw new EveProjectionError('Eve text needs its referenced value before it can be saved.');
      break;
    case 'model.started':
      events.push({ kind: 'model', model: source.data.modelId });
      break;
    case 'usage.recorded': {
      if (source.scope?.turnId && source.scope.turnId !== run.turnId) break;
      const usage = source.data.usage;
      const counts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens];
      if (counts.some((count) => !Number.isSafeInteger(count) || count < 0) || usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) throw new EveProjectionError('Eve returned invalid usage counts.');
      events.push({ kind: 'usage', ...usage, ...(source.data.owner && 'changeId' in source.data.owner ? { summary: true } : {}) });
      break;
    }
    case 'call.requested': {
      if (source.data.inputRef && source.data.input === undefined) throw new EveProjectionError('Eve tool input needs its referenced value before it can be saved.');
      if (source.data.capability.kind === 'tool') events.push({ kind: 'tool', id: source.data.callId, name: source.data.capability.name, args: object(source.data.input) || {} });
      break;
    }
    case 'call.settled': {
      if (!run.events.some((item) => item.event.kind === 'tool' && item.event.id === source.data.callId)) break;
      const output = source.data.output;
      if (source.data.outputRef && output === undefined) throw new EveProjectionError('Eve tool output needs its referenced value before it can be saved.');
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
  return recordEvents(runId, source.meta.position, events, partId);
}
