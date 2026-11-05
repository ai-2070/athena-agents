// The teams themselves over oRPC (server/api/workflows.ts): making one with its defaults, changing it (only an
// emoji for its symbol, only uploads for its files, never its picture file), a field of the wrong kind refused in
// plain words, copying and deleting it, its picture, the starter teams, and the runs of old step lists.
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';
import { newAgent } from '../../server/library.ts';
import { agents, runs, workflows } from '../../server/store.ts';
import type { Team, WorkflowRun } from '../../shared/types.ts';

let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await handleRpc(req, res, '/api'))) res.writeHead(404).end();
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const send = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> & Record<number, unknown> };
};
const gone = { status: 404, json: { error: 'That team is unavailable.' } };

describe('teams over oRPC', () => {
  it('make a team off and unscheduled, and list it by name with who works and its last message', async () => {
    const a = newAgent({ name: 'Lead' });
    const made = (await send('POST', '/api/workflows', { name: 'Zebras', members: [a.id], lead: a.id, access: { toolGroups: ['files'] } })).json as unknown as Team;
    expect(made).toMatchObject({ name: 'Zebras', members: [a.id], lead: a.id, enabled: false, schedule: { type: 'none' }, access: { toolGroups: ['files'], mcpServers: [] } });
    await send('POST', '/api/workflows', { name: 'Aardvarks' });
    const names = ((await send('GET', '/api/workflows')).json as unknown as (Team & { state: unknown; last: unknown })[]).map((t) => t.name);
    expect(names.indexOf('Aardvarks')).toBeLessThan(names.indexOf('Zebras'));
    expect((await send('GET', `/api/workflows/${made.id}`)).json).toMatchObject({ id: made.id, name: 'Zebras' });
    expect(await send('GET', '/api/workflows/nobody')).toEqual(gone);
  });

  it('keep what a change leaves out, and take only an emoji for its symbol and never a picture file', async () => {
    const t = workflows.save({ name: 'Symbols', description: 'Keep me', members: [], lead: null, steps: [], mark: '🎬' } as Partial<Team>);
    const changed = (await send('PUT', `/api/workflows/${t.id}`, { name: 'Renamed', mark: '@', markFile: { kind: 'image', ext: 'png', at: 1 }, state: { working: [] } })).json;
    expect(changed).toMatchObject({ id: t.id, name: 'Renamed', description: 'Keep me', mark: '' });
    expect(changed.markFile).toBeUndefined();
    expect(workflows.get(t.id)).not.toHaveProperty('state');
    expect(await send('PUT', '/api/workflows/nobody', { name: 'x' })).toEqual(gone);
  });

  it('refuse a field of the wrong kind in plain words', async () => {
    const t = workflows.save({ name: 'Strict', members: [], lead: null, steps: [] } as Partial<Team>);
    expect(await send('PUT', `/api/workflows/${t.id}`, { enabled: 'yes' })).toEqual({ status: 400, json: { error: 'enabled must be true or false.' } });
    expect(await send('PUT', `/api/workflows/${t.id}`, { members: 'a1' })).toEqual({ status: 400, json: { error: 'members must be a list.' } });
    expect(await send('POST', '/api/workflows', { steps: [{ prompt: 'no type' }] })).toMatchObject({ status: 400 });
    expect(await send('POST', `/api/workflows/${t.id}/clone`, { withAgents: 'please' })).toEqual({ status: 400, json: { error: 'withAgents must be true or false.' } });
  });

  it('keep the settings a step carries', async () => {
    const t = (await send('POST', '/api/workflows', { name: 'Steps', steps: [{ id: 's1', type: 'tool', tool: 'web_search', args: { q: 'news' } }] })).json as unknown as Team;
    expect(workflows.get(t.id)?.steps).toEqual([{ id: 's1', type: 'tool', tool: 'web_search', args: { q: 'news' } }]);
  });

  it('copy a team, with copies of its agents or sharing them', async () => {
    const a = newAgent({ name: 'Baker' });
    const t = workflows.save({ name: 'Bakery', members: [a.id], lead: a.id, steps: [{ type: 'agent', agentId: a.id }] } as Partial<Team>);
    expect((await send('POST', `/api/workflows/${t.id}/clone`)).json).toMatchObject({ name: 'Bakery (copy)', members: [a.id] });
    const deep = (await send('POST', `/api/workflows/${t.id}/clone`, { withAgents: true })).json as unknown as Team;
    expect(deep.members).toHaveLength(1);
    expect(deep.members[0]).not.toBe(a.id);
    expect(await send('POST', '/api/workflows/nobody/clone')).toEqual(gone);
  });

  it('delete a team with the agents on no other team', async () => {
    const solo = newAgent({ name: 'Solo' });
    const shared = newAgent({ name: 'Shared' });
    const t = workflows.save({ name: 'Doomed', members: [solo.id, shared.id], lead: solo.id, steps: [] } as Partial<Team>);
    workflows.save({ name: 'Survivor', members: [shared.id], lead: null, steps: [] } as Partial<Team>);
    expect(await send('DELETE', `/api/workflows/${t.id}`)).toEqual({ status: 200, json: { ok: true, deletedAgents: [solo.id] } });
    expect(agents.get(solo.id)).toBeNull();
    expect(agents.get(shared.id)).not.toBeNull();
    expect(await send('DELETE', `/api/workflows/${t.id}`)).toEqual({ status: 200, json: { ok: true } });
  });

  it('refuse a picture that is not one in its own words, and a team that is gone', async () => {
    const t = workflows.save({ name: 'Pictured', members: [], lead: null, steps: [] } as Partial<Team>);
    expect(await send('POST', `/api/workflows/${t.id}/mark`, { name: 'bad.png', data: 'data:image/png;base64,AAAA' })).toEqual({ status: 400, json: { error: "That file isn't a real .png." } });
    expect(await send('POST', `/api/workflows/${t.id}/mark`, { name: 'notes.txt', data: 'data:text/plain;base64,AAAA' })).toMatchObject({ status: 400 });
    expect(await send('POST', `/api/workflows/${t.id}/mark`, { name: 'x.png' })).toEqual({ status: 400, json: { error: "Couldn't read that file." } });
    expect((await send('DELETE', `/api/workflows/${t.id}/mark`)).json).toMatchObject({ id: t.id, markFile: null });
    expect(await send('DELETE', '/api/workflows/nobody/mark')).toEqual(gone);
    expect(await send('POST', '/api/workflows/nobody/run', { input: 'go' })).toEqual(gone);
  });

  it('list the starter teams and make one, and refuse one that does not exist', async () => {
    const templates = (await send('GET', '/api/workflow-templates')).json as unknown as { name: string; needs: string[] }[];
    expect(templates.length).toBeGreaterThan(0);
    expect(templates[0]).toEqual({ name: expect.any(String), description: expect.any(String), needs: expect.any(Array) });
    expect((await send('POST', '/api/workflow-templates', { name: templates[0].name })).json).toMatchObject({ name: templates[0].name });
    expect(await send('POST', '/api/workflow-templates', { name: 'No such team' })).toEqual({ status: 404, json: { error: 'Pick one of the starter teams.' } });
  });

  it('list the runs, newest first and for one team, the running ones, and stop one that is not going', async () => {
    const run = (id: string, workflowId: string, createdAt: number, status = 'done') =>
      runs.save({ id, workflowId, workflowName: 'W', input: '', trigger: 'manual', status, steps: [{ label: 'Think', type: 'agent', status, output: null, agentId: 'a1' }], createdAt } as WorkflowRun);
    run('wr-old', 'wf-a', 1);
    run('wr-new', 'wf-a', 3);
    run('wr-other', 'wf-b', 2, 'running');
    expect(((await send('GET', '/api/workflow-runs?workflowId=wf-a')).json as unknown as WorkflowRun[]).map((r) => r.id)).toEqual(['wr-new', 'wr-old']);
    expect((await send('GET', '/api/workflow-active')).json).toContainEqual({ id: 'wr-other', workflowId: 'wf-b', status: 'running', steps: [{ status: 'running', label: 'Think', agentId: 'a1' }], error: null });
    expect(await send('POST', '/api/workflow-runs/wr-old/stop')).toEqual({ status: 200, json: { ok: false } });
  });
});
