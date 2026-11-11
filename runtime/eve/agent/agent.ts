import { defineAgent, defineDynamic } from 'eve';
import { runs, usage } from 'eve/events';
import { bindingOf, bridgeCall, configuration } from './lib/bridge.ts';
import { athenaModel, reachedCostLimit } from './lib/model.ts';

export default defineAgent({
  defaultTools: false,
  experimental: { workflow: { world: '@athena/eve-world' } },
  build: { externalDependencies: ['@athena/eve-world', '@workflow/world-local'] },
  model: defineDynamic(async (ctx) => {
    const config = await configuration(ctx);
    const totalCost = () => usage(ctx.view).byKind.model?.costUsd || 0;
    const loadedCost = totalCost();
    const steps = ctx.turn
      ? runs(ctx.view, { turnId: ctx.turn.id }).filter((run) => run.status === 'settled').length
      : 0;
    return {
      model: athenaModel(
        config,
        async (reportedCost) => {
          // A replayed checkpoint cannot retain permission after Stop, deletion or an update.
          const current = await configuration(ctx);
          if (current.runId !== config.runId) throw new Error('This model step no longer belongs to the active turn.');
          // A summary can finish before Eve refreshes this dynamic value's view.
          const cost = Math.max(totalCost(), loadedCost + reportedCost, config.costBaseline + (current.spentUsd || 0));
          const limit =
            steps >= config.maxModelSteps
              ? 'steps'
              : reachedCostLimit(cost, config.costBaseline, config.costLimitUsd)
                ? 'cost'
                : null;
          if (!limit) return;
          const result = await bridgeCall(bindingOf(ctx), '/limit', {
            sessionId: ctx.session.id,
            runId: config.runId,
            limit,
          });
          throw new Error(
            result && typeof result === 'object' && 'reason' in result
              ? String(result.reason)
              : 'This run reached its limit.',
          );
        },
        async (charge) => {
          await bridgeCall(bindingOf(ctx), '/billing', { sessionId: ctx.session.id, runId: config.runId, charge });
        },
      ),
      modelContextWindowTokens: config.contextWindow,
    };
  }),
});
