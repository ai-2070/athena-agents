// Stop or Clear while a team's work waits: a message you sent into it isn't posted into what replaced it (BH-128),
// and a turn that finished while it waited for its missed messages posts nothing after Stop (BH-129).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { saveSettings, workflows } from '../../server/store.ts';
import { getThread, postUserMessage, steerTeam, stopTeam, teamState } from '../../server/teams.ts';
import type { Team } from '../../shared/types.ts';

// missedMessages waits for the test when it says so (it can take a while for real: up to 20 s)
const gate = vi.hoisted(() => ({ hold: false, reached: false, release: () => {} }));
vi.mock('../../server/engines/index.ts', async (original) => {
  const real = await original<typeof import('../../server/engines/index.ts')>();
  return {
    ...real,
    missedMessages: async (runId: string) => {
      if (gate.hold) {
        gate.reached = true;
        await new Promise<void>((r) => (gate.release = r));
      }
      return real.missedMessages(runId);
    },
  };
});

// a fake model: each request waits until the test lets it answer
let server: http.Server;
const held: { all: string; release: () => void; closed: boolean }[] = [];
beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url?.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    let body = '';
    for await (const c of req) body += c;
    const h = { all: body, release: () => {}, closed: false };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await new Promise<void>((release) => {
      h.release = release;
      res.once('close', () => ((h.closed = true), release()));
      held.push(h);
    });
    if (h.closed) return;
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'OLD REPLY' } }] })}\n\n`);
    res.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  saveSettings({
    providers: { custom: { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, label: 'Fake' } },
  });
});
afterAll(() => {
  gate.release();
  for (const h of held.splice(0)) h.release();
  return new Promise<void>((r) => server.close(() => r()));
});

const until = async (ok: () => boolean, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
};
const team = (name: string) => {
  const worker = newAgent({ name: `${name} worker`, engine: 'eve', provider: 'custom', model: 'mock', toolGroups: [] });
  return {
    worker,
    team: workflows.save({
      name,
      description: 'x',
      members: [worker.id],
      lead: worker.id,
      steps: [],
    } as Partial<Team>),
  };
};
const texts = (t: Team) => getThread(t.id).messages.map((m) => m.text);

describe('Stop while team work waits', () => {
  it('a message that waited for the turns to end is not posted after Stop', async () => {
    const { team: t, worker } = team('Steer stop');
    await postUserMessage(t.id, 'do the long job');
    await until(() => held.some((h) => !h.closed && h.all.includes('do the long job')));
    // (it names someone, so the worker's turn stops for it instead of taking it in)
    const steering = steerTeam(t.id, `@${worker.name} make it blue`);
    const answer = steering.then(
      () => null,
      (e: unknown) => e as Error & { status?: number },
    );
    await new Promise((r) => setTimeout(r, 0));
    stopTeam(t.id);
    const refused = await answer;
    expect(refused?.status).toBe(409);
    expect(texts(t).some((x) => x.includes('make it blue'))).toBe(false);
    await until(() => !teamState(t.id).working.length);
  }, 40000);

  it('a turn that ended while it waited for its missed messages posts nothing after Stop', async () => {
    const { team: t } = team('Missed stop');
    gate.hold = true;
    gate.reached = false;
    await postUserMessage(t.id, 'answer this');
    await until(() => held.some((h) => !h.closed && h.all.includes('answer this')));
    held.find((h) => !h.closed && h.all.includes('answer this'))!.release();
    await until(() => gate.reached);
    stopTeam(t.id);
    gate.hold = false;
    gate.release();
    await new Promise((r) => setTimeout(r, 300));
    expect(texts(t).some((x) => x.includes('OLD REPLY'))).toBe(false);
    expect(texts(t).at(-1)).toContain('Stopped.');
  }, 40000);
});
