import { defineAgent, defineDynamic } from 'eve';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { configuration } from './lib/bridge.ts';

export default defineAgent({
  defaultTools: false,
  model: defineDynamic(async (ctx) => {
    const config = await configuration(ctx);
    const provider = createOpenAICompatible({ name: 'athena', baseURL: config.baseUrl, apiKey: config.apiKey });
    return { model: provider(config.model), modelContextWindowTokens: config.contextWindow };
  }),
});
