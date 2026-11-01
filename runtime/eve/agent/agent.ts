import { defineAgent, defineDynamic } from 'eve';
import { runs } from 'eve/events';
import { bindingOf, bridgeCall, configuration } from './lib/bridge.ts';
import { athenaModel, reachedCostLimit } from './lib/model.ts';

export default defineAgent({
  defaultTools: false,
  experimental: { workflow: { world: '@athena/eve-world' } },
  build: { externalDependencies: ['@athena/eve-world', '@workflow/world-local'] },
  model: defineDynamic(async (ctx) => {
    const config = await configuration(ctx);
    const totalCost = () => runs(ctx.view).reduce((sum, run) => sum + (run.usage?.costUsd || 0), 0);
    const steps = ctx.turn ? runs(ctx.view, { turnId: ctx.turn.id }).filter((run) => run.status === 'settled').length : 0;
    return { model: athenaModel(config, async () => {
      const limit = steps >= config.maxModelSteps ? 'steps' : reachedCostLimit(totalCost(), config.costBaseline, config.costLimitUsd) ? 'cost' : null;
      if (!limit) return;
      const result = await bridgeCall(bindingOf(ctx), '/limit', { sessionId: ctx.session.id, runId: config.runId, limit });
      throw new Error(result && typeof result === 'object' && 'reason' in result ? String(result.reason) : 'This run reached its limit.');
    }), modelContextWindowTokens: config.contextWindow };
  }),
});
