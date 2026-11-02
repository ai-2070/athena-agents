import { getSettings } from '../store.ts';
import { contextWindow } from '../context.ts';
import { providerOf } from '../providers.ts';
import { effortFor } from '../../shared/effort.ts';
import { defaultModelForEngine } from '../../shared/modeldefaults.ts';
import { apiModelInfo } from '../apiproviders.ts';
import type { Agent, Chat, EveModelSelection } from '../../shared/types.ts';

/** Model options are selected once per turn; permission checks still use the current agent. */
export async function selectEveModel(agent: Agent, chat: Chat): Promise<EveModelSelection> {
  const provider = providerOf(agent);
  const settings = getSettings();
  const model = agent.model || defaultModelForEngine('eve', settings.defaults, provider.id);
  if (!model) throw new Error(`Choose a ${provider.label} model in Settings or for this agent first.`);
  const info = await apiModelInfo(provider.id, model);
  if (info?.offline) throw new Error(`${provider.label} model "${model}" is temporarily unavailable. Choose another model.`);
  const temperature = agent.temperature === '' || agent.temperature == null ? undefined : Number(agent.temperature);
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new Error('Temperature must be between 0 and 2.');
  const maxModelSteps = settings.maxToolSteps || 16;
  const costLimitUsd = settings.costLimitUsdPerRun || 0;
  if (!Number.isSafeInteger(maxModelSteps) || maxModelSteps < 1) throw new Error('Max tool steps must be a positive whole number.');
  if (!Number.isFinite(costLimitUsd) || costLimitUsd < 0) throw new Error('The run cost limit must be zero or a positive number.');
  return {
    provider: provider.id, baseUrl: provider.base, model,
    effort: effortFor('eve', agent.effort, provider.id, info?.reasoningEfforts), ...(temperature === undefined ? {} : { temperature }),
    ...(provider.id === 'venice' ? { capabilities: {
      ...(info?.tools === undefined ? {} : { tools: info.tools }),
      ...(info?.vision === undefined ? {} : { vision: info.vision }),
      ...(info?.multipleImages === undefined ? {} : { multipleImages: info.multipleImages }),
    }, price: info?.price || null } : {}),
    contextWindow: await contextWindow(agent, chat), maxModelSteps, costLimitUsd,
  };
}
