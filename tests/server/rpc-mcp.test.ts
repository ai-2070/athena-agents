// MCP servers, the engines' setup and programs over oRPC (server/api/mcp.ts, programs.ts): a server saved and listed
// with its keys hidden, refused in plain words when it can't be saved, the bridge's token only where it is copied,
// a ready-made server, and the programs and ComfyUI answering when nothing is installed.
import http from 'node:http';
import type net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { listServers } from '../../server/mcp.ts';
import { handleRpc } from '../../server/rpc.ts';
import { agents, internalToken, workflows } from '../../server/store.ts';
import type { McpOverview, McpServerConfig, Team } from '../../shared/types.ts';

// (Hermes and OpenClaw installed on this computer would be asked for their profiles and agents: seconds each, and
// past the time limit while other test runs share the computer)
vi.mock('../../server/util.ts', async (orig) => {
  const real = await orig<typeof import('../../server/util.ts')>();
  return { ...real, which: (cmd: string) => (cmd === 'hermes' || cmd === 'openclaw' ? null : real.which(cmd)) };
});

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

describe('MCP servers over oRPC', () => {
  it('save a server, list it with its key hidden, and remove it', async () => {
    const saved = (
      await send<McpServerConfig>('POST', '/api/mcp', {
        name: 'notes',
        type: 'stdio',
        command: 'node',
        args: 'notes.js --fast',
        env: { API_KEY: 'secret-123' },
      })
    ).json;
    expect(saved).toMatchObject({ command: 'node', args: ['notes.js', '--fast'], enabled: true });
    const list = (await send<McpOverview>('GET', '/api/mcp')).json;
    expect(list.servers.notes.command).toBe('node');
    expect(JSON.stringify(list)).not.toContain('secret-123');
    expect(list.bridge.env.DASH_TOKEN).not.toBe(internalToken());
    expect(list.presets.length).toBeGreaterThan(0);
    expect(await send('DELETE', '/api/mcp/notes')).toEqual({ status: 200, json: { ok: true } });
    expect((await send<McpOverview>('GET', '/api/mcp')).json.servers.notes).toBeUndefined();
  });

  it('refuse a server it cannot save, in plain words', async () => {
    expect(await send('POST', '/api/mcp', { name: '  ' })).toEqual({
      status: 400,
      json: { error: 'Give the server a name.' },
    });
    expect(await send('POST', '/api/mcp', { name: 'dashboard', command: 'x' })).toEqual({
      status: 400,
      json: { error: '"dashboard" is reserved for the built-in tools.' },
    });
    expect(await send('POST', '/api/mcp', { name: 'x', env: 'KEY=1' })).toEqual({
      status: 400,
      json: { error: 'env must be names and values.' },
    });
    expect(await send('POST', '/api/mcp-preset', { name: 'no-such-preset' })).toEqual({
      status: 404,
      json: { error: 'Unknown preset' },
    });
    expect(await send('POST', '/api/mcp-import', { name: 'gone', source: 'nowhere' })).toEqual({
      status: 404,
      json: { error: 'That server is no longer in its Claude config.' },
    });
  });

  it('rename a server from its form: it stays on its agents and teams, with its key', async () => {
    await send('POST', '/api/mcp', { name: 'mail', command: 'node', args: 'mail.js', env: { API_KEY: 'k-1' } });
    const agent = agents.save({ ...newAgent({ name: 'Mailer', engine: 'eve' }), mcpServers: ['mail'] });
    const team = workflows.save({
      name: 'Mail team',
      members: [agent.id],
      lead: agent.id,
      steps: [],
      access: { toolGroups: [], mcpServers: ['mail'] },
    } as Partial<Team>);
    // as the page sends it: the key as dots, and "its own service" as the name it had
    const seen = (await send<McpOverview>('GET', '/api/mcp')).json.servers.mail;
    const r = await send<McpServerConfig>('POST', '/api/mcp', {
      ...seen,
      name: 'mail-work',
      from: 'mail',
      kind: 'mail',
    });
    expect(r.status).toBe(200);
    const servers = (await send<McpOverview>('GET', '/api/mcp')).json;
    expect(servers.servers.mail).toBeUndefined();
    expect(servers.info['mail-work'].kind).toBe('mail-work');
    expect(listServers()['mail-work'].env.API_KEY).toBe('k-1');
    expect(agents.get(agent.id)?.mcpServers).toEqual(['mail-work']);
    expect(workflows.get(team.id)?.access?.mcpServers).toEqual(['mail-work']);
    // a name that is taken changes nothing
    await send('POST', '/api/mcp', { name: 'other', command: 'node' });
    expect(await send('POST', '/api/mcp', { name: 'other', from: 'mail-work', command: 'node' })).toEqual({
      status: 400,
      json: { error: 'There already is an MCP server named "other".' },
    });
    expect(agents.get(agent.id)?.mcpServers).toEqual(['mail-work']);
  });

  it('give the bridge with its token only to copy', async () => {
    expect((await send<{ env: Record<string, string> }>('POST', '/api/mcp-bridge')).json.env.DASH_TOKEN).toBe(
      internalToken(),
    );
  });

  it('add a ready-made server', async () => {
    const preset = (await send<McpOverview>('GET', '/api/mcp')).json.presets.find(
      (p) => p.type === 'http' && !p.installed,
    )!;
    const made = (
      await send<{ name: string; server: McpServerConfig }>('POST', '/api/mcp-preset', { name: preset.name })
    ).json;
    expect(made.name).toBe(preset.name);
    expect((await send<McpOverview>('GET', '/api/mcp')).json.servers[made.name]).toBeDefined();
  });
});

describe('the engines and programs over oRPC', () => {
  it('answer with nothing installed', async () => {
    expect(Array.isArray((await send('GET', '/api/hermes/profiles')).json)).toBe(true);
    expect(Array.isArray((await send('GET', '/api/openclaw/agents')).json)).toBe(true);
    expect(await send('POST', '/api/pi/add-bridge', { flavor: 'perl' })).toMatchObject({ status: 400 });
    expect(Array.isArray((await send('GET', '/api/programs')).json)).toBe(true);
    expect((await send('GET', '/api/comfyui')).json).toMatchObject({
      status: { running: expect.any(Boolean) },
      workflows: expect.any(Array),
    });
    expect(await send('POST', '/api/programs/launch', {})).toEqual({ status: 400, json: { error: 'Pick a program.' } });
  });
});
