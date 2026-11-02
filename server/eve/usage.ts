import { readRun } from './state.ts';
import type { EngineResult } from '../engines/index.ts';
import type { ChatItem, RunBilling } from '../../shared/types.ts';

/** Each usage fact is already deduplicated with its native cursor. Missing cost stays unknown. */
export function eveUsage(runId: string): Pick<EngineResult, 'cost' | 'billing' | 'tokens' | 'cached' | 'context'> {
  const run = readRun(runId);
  const events = run?.events.flatMap(({ event }) => event.kind === 'usage' ? [event] : []) || [];
  const charges = run?.charges || [];
  if (!events.length && !charges.length) return {};
  const tokens = events.reduce((sum, event) => sum + event.inputTokens + event.outputTokens, 0);
  const cached = events.reduce((sum, event) => sum + event.cacheReadTokens, 0);
  const known = charges.length ? charges.every((charge) => charge.cost !== undefined) : events.every((event) => event.costUsd !== undefined);
  const cost = charges.length ? charges.reduce((sum, charge) => sum + (charge.cost || 0), 0) : events.reduce((sum, event) => sum + (event.costUsd || 0), 0);
  const billing: RunBilling | undefined = charges.length ? {
    source: charges.some((charge) => charge.billing.source === 'unavailable') ? 'unavailable' : charges.some((charge) => charge.billing.source === 'estimated') ? 'estimated' : 'reported',
    ...(charges.some((charge) => charge.billing.chargedUsd !== undefined) ? { chargedUsd: charges.reduce((sum, charge) => sum + (charge.billing.chargedUsd || 0), 0) } : {}),
    ...(charges.some((charge) => charge.billing.chargedDiem !== undefined) ? { chargedDiem: charges.reduce((sum, charge) => sum + (charge.billing.chargedDiem || 0), 0) } : {}),
  } : undefined;
  const last = events.findLast((event) => !event.summary);
  return { tokens, cached, ...(known ? { cost } : {}), ...(billing ? { billing } : {}), ...(last ? { context: last.inputTokens + last.outputTokens } : {}) };
}

export function eveBillingItem(runId: string): ChatItem | null {
  const usage = eveUsage(runId);
  const billing = usage.billing;
  if (!billing) return null;
  const amount = billing.source === 'unavailable' ? 'Cost unavailable' : `${billing.source === 'estimated' ? 'Estimated ' : ''}$${(usage.cost || 0).toFixed(4)}${billing.source === 'estimated' ? ' USD equivalent' : ''}`;
  const charged = [billing.chargedUsd == null ? '' : `$${billing.chargedUsd.toFixed(4)} USD charged`, billing.chargedDiem == null ? '' : `${billing.chargedDiem.toFixed(4)} DIEM charged`].filter(Boolean);
  return { type: 'meta', text: `${amount}${charged.length ? ` · ${charged.join(' · ')}` : ''}`, billing, sourceId: `eve:${runId}:billing`, ts: Date.now() };
}
