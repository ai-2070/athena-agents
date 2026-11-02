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

export function athenaModel(config: EveRuntimeConfiguration, beforeCall?: (reportedCost: number) => Promise<void>) {
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
  let reportedCost = 0;
  const charge = (metadata: unknown) => {
    if (!metadata || typeof metadata !== 'object' || !('gateway' in metadata)) return;
    const gateway = metadata.gateway;
    if (!gateway || typeof gateway !== 'object' || !('cost' in gateway)) return;
    const cost = Number(gateway.cost);
    if (gateway.cost != null && Number.isFinite(cost) && cost >= 0) reportedCost += cost;
  };
  type Prompt = Parameters<typeof model.doGenerate>[0]['prompt'];
  type UserPart = Extract<Prompt[number], { role: 'user' }>['content'][number];
  // Compatible APIs accept images in user content, while tool results stay text with their IDs.
  const withToolImages = (options: Parameters<typeof model.doGenerate>[0]) => {
    const prompt: Prompt = [];
    let images: UserPart[] = [];
    const flush = () => {
      if (images.length) prompt.push({ role: 'user', content: images });
      images = [];
    };
    for (const message of options.prompt) {
      if (message.role !== 'tool') { flush(); prompt.push(message); continue; }
      const content = message.content.map((part) => {
        if (part.type !== 'tool-result' || part.output.type !== 'content') return part;
        const text: string[] = [];
        for (const value of part.output.value) {
          if (value.type === 'file' && value.mediaType.startsWith('image/')) {
            if (value.data.type !== 'data' && value.data.type !== 'url') throw new Error('This tool image has no portable bytes.');
            images.push({ type: 'text', text: `Image returned by ${part.toolName} (${part.toolCallId}):` }, { type: 'file', data: value.data, mediaType: value.mediaType });
          } else if (value.type === 'text') text.push(value.text);
          else throw new Error('This tool returned content the model connection cannot read.');
        }
        return { ...part, output: { type: 'text' as const, value: text.join('\n') } };
      });
      prompt.push({ ...message, content });
    }
    flush();
    return { ...options, prompt };
  };
  return {
    specificationVersion: model.specificationVersion, provider: model.provider, modelId: model.modelId, supportedUrls: model.supportedUrls,
    doGenerate: async (options: Parameters<typeof model.doGenerate>[0]) => {
      await beforeCall?.(reportedCost);
      const result = await model.doGenerate(withToolImages(options));
      charge(result.providerMetadata);
      return result;
    },
    doStream: async (options: Parameters<typeof model.doStream>[0]) => {
      await beforeCall?.(reportedCost);
      const result = await model.doStream(withToolImages(options));
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({ transform(part, controller) {
        if (part.type === 'finish') charge(part.providerMetadata);
        controller.enqueue(part);
      } })) };
    },
  };
}
