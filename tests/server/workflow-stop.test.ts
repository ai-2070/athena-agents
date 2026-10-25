// Stopping a workflow while its last agent step is working records the run as stopped, not done.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { runs, saveSettings, workflows } from '../../server/store.ts';
import { startWorkflow, stopWorkflowRun } from '../../server/workflows.ts';
import type { Team } from '../../shared/types.ts';

// a fake model that never answers: it holds every request open until the client goes away
let server: http.Server;
let asked = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    asked++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    req.on('close', () => res.end());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  saveSettings({ providers: { custom: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, label: 'Fake model' } } });
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const until = async (ok: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};

describe('stopWorkflowRun()', () => {
  it('a run stopped during its final agent step ends stopped, and the step is not marked done', async () => {
    const a = newAgent({ name: 'Slow', engine: 'openai', provider: 'custom', model: 'mock', toolGroups: [] });
    const wf = workflows.save({ name: 'One step', steps: [{ id: 's1', type: 'agent', agentId: a.id, label: 'Think', prompt: '{{input}}' }] } as Partial<Team>);
    const before = asked;
    const run = await startWorkflow(wf.id, 'go');
    await until(() => asked > before);
    expect(stopWorkflowRun(run.id)).toBe(true);
    await until(() => runs.get(run.id)?.status !== 'running');
    const saved = runs.get(run.id)!;
    expect(saved.status).toBe('stopped');
    expect(saved.steps[0].status).not.toBe('done');
    expect(saved.steps[0].output).not.toBe('(no answer)');
  });
});
