import { cacheFields } from './promptcache.ts';
import type { Effort } from '../shared/types.ts';

export function apiRequestOptions(
  provider: string,
  model: string,
  effort: Effort | '',
  session?: string,
  stream = true,
): Record<string, unknown> {
  return {
    ...(stream
      ? {
          stream: true,
          ...(provider === 'openrouter' ? { usage: { include: true } } : { stream_options: { include_usage: true } }),
        }
      : {}),
    ...(effort ? (provider === 'openrouter' ? { reasoning: { effort } } : { reasoning_effort: effort }) : {}),
    ...(provider === 'venice'
      ? {
          venice_parameters: {
            include_venice_system_prompt: false,
            strip_thinking_response: true,
            enable_web_search: 'off',
            enable_web_scraping: false,
            enable_x_search: false,
          },
        }
      : {}),
    ...cacheFields(provider, model, session),
  };
}
