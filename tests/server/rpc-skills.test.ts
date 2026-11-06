// Skills, version history, presets and the Agent library over oRPC (server/api/skills.ts, versions.ts, library.ts):
// a skill without a name or a description refused in plain words (a 400, not a 500), its versions and bringing one
// back, a kind of thing without versions, an agent kept as a preset and made again, and hiring from the library.
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';
import { newAgent } from '../../server/library.ts';
import * as presets from '../../server/presets.ts';
import { agents } from '../../server/store.ts';
import type { Agent, AgentPreset, LibraryIndex, Skill, VersionHistory } from '../../shared/types.ts';

let base = '';
const server = http.createServer(async (req, res) => {
  if (!(await handleRpc(req, res, '/api'))) res.writeHead(404).end();
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const send = async <T = Record<string, unknown>>(method: string, p: string, body?: unknown) => {
  const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as T };
};

describe('skills and their versions over oRPC', () => {
  it('write a skill, change it, see its versions and bring the first back', async () => {
    const made = (await send<Skill>('POST', '/api/skills', { name: 'Proofread', description: 'Use when checking text.', body: 'Read it twice.' })).json;
    expect(made).toMatchObject({ slug: expect.any(String), name: 'Proofread' });
    expect(made.body.trim()).toBe('Read it twice.');
    expect((await send<Skill>('PUT', `/api/skills/${made.slug}`, { name: 'Proofread', description: 'Use when checking text.', body: 'Read it three times.' })).json.body.trim()).toBe('Read it three times.');
    expect((await send<Skill>('GET', `/api/skills/${made.slug}`)).json.body.trim()).toBe('Read it three times.');
    const hist = (await send<VersionHistory>('GET', `/api/versions/skill/${made.slug}`)).json;
    expect(hist.versions.length).toBeGreaterThan(0);
    expect((await send('GET', `/api/versions/skill/${made.slug}/${hist.versions[0].id}`)).status).toBe(200);
    expect((await send('POST', `/api/versions/skill/${made.slug}/${hist.versions[0].id}/restore`)).json).toEqual({ name: 'Proofread' });
    expect(((await send<{ skills: Skill[] }>('GET', '/api/skills')).json.skills).some((s) => s.slug === made.slug)).toBe(true);
    expect(await send('DELETE', `/api/skills/${made.slug}`)).toEqual({ status: 200, json: { ok: true } });
    expect(await send('GET', `/api/skills/${made.slug}`)).toEqual({ status: 404, json: { error: 'That skill is unavailable.' } });
  });

  it('refuse a skill without a name or a description in plain words', async () => {
    expect(await send('POST', '/api/skills', { description: 'When?' })).toEqual({ status: 400, json: { error: 'Give the skill a name.' } });
    expect(await send('POST', '/api/skills', { name: 'Nameless' })).toEqual({ status: 400, json: { error: 'Say in one or two sentences when the skill should be used: agents decide from this.' } });
    expect(await send('POST', '/api/skills/import', { name: 'not-there' })).toEqual({ status: 400, json: { error: 'That skill was not found in ~/.claude/skills.' } });
  });

  it('say which things keep versions', async () => {
    expect(await send('GET', '/api/versions/routine')).toEqual({ status: 404, json: { error: 'Versions are kept for skills, agents, teams and MEMORY.md files.' } });
    expect(Array.isArray((await send('GET', '/api/versions/agent')).json)).toBe(true);
  });
});

describe('presets and the library over oRPC', () => {
  it('keep an agent as a preset, make it again, and delete the preset', async () => {
    const a = newAgent({ name: 'Copywriter' });
    const preset = (await send<AgentPreset>('POST', `/api/presets/agent/${a.id}`, { name: 'Writer' })).json;
    expect(preset).toMatchObject({ kind: 'agent', name: 'Writer', agent: { name: 'Copywriter' } });
    expect(((await send<{ id: string }[]>('GET', '/api/presets')).json).some((p) => p.id === preset.id)).toBe(true);
    const { agent } = (await send<{ agent: Agent }>('POST', `/api/presets/${preset.id}/use`)).json;
    expect(agent.id).not.toBe(a.id);
    expect(agents.get(agent.id)?.name).toBe('Copywriter');
    expect(await send('DELETE', `/api/presets/${preset.id}`)).toEqual({ status: 200, json: { ok: true } });
    expect(await send('POST', `/api/presets/${preset.id}/use`)).toEqual({ status: 404, json: { error: 'No such preset.' } });
    expect(await send('POST', '/api/presets/agent/nobody')).toEqual({ status: 404, json: { error: 'No such agent.' } });
    expect(await send('POST', '/api/presets/team/nobody')).toEqual({ status: 404, json: { error: 'No such team.' } });
  });

  it('answer a preset that fails to save as a 500, not as not found', async () => {
    const a = newAgent({ name: 'Copywriter' });
    const full = vi.spyOn(presets, 'saveAgentPreset').mockImplementation(() => {
      throw new Error('The disk is full.');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await send('POST', `/api/presets/agent/${a.id}`)).toEqual({ status: 500, json: { error: 'The disk is full.' } });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
    full.mockRestore();
  });

  it('list the library, show an agent of it, hire one, and refuse a source it does not know', async () => {
    const lib = (await send<LibraryIndex>('GET', '/api/library')).json;
    const first = lib.agents[0];
    expect(first).toMatchObject({ slug: expect.any(String), name: expect.any(String) });
    expect((await send<{ body: string }>('GET', `/api/library/agent/${first.slug}`)).json.body.length).toBeGreaterThan(0);
    const hired = (await send<Agent>('POST', '/api/library/hire', { source: 'library', slug: first.slug, overrides: { engine: 'eve' } })).json;
    expect(hired).toMatchObject({ name: first.name, engine: 'eve' });
    expect(await send('POST', '/api/library/hire', { source: 'library', slug: 'not-there' })).toEqual({ status: 404, json: { error: 'That agent is not in the library.' } });
    expect(await send('POST', '/api/library/hire', { source: 'elsewhere', slug: 'x' })).toEqual({ status: 400, json: { error: 'Unknown library source' } });
    expect(await send('GET', '/api/library/agent/not-there')).toEqual({ status: 404, json: { error: 'That agent is not in the library.' } });
  });
});
