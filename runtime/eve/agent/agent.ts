import { defineAgent, defineDynamic } from 'eve';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { configuration } from './lib/bridge.ts';

export default defineAgent({
  defaultTools: false,
  experimental: { workflow: { world: '@athena/eve-world' } },
  build: { externalDependencies: ['@athena/eve-world', '@workflow/world-local'] },
  model: defineDynamic(async (ctx) => {
    const config = await configuration(ctx);
    const provider = createOpenAICompatible({ name: 'athena', baseURL: config.baseUrl, apiKey: config.apiKey, headers: config.headers });
    return { model: provider(config.model), modelContextWindowTokens: config.contextWindow };
  }),
});
