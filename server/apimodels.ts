import { isEffort } from '../shared/effort.ts';
import { numberOf, objectOf } from './apiresponse.ts';
import type { ApiModelInfo } from '../shared/types.ts';

const bool = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined);

export function normalizeApiModels(json: unknown, provider: string): ApiModelInfo[] {
  const data = objectOf(json).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((value: unknown): ApiModelInfo[] => {
    const row = objectOf(value);
    if (typeof row.id !== 'string' || !row.id.trim()) return [];
    if (provider === 'venice') {
      if (row.type != null && row.type !== 'text') return [];
      const spec = objectOf(row.model_spec);
      const caps = objectOf(spec.capabilities);
      const pricing = objectOf(spec.pricing);
      const input = numberOf(objectOf(pricing.input).usd);
      const output = numberOf(objectOf(pricing.output).usd);
      const cached = numberOf(objectOf(pricing.cache_input).usd);
      const options = caps.reasoningEffortOptions;
      return [
        {
          id: row.id,
          name: typeof spec.name === 'string' && spec.name ? spec.name : row.id,
          context: numberOf(spec.availableContextTokens) || null,
          tools: bool(caps.supportsFunctionCalling),
          vision: bool(caps.supportsVision),
          multipleImages: bool(caps.supportsMultipleImages),
          offline: bool(spec.offline),
          ...(caps.supportsReasoningEffort === false
            ? { reasoningEfforts: [] }
            : caps.supportsReasoningEffort === true && Array.isArray(options)
              ? { reasoningEfforts: options.filter(isEffort) }
              : {}),
          price:
            input != null && output != null ? { in: input, out: output, ...(cached != null ? { cached } : {}) } : null,
        },
      ];
    }
    const pricing = objectOf(row.pricing);
    const input = numberOf(pricing.prompt);
    const output = numberOf(pricing.completion);
    return [
      {
        id: row.id,
        name: typeof row.name === 'string' && row.name ? row.name : row.id,
        context: numberOf(row.context_length) || null,
        tools:
          provider === 'openrouter'
            ? Array.isArray(row.supported_parameters) && row.supported_parameters.includes('tools')
            : true,
        price: input != null && output != null ? { in: input * 1e6, out: output * 1e6 } : null,
      },
    ];
  });
}
