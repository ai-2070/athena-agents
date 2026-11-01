import { getSettings } from '../store.ts';
import { contextWindow } from '../compaction.ts';
import { providerOf } from '../providers.ts';
import { effortFor } from '../../shared/effort.ts';
import type { Agent, Chat, EveModelSelection } from '../../shared/types.ts';

/** Model options are selected once per turn; permission checks still use the current agent. */
export async function selectEveModel(agent: Agent, chat: Chat): Promise<EveModelSelection> {
  const provider = providerOf(agent);
  const settings = getSettings();
  const temperature = agent.temperature === '' || agent.temperature == null ? undefined : Number(agent.temperature);
  if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) throw new Error('Temperature must be between 0 and 2.');
  const maxModelSteps = settings.maxToolSteps || 16;
  const costLimitUsd = settings.costLimitUsdPerRun || 0;
  if (!Number.isSafeInteger(maxModelSteps) || maxModelSteps < 1) throw new Error('Max tool steps must be a positive whole number.');
  if (!Number.isFinite(costLimitUsd) || costLimitUsd < 0) throw new Error('The run cost limit must be zero or a positive number.');
  return {
    provider: provider.id, baseUrl: provider.base, model: agent.model || settings.defaults.openrouterModel,
    effort: effortFor('openai', agent.effort, provider.id), ...(temperature === undefined ? {} : { temperature }),
    contextWindow: await contextWindow(agent, chat), maxModelSteps, costLimitUsd,
  };
}
