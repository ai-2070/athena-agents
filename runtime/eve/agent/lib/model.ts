import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { MetadataExtractor } from '@ai-sdk/openai-compatible';
import { randomUUID } from 'node:crypto';
import { apiRequestOptions } from '../../../../server/apioptions.ts';
import { completionBilling } from '../../../../server/apibilling.ts';
import { numberOf, objectOf } from '../../../../server/apiresponse.ts';
import type { EveModelCharge, EveRuntimeConfiguration } from '../../../../shared/types.ts';

function reportedCost(value: unknown): number | undefined {
  if (!value || typeof value !== 'object' || !('usage' in value)) return;
  const usage = value.usage;
  if (!usage || typeof usage !== 'object' || !('cost' in usage) || usage.cost == null) return;
  const cost = typeof usage.cost === 'number' || typeof usage.cost === 'string' && usage.cost.trim() ? Number(usage.cost) : NaN;
  return Number.isFinite(cost) && cost >= 0 ? cost : undefined;
}

// Eve reads the AI SDK's gateway cost field for direct providers as well.
const costMetadata = (cost: number | undefined) => cost === undefined ? undefined : { gateway: { cost } };
function metadataExtractorFor(config: EveRuntimeConfiguration): MetadataExtractor {
  const metadata = (body: unknown) => {
    if (config.provider !== 'venice') return costMetadata(reportedCost(body));
    const result = completionBilling(objectOf(body).usage, objectOf(body).cost, config.price || null);
    return { ...costMetadata(result.cost), athena: { billing: { ...result.billing } } };
  };
  return {
    extractMetadata: async ({ parsedBody }) => metadata(parsedBody),
    createStreamExtractor: () => {
      let body: Record<string, unknown> = {};
      return {
        processChunk: (chunk) => {
          const part = objectOf(chunk);
          body = { ...body, ...part, usage: { ...objectOf(body.usage), ...objectOf(part.usage) }, cost: config.provider === 'venice' ? { ...objectOf(body.cost), ...objectOf(part.cost) } : part.cost ?? body.cost };
        },
        buildMetadata: () => metadata(body),
      };
    },
  };
}

export function reachedCostLimit(total: number, baseline: number, limit: number): boolean {
  const spent = total - baseline;
  // Subtracting a previous turn's decimal cost must not buy an extra model call.
  const rounding = Number.EPSILON * Math.max(total, baseline, limit) * 4;
  return limit > 0 && spent > 0 && spent + rounding >= limit;
}

export function athenaModel(config: EveRuntimeConfiguration, beforeCall?: (reportedCost: number) => Promise<void>, onCharge?: (charge: EveModelCharge) => Promise<void>) {
  const provider = createOpenAICompatible({
    name: 'athena', baseURL: config.baseUrl, apiKey: config.apiKey, headers: config.headers, includeUsage: true, metadataExtractor: metadataExtractorFor(config),
    transformRequestBody: (body: Record<string, unknown>) => {
      const { reasoning_effort: _effort, ...rest } = body;
      return {
        ...rest, ...apiRequestOptions(config.provider, config.model, config.effort, config.cacheKey, body.stream === true),
        ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
      };
    },
  });
  const model = provider(config.model);
  let reportedCost = 0;
  const charge = async (metadata: unknown) => {
    const cost = numberOf(objectOf(objectOf(metadata).gateway).cost);
    const billing = objectOf(objectOf(objectOf(metadata).athena).billing);
    const source = billing.source;
    if (config.provider === 'venice' && (source === 'reported' || source === 'estimated' || source === 'unavailable')) {
      const usd = numberOf(billing.chargedUsd);
      const diem = numberOf(billing.chargedDiem);
      await onCharge?.({ id: randomUUID(), ...(cost === null ? {} : { cost }), billing: { source, ...(usd === null ? {} : { chargedUsd: usd }), ...(diem === null ? {} : { chargedDiem: diem }) } });
    }
    if (cost !== null) reportedCost += cost;
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
    const userImages = prompt.flatMap((message) => message.role === 'user' ? message.content.filter((part) => part.type === 'file' && part.mediaType.startsWith('image/')) : []);
    const keep = new Set(config.capabilities?.vision === false ? [] : config.capabilities?.multipleImages === false ? userImages.slice(-1) : userImages);
    return { ...options, prompt: prompt.map((message) => message.role !== 'user' ? message : { ...message, content: message.content.map((part) => part.type === 'file' && part.mediaType.startsWith('image/') && !keep.has(part)
      ? { type: 'text' as const, text: config.capabilities?.vision === false ? "(attached image: this model can't see images)" : '(earlier image omitted: this model accepts one image per request)' } : part) }) };

  };
  return {
    specificationVersion: model.specificationVersion, provider: model.provider, modelId: model.modelId, supportedUrls: model.supportedUrls,
    doGenerate: async (options: Parameters<typeof model.doGenerate>[0]) => {
      await beforeCall?.(reportedCost);
      const result = await model.doGenerate(withToolImages(options));
      await charge(result.providerMetadata);
      return result;
    },
    doStream: async (options: Parameters<typeof model.doStream>[0]) => {
      await beforeCall?.(reportedCost);
      const result = await model.doStream(withToolImages(options));
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({ async transform(part, controller) {
        if (part.type === 'finish') await charge(part.providerMetadata);
        controller.enqueue(part);
      } })) };
    },
  };
}
