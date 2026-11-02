import { getSecrets, getSettings } from './store.ts';
import { PORT } from './util.ts';
import { VENICE_BASE } from './venice.ts';
import { normalizeApiModels } from './apimodels.ts';
import type { ApiModelInfo, ProviderId } from '../shared/types.ts';

export interface ProviderDef {
  label: string;
  base: () => string;
  key: () => string | undefined;
  needsKey?: boolean;
}

export interface ApiProvider {
  id: ProviderId;
  label: string;
  base: string;
  headers: Record<string, string>;
}

export const PROVIDERS: Record<ProviderId, ProviderDef> = {
  openrouter: { label: 'OpenRouter', base: () => 'https://openrouter.ai/api/v1', key: () => getSecrets().openrouterKey, needsKey: true },
  venice: { label: 'Venice', base: () => VENICE_BASE, key: () => getSecrets().veniceKey, needsKey: true },
  lmstudio: { label: 'LM Studio (local)', base: () => getSettings().providers.lmstudio.baseUrl, key: () => 'lm-studio' },
  ollama: { label: 'Ollama (local)', base: () => getSettings().providers.ollama.baseUrl, key: () => 'ollama' },
  custom: { label: 'Custom', base: () => getSettings().providers.custom.baseUrl, key: () => getSecrets().customKey || 'none' },
};

function definition(id: string): ProviderDef | undefined {
  return Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id as ProviderId] : undefined;
}

export function resolveApiProvider(id: string): ApiProvider {
  const p = definition(id);
  if (!p) throw new Error(`Unknown provider ${id}`);
  const base = p.base().replace(/\/$/, '');
  const key = p.key();
  if (!base) throw new Error(`${p.label} has no address. Set it in Settings.`);
  if (p.needsKey && !key) throw new Error(`Add your ${p.label} key in Settings first.`);
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  if (id === 'openrouter') Object.assign(headers, { 'HTTP-Referer': `http://localhost:${PORT}`, 'X-Title': 'Athena Agents' });
  return { id: id as ProviderId, label: p.label, base, headers };
}

const catalogs = new Map<string, { at: number; models: ApiModelInfo[] }>();
export const clearApiModelCache = (): void => catalogs.clear();

export function cachedApiModelInfo(id: string, model: string): ApiModelInfo | undefined {
  const hit = catalogs.get(`${id}|${definition(id)?.base().replace(/\/$/, '')}`);
  return hit && Date.now() - hit.at < 300_000 ? hit.models.find((m) => m.id === model) : undefined;
}

export async function listApiModels(id: string): Promise<ApiModelInfo[]> {
  const p = definition(id);
  const base = p?.base().replace(/\/$/, '');
  if (!p || !base) return [];
  try {
    const response = await fetch(`${base}/models${id === 'venice' ? '?type=text' : ''}`, {
      headers: id === 'venice' ? {} : { authorization: `Bearer ${p.key() || ''}` }, signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return [];
    const json: unknown = await response.json();
    const models = normalizeApiModels(json, id);
    catalogs.set(`${id}|${base}`, { at: Date.now(), models });
    return models;
  } catch {
    return [];
  }
}

/** Venice publishes model-specific capabilities; other providers keep their current behavior. */
export async function apiModelInfo(id: string, model: string): Promise<ApiModelInfo | undefined> {
  if (id !== 'venice') return undefined;
  const hit = catalogs.get(`${id}|${definition(id)?.base().replace(/\/$/, '')}`);
  const models = hit && Date.now() - hit.at < (hit.models.length ? 300_000 : 30_000) ? hit.models : await listApiModels(id);
  return models.find((m) => m.id === model);
}

export { apiRequestOptions } from './apioptions.ts';
