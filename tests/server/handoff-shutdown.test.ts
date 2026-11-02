import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { chats } from '../../server/store.ts';
import { readExecution } from '../../server/execution.ts';
import { awaitHandoff } from '../../server/handoffs.ts';
import { nativeRunPromise, recoverExecution, stopAllRuns } from '../../server/engines/index.ts';
import { readRun } from '../../server/eve/state.ts';
import { eveCoordinator } from '../../server/eve/coordinator.ts';
import { eveRuntime } from '../../server/eve/runtime.ts';

let model: http.Server | undefined;
let child: ChildProcess | undefined;
afterAll(async () => {
  child?.kill();
  await stopAllRuns();
  await eveCoordinator.close();
  await eveRuntime.close();
  model?.closeAllConnections();
  if (model) await new Promise<void>((resolve) => model!.close(() => resolve()));
});

describe('delegated Eve work at shutdown', () => {
  it('keeps its handle pending and collects the answer after a new dashboard restores the run', async () => {
    let requests = 0;
    let answering = false;
    model = http.createServer(async (request, response) => {
      if (request.url?.endsWith('/models')) return response.end(JSON.stringify({ data: [] }));
      for await (const _part of request) { /* drain the model request */ }
      requests++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      if (answering) response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Recovered handoff answer' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const address = model.address();
    if (!address || typeof address === 'string') throw new Error('No test port.');
    // The first dashboard closes normally while the provider is still answering.
    const script = `
      import { newAgent } from './server/library.ts';
      import { saveSettings } from './server/store.ts';
      import { startHandoff } from './server/handoffs.ts';
      import { stopAllRuns } from './server/engines/index.ts';
      import { eveCoordinator } from './server/eve/coordinator.ts';
      import { eveRuntime } from './server/eve/runtime.ts';
      saveSettings({providers:{custom:{baseUrl:'http://127.0.0.1:${address.port}/v1'}},contextWindowTokens:64000,brainFollowsUp:false});
      const boss = newAgent({name:'Shutdown caller',engine:'eve'});
      const helper = newAgent({name:'Shutdown helper',engine:'eve',provider:'custom',model:'mock',toolGroups:[],richAnswers:false});
      const handoff = await startHandoff(boss, helper, 'Finish this delegated task', {depth:1});
      await new Promise((resolve) => process.stdin.once('data', resolve));
      await stopAllRuns();
      await handoff.done;
      await eveCoordinator.close();
      await eveRuntime.close();
      console.log(JSON.stringify({id:handoff.id,runId:handoff.runId,askerId:boss.id}));
      process.exit(0);
    `;
    child = spawn('bun', ['--eval', script], { env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const exited = once(child, 'exit');
    await expect.poll(() => requests).toBe(1);
    child.stdin!.end('shutdown');
    const [code] = await exited;
    expect(code, stderr).toBe(0);
    const handle = JSON.parse(stdout.trim()) as { id: string; runId: string; askerId: string };
    const saved = readExecution().handoffs.find((item) => item.id === handle.id)!;
    expect(saved.endedAt).toBeUndefined();
    expect(saved.error).toBeUndefined();
    expect(readExecution().runs.find((run) => run.id === handle.runId)).toMatchObject({ status: 'running' });
    const deliveryId = readRun(handle.runId)!.deliveryId;

    answering = true;
    await eveRuntime.recover();
    eveCoordinator.restore();
    recoverExecution();
    const done = nativeRunPromise(handle.runId)!;
    expect(done).toBeDefined();
    eveCoordinator.start();
    expect(await done).toBe('Recovered handoff answer');
    expect(await awaitHandoff(handle.id, handle.askerId)).toEqual({ text: 'Shutdown helper says:\nRecovered handoff answer' });
    expect(readRun(handle.runId)!.deliveryId).toBe(deliveryId);
    expect(chats.get(saved.to, saved.chatId)!.items.filter((item) => item.type === 'user')).toHaveLength(1);
    expect(requests).toBe(2);
  });
});
