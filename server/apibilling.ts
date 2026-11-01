import { numberOf, objectOf } from './apiresponse.ts';
import type { ApiModelInfo, RunBilling } from '../shared/types.ts';

export function completionBilling(usage: unknown, charges: unknown, price: ApiModelInfo['price']): { cost?: number; billing: RunBilling } {
  const reported = objectOf(charges);
  const usd = numberOf(reported.usd);
  const diem = numberOf(reported.diem);
  const billing: RunBilling = { source: 'unavailable', ...(usd != null ? { chargedUsd: usd } : {}), ...(diem != null ? { chargedDiem: diem } : {}) };
  if (usd != null && !(diem && diem > 0)) return { cost: usd, billing: { ...billing, source: 'reported' } };
  const tokens = objectOf(usage);
  const input = numberOf(tokens.prompt_tokens);
  const output = numberOf(tokens.completion_tokens);
  if (price && input != null && output != null) {
    const cached = Math.min(input, numberOf(objectOf(tokens.prompt_tokens_details).cached_tokens) || 0);
    const cost = ((input - cached) * price.in + cached * (price.cached ?? price.in) + output * price.out) / 1e6;
    return { cost, billing: { ...billing, source: 'estimated' } };
  }
  return { billing };
}
