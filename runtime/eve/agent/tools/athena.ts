import { defineDynamic, defineTool, toolOutput } from 'eve/tools';
import { z } from 'zod';
import { bindingOf, bridgeCall, configuration } from '../lib/bridge.ts';

const policyResult = z.object({ status: z.enum(['approved', 'user-approval', 'denied']), reason: z.string().optional() });

export default defineDynamic(async (ctx) => {
  const config = await configuration(ctx);
  const binding = bindingOf(ctx);
  return Object.fromEntries(config.tools.map((tool) => [tool.name, defineTool({
    description: tool.description,
    inputSchema: tool.inputSchema,
    approval: async (call) => {
      const result = policyResult.parse(await bridgeCall(binding, '/policy', { sessionId: call.session.id, runId: config.runId, callId: call.callId, name: tool.name, args: call.toolInput }, call.abortSignal));
      return result.status === 'denied' ? { type: 'denied', reason: result.reason || 'The call is not allowed.' } : result.status;
    },
    toModelOutput: (output: unknown) => toolOutput.text(z.object({ text: z.string() }).parse(output).text),
    execute: async (input, call) => bridgeCall(binding, '/tool', { sessionId: call.session.id, runId: config.runId, callId: call.callId, name: tool.name, args: input }, call.abortSignal),
  })]));
});
