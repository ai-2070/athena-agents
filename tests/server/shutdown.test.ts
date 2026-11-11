// When the server stops (the desktop app quits, Ctrl+C), every agent run is stopped first and no new one starts.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { activeProject, chats, saveSettings, workflows } from '../../server/store.ts';
import { activeRuns, queueMessage, queuedMessages, startRun, stopAllRuns } from '../../server/engines/index.ts';
import { readExecution } from '../../server/execution.ts';
import { postUserMessage, queueUserMessage, teamState } from '../../server/teams.ts';
import { readTeamWork } from '../../server/teamwork.ts';
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
  saveSettings({
    providers: {
      custom: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, label: 'Fake model' },
    },
  });
});
afterAll(async () => {
  const { eveRuntime } = await import('../../server/eve/runtime.ts');
  await eveRuntime.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('stopAllRuns()', () => {
  it('stops every run, waits for them to end, and refuses new ones', async () => {
    const a = newAgent({ name: 'Busy', engine: 'eve', provider: 'custom', model: 'mock', toolGroups: [] });
    const chat = chats.create(a.id, 'One');
    const run = startRun(a, chat, 'go');
    queueMessage(a, chat, 'saved for later');
    const team = workflows.save({ name: 'Busy team', members: [a.id], lead: a.id, steps: [] } as Partial<Team>);
    await postUserMessage(team.id, 'Team job');
    await queueUserMessage(team.id, 'Next team job');
    const ended = run.promise.catch(() => 'stopped');
    await expect.poll(() => asked, { timeout: 20000 }).toBeGreaterThan(0);
    await stopAllRuns();
    expect(run.signal.aborted).toBe(true);
    expect(activeRuns()).toHaveLength(0);
    await ended;
    await expect.poll(() => teamState(team.id).working.length).toBe(0);
    const work = readTeamWork(activeProject().id, team.id)!;
    expect([...work.current, ...work.interrupted]).toHaveLength(1);
    expect(teamState(team.id).held?.map((q) => q.text)).toEqual(['Next team job']);
    expect(queuedMessages(chat.id).map((q) => q.text)).toEqual(['saved for later']);
    expect(readExecution().runs[0]).toMatchObject({ status: 'running' });
    expect(readExecution().runs[0]?.stopRequested).not.toBe(true);
    expect(queuedMessages(chat.id).map((q) => q.text)).toEqual(['saved for later']);
    expect(readExecution().queues[0]?.items[0]?.text).toBe('saved for later');
    expect(() => startRun(a, chats.create(a.id, 'Two'), 'again')).toThrow(/stopping/);
  });
});
