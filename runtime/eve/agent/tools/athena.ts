import { defineDynamic, defineTool } from 'eve/tools';
import { bindingOf, bridgeCall, configuration } from '../lib/bridge.ts';

export default defineDynamic(async (ctx) => {
  const config = await configuration(ctx);
  const binding = bindingOf(ctx);
  return Object.fromEntries(config.tools.map((tool) => [tool.name, defineTool({
    description: tool.description,
    inputSchema: tool.inputSchema,
    execute: async (input, call) => bridgeCall(binding, '/tool', { sessionId: call.session.id, callId: call.callId, name: tool.name, args: input }, call.abortSignal),
  })]));
});
