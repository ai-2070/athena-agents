// One service added more than once (several accounts: OOMOL Work and OOMOL Personal). Each copy has a label
// and a "use for" line; an agent or team may hold several, the team's copy wins during team work, and the
// agent and the approvals say which account is which.
import { describe, expect, it } from 'vitest';
import * as mcp from '../../server/mcp.ts';
import type { McpServerConfig, McpServers } from '../../server/mcp.ts';

const http = (url: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({ type: 'http', command: '', args: [], env: {}, url, headers: {}, description: '', enabled: true, ...extra });
const OOMOL = 'https://connector.oomol.com/v1/mcp';

describe('which service a server is', () => {
  it('a ready-made one by its name, its command or link, or the host of a service with a link per account', () => {
    expect(mcp.kindOf('oomol', http('https://elsewhere.example/mcp'))).toBe('oomol');
    expect(mcp.kindOf('oomol-work', http(OOMOL))).toBe('oomol');
    expect(mcp.kindOf('my-composio', http('https://mcp.composio.dev/session/abc123'))).toBe('composio');
    expect(mcp.kindOf('browser2', { ...http(''), type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] })).toBe('playwright');
  });

  it('the one it was set to, or its own name when it is like no other', () => {
    expect(mcp.kindOf('gmail-home', http('https://gmail.example/mcp', { kind: 'gmail-work' }))).toBe('gmail-work');
    expect(mcp.kindOf('weather', http('https://weather.example/mcp'))).toBe('weather');
    expect(mcp.kindOf('ghost', undefined)).toBe('ghost');
  });

  it('shows a copy as "OOMOL: Work", and anything else by its name', () => {
    expect(mcp.serviceTitle('oomol')).toBe('OOMOL');
    expect(mcp.copyTitle('oomol-work', http(OOMOL, { label: 'Work' }))).toBe('OOMOL: Work');
    expect(mcp.copyTitle('oomol', http(OOMOL))).toBe('oomol');
  });
});

describe('adding another account of a ready-made server', () => {
  it('needs a label the second time, and keeps the first one as it was', () => {
    expect(mcp.addPreset('oomol').name).toBe('oomol');
    expect(() => mcp.addPreset('oomol')).toThrow(/added already.*label/);
    const made = mcp.addPreset('oomol', { label: 'Client A', useFor: 'everything for Client A' });
    expect(made.name).toBe('oomol-client-a');
    expect(mcp.listServers()['oomol-client-a']).toMatchObject({ url: OOMOL, label: 'Client A', kind: 'oomol', useFor: 'everything for Client A' });
    expect(mcp.listServers().oomol.label).toBeUndefined();
    // the same label again gets a number, a label with no letters it can use gets the service's name
    expect(mcp.addPreset('oomol', { label: 'Client A' }).name).toBe('oomol-client-a-2');
    expect(mcp.addPreset('oomol', { label: 'Ärger' }).name).toBe('oomol-rger');
    expect(mcp.addPreset('oomol', { label: '工作' }).name).toBe('oomol-2');
  });

  it('lists every copy on the ready-made one, and stops suggesting it', () => {
    const p = mcp.presetAvailability().find((x) => x.name === 'oomol')!;
    expect(p.installed).toBe(true);
    expect(p.copies).toEqual(expect.arrayContaining(['oomol', 'oomol-client-a']));
    // a copy saved under any name counts as added
    expect(mcp.suggestPresets([], { 'my-context': { ...http(''), type: 'stdio', command: 'x', kind: 'context7' } }).map((s) => s.name)).not.toContain('context7');
  });

  it('changes only the label and "use for" of one already there, and they survive a rename', () => {
    mcp.describeCopy('oomol', { label: 'Personal', useFor: 'my own mail' });
    expect(mcp.listServers().oomol).toMatchObject({ url: OOMOL, label: 'Personal', useFor: 'my own mail' });
    mcp.describeCopy('oomol', { useFor: 'my own mail and calendar' });
    expect(mcp.listServers().oomol.label).toBe('Personal');
    expect(mcp.renameServer('oomol', 'oomol-personal')).toBe('oomol-personal');
    expect(mcp.listServers()['oomol-personal']).toMatchObject({ label: 'Personal', useFor: 'my own mail and calendar' });
    expect(mcp.kindOf('oomol-personal', mcp.listServers()['oomol-personal'])).toBe('oomol');
  });

  it("asks for Composio's own link and key", () => {
    const composio = mcp.PRESETS.find((p) => p.name === 'composio')!;
    expect(mcp.presetNeeds(composio)).toBe('needs its own link in the URL and a key in the x-api-key header');
  });
});

