// Settings, keys, accounts and the dashboard's status over oRPC (server/api/settings.ts, status.ts): a change to one
// part of the settings keeps the rest, a field of the wrong kind is refused in plain words instead of saved, a key is
// saved but never sent back, and the app state, activity, tools and models answer.
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleRpc } from '../../server/rpc.ts';
import { getSecrets, getSettings, saveSettings } from '../../server/store.ts';
import type { AppState, SecretStatus, Settings } from '../../shared/types.ts';

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
  const r = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as T };
};

describe('settings and keys over oRPC', () => {
  it('change one part of the settings and keep the rest, at any depth', async () => {
    saveSettings({ providers: { custom: { baseUrl: 'http://old', label: 'Mine' } } });
    const saved = (
      await send<Settings>('PUT', '/api/settings', {
        providers: { custom: { baseUrl: 'http://new' } },
        maxToolSteps: 30,
      })
    ).json;
    expect(saved.providers.custom).toEqual({ baseUrl: 'http://new', label: 'Mine' });
    expect(saved.maxToolSteps).toBe(30);
    expect((await send<{ settings: Settings }>('GET', '/api/settings')).json.settings.providers.custom.label).toBe(
      'Mine',
    );
  });

  it('refuse a field of the wrong kind in plain words, and save nothing of that change', async () => {
    const before = getSettings();
    expect(await send('PUT', '/api/settings', { allowedFolders: 'C:/', maxToolSteps: 5 })).toEqual({
      status: 400,
      json: { error: 'The folders agents may use must be a list.' },
    });
    expect(await send('PUT', '/api/settings', { look: { theme: 'neon' } })).toEqual({
      status: 400,
      json: { error: 'The colour scheme is system, light or dark.' },
    });
    expect(await send('PUT', '/api/settings', { maxToolSteps: null })).toEqual({
      status: 400,
      json: { error: 'maxToolSteps must be a number.' },
    });
    expect(await send('PUT', '/api/settings', { defaults: { engine: 'gpt' } })).toMatchObject({ status: 400 });
    // limits a turn couldn't work with are refused when saved, not when the next turn starts
    expect(await send('PUT', '/api/settings', { maxToolSteps: 2.5 })).toEqual({
      status: 400,
      json: { error: 'The most tool steps is a whole number.' },
    });
    expect(await send('PUT', '/api/settings', { maxToolSteps: 0 })).toMatchObject({ status: 400 });
    expect(await send('PUT', '/api/settings', { costLimitUsdPerRun: -1 })).toMatchObject({ status: 400 });
    expect(await send('PUT', '/api/settings', { contextWindowTokens: -100 })).toMatchObject({ status: 400 });
    expect(getSettings().maxToolSteps).toBe(before.maxToolSteps);
    expect(getSettings().allowedFolders).toEqual(before.allowedFolders);
  });

  it('save a key, say only that it is set, and refuse one it does not know', async () => {
    const status = (
      await send<SecretStatus>('POST', '/api/secrets', { key: 'openrouterKey', value: '  sk-test-1234  ' })
    ).json;
    expect(status.openrouterKey).toEqual({ set: true, hint: '…1234' });
    expect(JSON.stringify(status)).not.toContain('sk-test');
    expect(getSecrets().openrouterKey).toBe('sk-test-1234');
    expect(
      (await send<SecretStatus>('POST', '/api/secrets', { key: 'openrouterKey', value: '' })).json.openrouterKey,
    ).toEqual({ set: false });
    expect(await send('POST', '/api/secrets', { key: 'githubToken', value: 'x' })).toEqual({
      status: 400,
      json: { error: 'Unknown key' },
    });
    expect(await send('POST', '/api/settings/test-openrouter')).toEqual({
      status: 400,
      json: { error: 'No OpenRouter key saved.' },
    });
    expect(await send('POST', '/api/settings/test-venice')).toEqual({
      status: 400,
      json: { error: 'No Venice key saved.' },
    });
  });

  it('list the accounts, and refuse an autopost of the wrong kind', async () => {
    expect((await send('GET', '/api/accounts')).json).toMatchObject({ x: expect.any(Array) });
    expect(await send('POST', '/api/accounts/x/nobody', { autopost: 'yes' })).toEqual({
      status: 400,
      json: { error: 'autopost must be true or false.' },
    });
  });
});

describe("the dashboard's status over oRPC", () => {
  it('answer the app state, activity, tools, their use, providers and models', async () => {
    const state = (await send<AppState>('GET', '/api/state')).json;
    expect(state).toMatchObject({
      agents: expect.any(Array),
      project: { id: expect.any(String) },
      settings: expect.any(Object),
      port: expect.any(Number),
    });
    expect(JSON.stringify(state)).not.toContain('sk-test');
    expect(Array.isArray((await send('GET', '/api/activity')).json)).toBe(true);
    expect((await send('GET', '/api/tools')).json).toMatchObject({
      groups: expect.any(Array),
      tools: expect.any(Array),
    });
    expect((await send('GET', '/api/tool-stats')).json).toMatchObject({ tools: expect.any(Array) });
    expect((await send<{ id: string }[]>('GET', '/api/providers')).json.map((p) => p.id)).toContain('openrouter');
    expect((await send('GET', '/api/models?engine=hermes')).json).toEqual([]);
    expect((await send<{ id: string }[]>('GET', '/api/models?engine=claude-code')).json.length).toBeGreaterThan(0);
  });
});
