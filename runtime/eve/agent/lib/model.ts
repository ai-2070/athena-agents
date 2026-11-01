import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { MetadataExtractor } from '@ai-sdk/openai-compatible';
import { cacheFields } from '../../../../server/promptcache.ts';
import type { EveRuntimeConfiguration } from '../../../../shared/types.ts';

function reportedCost(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !('usage' in value)) return;
  const usage = value.usage;
  if (!usage || typeof usage !== 'object' || !('cost' in usage) || usage.cost == null) return;
  const cost = typeof usage.cost === 'number' || typeof usage.cost === 'string' && usage.cost.trim() ? Number(usage.cost) : NaN;
  return Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

// Eve reads the AI SDK's gateway cost field for direct providers as well.
const costMetadata = (cost: number | undefined) => cost === undefined ? undefined : { gateway: { cost } };
const metadataExtractor: MetadataExtractor = {
  extractMetadata: async ({ parsedBody }) => costMetadata(reportedCost(parsedBody)),
  createStreamExtractor: () => {
    let cost: number | undefined;
    return {
      processChunk: (chunk) => { cost = reportedCost(chunk) ?? cost; },
      buildMetadata: () => costMetadata(cost),
    };
  },
};

export function reachedCostLimit(total: number, baseline: number, limit: number): boolean {
  const spent = total - baseline;
  // Subtracting a previous turn's decimal cost must not buy an extra model call.
  const rounding = Number.EPSILON * Math.max(total, baseline, limit) * 4;
  return limit > 0 && spent > 0 && spent + rounding >= limit;
}

export function athenaModel(config: EveRuntimeConfiguration, beforeCall?: () => Promise<void>) {
  const provider = createOpenAICompatible({
    name: 'athena', baseURL: config.baseUrl, apiKey: config.apiKey, headers: config.headers, includeUsage: true, metadataExtractor,
    transformRequestBody: (body: Record<string, unknown>) => {
      const { reasoning_effort: _effort, ...rest } = body;
      return {
        ...rest, ...cacheFields(config.provider, config.model, config.cacheKey),
        ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
        ...(config.effort ? config.provider === 'openrouter' ? { reasoning: { effort: config.effort } } : { reasoning_effort: config.effort } : {}),
      };
    },
  });
  const model = provider(config.model);
  return {
    specificationVersion: model.specificationVersion, provider: model.provider, modelId: model.modelId, supportedUrls: model.supportedUrls,
    doGenerate: async (options: Parameters<typeof model.doGenerate>[0]) => { await beforeCall?.(); return model.doGenerate(options); },
    doStream: async (options: Parameters<typeof model.doStream>[0]) => { await beforeCall?.(); return model.doStream(options); },
  };
}