describe('agents with several accounts', () => {
  const servers: McpServers = {
    'oomol-work': http(OOMOL, { label: 'Work', kind: 'oomol', useFor: 'acme.com mail and calendar' }),
    'oomol-personal': http(OOMOL, { label: 'Personal', kind: 'oomol' }),
    playwright: { ...http(''), type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
  };

  it('finds the copies that share a service and have no "use for"', () => {
    expect([...mcp.copiesByKind(servers).entries()]).toEqual([['oomol', ['oomol-work', 'oomol-personal']]]);
    expect(mcp.copiesWithoutUseFor(['oomol-work', 'oomol-personal', 'playwright'], servers)).toEqual(['oomol-personal']);
    // one copy alone needs none
    expect(mcp.copiesWithoutUseFor(['oomol-personal', 'playwright'], servers)).toEqual([]);
    expect(mcp.serverInfo(servers)['oomol-work']).toEqual({ title: 'OOMOL: Work', label: 'Work', kind: 'oomol', service: 'OOMOL', useFor: 'acme.com mail and calendar', copies: 2 });
    expect(mcp.serverInfo(servers).playwright).toMatchObject({ title: 'playwright', copies: 1 });
  });

  it("uses the team's account during team work, in place of the agent's own of that service", () => {
    expect(mcp.teamWorkServers(['oomol-personal', 'playwright'], ['oomol-work'], servers)).toEqual(['playwright', 'oomol-work']);
    expect(mcp.teamWorkServers(['oomol-personal', 'oomol-work'], ['oomol-work'], servers)).toEqual(['oomol-work']);
    // a team with both gives both; a team without the service leaves the agent's own
    expect(mcp.teamWorkServers(['oomol-personal'], ['oomol-work', 'oomol-personal'], servers).sort()).toEqual(['oomol-personal', 'oomol-work']);
    expect(mcp.teamWorkServers(['oomol-personal'], ['playwright'], servers)).toEqual(['oomol-personal', 'playwright']);
  });

  it('tells the agent which account is which and to ask when unsure', () => {
    const both = mcp.accountsPrompt(['oomol-work', 'oomol-personal', 'playwright'], servers);
    expect(both).toContain('# Accounts');
    expect(both).toContain('separate accounts of the same service');
    expect(both).toContain('- OOMOL: Work (the MCP server "oomol-work": its tools have "oomol-work" in their names). Use it for: acme.com mail and calendar');
    expect(both).toContain('- OOMOL: Personal (the MCP server "oomol-personal"');
    expect(both).not.toContain('playwright');
    expect(mcp.accountsPrompt(['oomol-work'], servers)).toContain('These MCP servers are accounts');
    expect(mcp.accountsPrompt(['playwright'], servers)).toBe('');
    // a server that is off isn't there for the agent
    expect(mcp.accountsPrompt(['oomol-work'], { 'oomol-work': { ...servers['oomol-work'], enabled: false } })).toBe('');
  });

  it('names the account in an approval, for Claude Code and API-model tool names', () => {
    expect(mcp.accountOfTool('mcp__oomol-work__send_mail', servers)).toBe('OOMOL: Work');
    expect(mcp.accountOfTool('oomol-personal__send_mail', servers)).toBe('OOMOL: Personal');
    expect(mcp.accountOfTool('mcp__playwright__click', servers)).toBe('');
    expect(mcp.accountOfTool('write_file', servers)).toBe('');
    // copies without labels are still told apart, by name
    const bare = { 'oomol': http(OOMOL), 'oomol-2': http(OOMOL) };
    expect(mcp.accountOfTool('mcp__oomol-2__send', bare)).toBe('oomol-2');
  });

  it('lists copies for the Brain with their label and "use for", other servers by name', () => {
    expect(mcp.serversForPrompt(servers)).toBe('oomol-work (OOMOL: Work; use for: acme.com mail and calendar), oomol-personal (OOMOL: Personal), playwright');
  });
});
