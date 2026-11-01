import { readRun } from './state.ts';
import type { EngineResult } from '../engines/index.ts';

/** Each usage fact is already deduplicated with its native cursor. Missing cost stays unknown. */
export function eveUsage(runId: string): Pick<EngineResult, 'cost' | 'tokens' | 'cached' | 'context'> {
  const events = readRun(runId)?.events.flatMap(({ event }) => event.kind === 'usage' ? [event] : []) || [];
  if (!events.length) return {};
  const tokens = events.reduce((sum, event) => sum + event.inputTokens + event.outputTokens, 0);
  const cached = events.reduce((sum, event) => sum + event.cacheReadTokens, 0);
  const known = events.every((event) => event.costUsd !== undefined);
  const cost = events.reduce((sum, event) => sum + (event.costUsd || 0), 0);
  const last = events.findLast((event) => !event.summary);
  return { tokens, cached, ...(known ? { cost } : {}), ...(last ? { context: last.inputTokens + last.outputTokens } : {}) };
}
