import type { Settings } from './types.ts';

/** Hosted API defaults belong to their provider; local servers need an explicit model. */
export function defaultModelForEngine(engine: string, defaults: Partial<Settings['defaults']>, provider = 'openrouter'): string {
  if (engine === 'claude-code') return defaults.claudeModel || 'sonnet';
  if (engine !== 'openai') return '';
  if (provider === 'venice') return defaults.veniceModel || '';
  return provider === 'openrouter' ? defaults.openrouterModel || '' : '';
}
