// API runtimes and model discovery share the provider catalog.
import { getSettings, getSecrets } from './store.ts';
import { resolveApiProvider } from './apiproviders.ts';
import type { Agent, ApiModelInfo, EngineStatus } from '../shared/types.ts';
export { PROVIDERS, listApiModels as listModels } from './apiproviders.ts';
export type { ProviderDef, ApiProvider as Provider } from './apiproviders.ts';
export type ModelInfo = ApiModelInfo;

export function status(): EngineStatus['eve'] {
  return { openrouter: !!getSecrets().openrouterKey, venice: !!getSecrets().veniceKey, custom: !!getSettings().providers.custom.baseUrl };
}

export const providerOf = (agent: Pick<Agent, 'provider'>) => resolveApiProvider(agent.provider || 'openrouter');
