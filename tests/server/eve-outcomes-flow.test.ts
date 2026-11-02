import http from 'node:http';
import { once } from 'node:events';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { agents, chats, saveSettings } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { startRun, stopAllRuns } from '../../server/engines/index.ts';
import { decide, durableApproval, ensureDurableApproval, listApprovals } from '../../server/approvals.ts';
import { operationsForRun } from '../../server/eve/operations.ts';
import { readRun } from '../../server/eve/state.ts';
import { prepareEveRecovery } from '../../server/eve/recovery.ts';
import { eveCoordinator } from '../../server/eve/coordinator.ts';
import { eveRuntime } from '../../server/eve/runtime.ts';
import * as mcp from '../../server/mcp.ts';

let model: http.Server | undefined;
afterAll(async () => {
  await stopAllRuns();
  await eveCoordinator.close();
  await eveRuntime.close();
  model?.closeAllConnections();
  if (model) await new Promise<void>((resolve) => model!.close(() => resolve()));
  vi.restoreAllMocks();
});

describe('Eve tool outcomes in a live run', () => {
  it('keeps an uncertain outcome for user review after run cleanup and recovery', async () => {
    model = http.createServer(async (request, response) => {
      if (request.url?.endsWith('/models')) return response.end(JSON.stringify({ data: [] }));
      for await (const _part of request) { /* drain the model request */ }
      const delta = { tool_calls: [{ index: 0, id: 'change-call', type: 'function', function: { name: 'actions__change', arguments: '{}' } }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const address = model.address();
    if (!address || typeof address === 'string') throw new Error('No test port.');
    saveSettings({ providers: { custom: { baseUrl: `http://127.0.0.1:${address.port}/v1`, label: 'Outcome fixture' } }, contextWindowTokens: 64000, brainApproves: false, brainFollowsUp: false });
    mcp.saveServer('actions', { type: 'http', url: 'http://127.0.0.1:1/mcp', enabled: true });
    vi.spyOn(mcp, 'listTools').mockResolvedValue([{ name: 'change', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false, destructiveHint: true } }]);
    const execute = vi.spyOn(mcp, 'callTool').mockRejectedValue(new Error('The connection failed after making part of the change.'));
    const agent = agents.save(newAgent({ name: 'Outcome review', engine: 'eve', provider: 'custom', model: 'mock', autonomy: 'full', toolGroups: [], mcpServers: ['actions'], richAnswers: false }));
    const run = startRun(agent, chats.create(agent.id), 'Make the change.');
    const ordinary = ensureDurableApproval('ordinary-wait', { title: 'Another pending action', agentId: agent.id, data: { runId: run.runId } });

    expect(await run.promise).toBe('');
    expect(readRun(run.runId)?.status).toBe('interrupted');
    const operation = operationsForRun(run.runId)[0]!;
    expect(operation.status).toBe('uncertain');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(durableApproval(ordinary.operationId)?.decision?.approved).toBe(false);
    const review = listApprovals().find((item) => item.data.runId === run.runId);
    expect(review).toMatchObject({ kind: 'workflow', data: { outcomeCheck: true } });
    expect(durableApproval(`reconcile:${operation.id}`)?.decision).toBeUndefined();

    prepareEveRecovery();
    expect(listApprovals().filter((item) => item.data.runId === run.runId)).toEqual([review]);
    expect(decide(review!.id, { approved: true })).toBe(true);
    expect(listApprovals().some((item) => item.id === review!.id)).toBe(false);
    expect(readRun(run.runId)?.status).toBe('interrupted');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
