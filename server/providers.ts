// Model connections are shared by API runtimes and model discovery.
import { getSettings, getSecrets } from './store.ts';
import { PORT } from './util.ts';
import type { Agent, EngineStatus, ProviderId } from '../shared/types.ts';

export interface ProviderDef {
  label: string;
  base: () => string;
  key: () => string | undefined;
  needsKey?: boolean;
}

/** A provider ready to call: base URL without the trailing slash, and the request headers. */
export interface Provider {
  id: string;
  base: string;
  headers: Record<string, string>;
}

/** A model as GET /api/models lists it. price is USD per million tokens. */
export interface ModelInfo {
  id: string;
  name: string;
  context: number | null;
  tools: boolean;
  price: { in: number; out: number } | null;
}

/** A row of an OpenAI-compatible /models answer (OpenRouter adds the extra fields). */
interface ApiModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: { prompt: string; completion: string };
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  openrouter: { label: 'OpenRouter', base: () => 'https://openrouter.ai/api/v1', key: () => getSecrets().openrouterKey, needsKey: true },
  lmstudio: { label: 'LM Studio (local)', base: () => getSettings().providers.lmstudio.baseUrl, key: () => 'lm-studio' },
  ollama: { label: 'Ollama (local)', base: () => getSettings().providers.ollama.baseUrl, key: () => 'ollama' },
  custom: { label: 'Custom', base: () => getSettings().providers.custom.baseUrl, key: () => getSecrets().customKey || 'none' },
};

export function status(): EngineStatus['openai'] {
  return { openrouter: !!getSecrets().openrouterKey, custom: !!getSettings().providers.custom.baseUrl };
}

export function providerOf(agent: Agent): Provider {
  const id = agent.provider || 'openrouter';
  const p: ProviderDef | undefined = (PROVIDERS as Partial<Record<string, ProviderDef>>)[id];
  if (!p) throw new Error(`Unknown provider ${id}`);
  const base = (p.base() || '').replace(/\/$/, '');
  const key = p.key();
  if (!base) throw new Error(`${p.label} has no address. Set it in Settings.`);
  if (p.needsKey && !key) throw new Error('Add your OpenRouter key in Settings first.');
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  if (id === 'openrouter') Object.assign(headers, { 'HTTP-Referer': `http://localhost:${PORT}`, 'X-Title': 'Athena Agents' });
  return { id, base, headers };
}

export async function listModels(providerId: string): Promise<ModelInfo[]> {
  const p: ProviderDef | undefined = (PROVIDERS as Partial<Record<string, ProviderDef>>)[providerId];
  if (!p) return [];
  const base = (p.base() || '').replace(/\/$/, '');
  if (!base) return [];
  try {
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${p.key() || ''}` }, signal: AbortSignal.timeout(8000) });
    const j = (await res.json()) as { data?: ApiModel[] };
    return (j.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      context: m.context_length || null,
      tools: providerId === 'openrouter' ? (m.supported_parameters || []).includes('tools') : true,
      price: m.pricing ? { in: +m.pricing.prompt * 1e6, out: +m.pricing.completion * 1e6 } : null,
    }));
  } catch {
    return [];
  }
}
