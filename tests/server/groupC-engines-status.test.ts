import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChatItem } from '../../shared/types.ts';
import { newAgent } from '../../server/library.ts';
import { bridgeServerConfig, saveServer } from '../../server/mcp.ts';
import { activeProject, internalToken } from '../../server/store.ts';
import { bridgeEnv } from '../../server/engines/cli.ts';
import { dataPath } from '../../server/util.ts';
import { codexArgs, codexLaunch, terminalPromptFile } from '../../server/engines/codex.ts';
import { turnActivity } from '../../server/engines/index.ts';
import { codexWindow } from '../../server/status.ts';

// the values passed with -c, e.g. 'mcp_servers.gh.url="..."'
const overrides = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));

describe('codex args', () => {
  it('passes headers of HTTP MCP servers on as http_headers', () => {
    saveServer('gh', {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k"1' },
    });
    saveServer('plain', { type: 'http', url: 'https://example.com/other' });
    // (an older Codex: it can't take them from its environment)
    const c = overrides(
      codexArgs(newAgent({ name: 'Coder', engine: 'codex', mcpServers: ['gh', 'plain'] }), { version: '0.120.0' }),
    );
    expect(c).toContain('mcp_servers.gh.url="https://example.com/mcp"');
    expect(c).toContain('mcp_servers.gh.http_headers={Authorization="Bearer abc",X-Api-Key="k\\"1"}');
    // no empty table for a server without headers
    expect(c.some((x) => x.startsWith('mcp_servers.plain.http_headers'))).toBe(false);
  });

  it("keeps the dashboard's token off the command line", () => {
    const { args, env } = codexLaunch(newAgent({ name: 'Coder', engine: 'codex' }), {
      runId: 'r1',
      version: '0.120.0',
    });
    const token = internalToken();
    expect(args.join(' ')).not.toContain(token);
    expect(Object.values(env)).not.toContain(token);
    const bridge = overrides(args).find((x) => x.startsWith('mcp_servers.dashboard.env='))!;
    expect(bridge).toContain(`DASH_DATA=${JSON.stringify(dataPath())}`);
    expect(bridge).not.toContain('DASH_TOKEN');
    // (a terminal has no run: its bridge names the project it was opened in)
    expect(bridge).toContain(`DASH_PROJECT=${JSON.stringify(activeProject().id)}`);
    expect(bridgeEnv('a1').DASH_PROJECT).toBe(activeProject().id);
    expect(bridgeServerConfig('a1').env.DASH_PROJECT).toBe(activeProject().id);
    // an outside client works in whichever project is open
    expect(bridgeServerConfig('').env.DASH_PROJECT).toBeUndefined();
  });

  it("puts MCP servers' keys in Codex's environment, hidden from the commands it runs", () => {
    saveServer('gh', { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abc' } });
    saveServer('local', { type: 'stdio', command: 'node', args: ['server.js'], env: { SERVICE_KEY: 's3cret' } });
    const { args, env } = codexLaunch(newAgent({ name: 'Coder', engine: 'codex', mcpServers: ['gh', 'local'] }), {
      version: '0.166.0',
    });
    expect(args.join(' ')).not.toMatch(/s3cret|Bearer abc/);
    const c = overrides(args);
    expect(c).toContain('mcp_servers.gh.env_http_headers={Authorization="ATHENA_MCP_SECRET_GH_0"}');
    expect(c).toContain('mcp_servers.local.env_vars=["SERVICE_KEY"]');
    expect(env).toEqual({ ATHENA_MCP_SECRET_GH_0: 'Bearer abc', SERVICE_KEY: 's3cret' });
    expect(c).toContain('shell_environment_policy.exclude=["ATHENA_MCP_SECRET_GH_0","SERVICE_KEY"]');
  });

  it("keeps the backslashes in a local server's arguments, and writes its command as a path", () => {
    saveServer('scripted', {
      type: 'stdio',
      command: 'C:\\Tools\\run.exe',
      args: ['-e', 'print("a\\tb")', '--match', '\\d+'],
    });
    const c = overrides(
      codexArgs(newAgent({ name: 'Coder', engine: 'codex', mcpServers: ['scripted'] }), { version: '0.166.0' }),
    );
    expect(c).toContain('mcp_servers.scripted.command="C:/Tools/run.exe"');
    const listed = c.find((x) => x.startsWith('mcp_servers.scripted.args='))!;
    // (TOML reads these back as the arguments as they were)
    expect(JSON.parse(listed.slice('mcp_servers.scripted.args='.length))).toEqual([
      '-e',
      'print("a\\tb")',
      '--match',
      '\\d+',
    ]);
  });

  it('gives servers whose names fold together their own key variables', () => {
    saveServer('work-mail', { type: 'http', url: 'https://a.example/mcp', headers: { Authorization: 'Bearer a' } });
    saveServer('work_mail', { type: 'http', url: 'https://b.example/mcp', headers: { Authorization: 'Bearer b' } });
    const { args, env } = codexLaunch(
      newAgent({ name: 'Coder', engine: 'codex', mcpServers: ['work-mail', 'work_mail'] }),
      { version: '0.166.0' },
    );
    const c = overrides(args);
    expect(c).toContain('mcp_servers.work-mail.env_http_headers={Authorization="ATHENA_MCP_SECRET_WORK_MAIL_0"}');
    expect(c).toContain('mcp_servers.work_mail.env_http_headers={Authorization="ATHENA_MCP_SECRET_WORK_MAIL_0_2"}');
    expect(env.ATHENA_MCP_SECRET_WORK_MAIL_0).toBe('Bearer a');
    expect(env.ATHENA_MCP_SECRET_WORK_MAIL_0_2).toBe('Bearer b');
  });

  it('keeps a variable two servers want with different values on the command line for the second', () => {
    saveServer('one', { type: 'stdio', command: 'node', args: ['a.js'], env: { TOKEN_X: 'first' } });
    saveServer('two', { type: 'stdio', command: 'node', args: ['b.js'], env: { TOKEN_X: 'second' } });
    const { args, env } = codexLaunch(newAgent({ name: 'Coder', engine: 'codex', mcpServers: ['one', 'two'] }), {
      version: '0.166.0',
    });
    expect(env.TOKEN_X).toBe('first');
    expect(overrides(args)).toContain('mcp_servers.two.env={TOKEN_X="second"}');
  });

  it("gives each terminal its own instructions file, so one opened later doesn't change another's", () => {
    const agent = newAgent({ name: 'Coder', engine: 'codex' });
    const one = terminalPromptFile(agent, 'Brief for the first terminal.', 'terminal-one');
    const two = terminalPromptFile(agent, 'Brief for the second terminal.', 'terminal-two');
    expect(one).not.toBe(two);
    expect(fs.readFileSync(one, 'utf8')).toBe('Brief for the first terminal.');
    expect(fs.readFileSync(two, 'utf8')).toBe('Brief for the second terminal.');
  });

  it('points the interactive terminal at a file with the agent instructions', () => {
    const agent = newAgent({ name: 'Coder', engine: 'codex' });
    const file = terminalPromptFile(agent, 'You are Coder.\nAlways write tests.');
    expect(fs.readFileSync(file, 'utf8')).toBe('You are Coder.\nAlways write tests.');
    const c = overrides(codexArgs(agent, { interactive: true, promptFile: file }));
    const dev = c.find((x) => x.startsWith('developer_instructions='));
    expect(dev).toContain(file.replace(/\\/g, '/'));
    // headless runs send the instructions with the first message instead
    expect(overrides(codexArgs(agent)).some((x) => x.startsWith('developer_instructions='))).toBe(false);
  });
});

describe('turnActivity', () => {
  it("only reports the current turn's tool and text", () => {
    const items: ChatItem[] = [
      { type: 'user', text: 'old task' },
      { type: 'tool', id: 't1', name: 'old_tool', status: 'done' },
      { type: 'assistant', text: 'old answer' },
      { type: 'user', text: 'new task', from: 'Brain' },
    ];
    expect(turnActivity(items)).toEqual({ task: 'new task', from: 'Brain', tool: null, saying: '' });
    items.push(
      { type: 'tool', id: 't2', name: 'new_tool', args: { a: 1 }, status: 'running' },
      { type: 'assistant', text: 'working on it' },
    );
    expect(turnActivity(items)).toEqual({
      task: 'new task',
      from: 'Brain',
      tool: { name: 'new_tool', status: 'running', args: '{"a":1}' },
      saying: 'working on it',
    });
  });

  it('copes with a chat that has no user message', () => {
    expect(turnActivity([])).toEqual({ task: '', from: null, tool: null, saying: '' });
  });
});

describe('codexWindow', () => {
  const now = Date.UTC(2026, 0, 1, 12);
  it('keeps a window that has not reset yet', () => {
    expect(codexWindow({ used_percent: 41.6, resets_at: now / 1000 + 600 }, now - 1000, now)).toEqual({
      percent: 42,
      resetsAt: now + 600_000,
    });
    expect(codexWindow({ used_percent: 10, resets_in_seconds: 60 }, now - 30_000, now)).toEqual({
      percent: 10,
      resetsAt: now + 30_000,
    });
    expect(codexWindow({ used_percent: 5 }, now, now)).toEqual({ percent: 5, resetsAt: null });
  });

  it('drops a window whose reset time has passed', () => {
    expect(codexWindow({ used_percent: 90, resets_at: now - 1 }, now - 3_600_000, now)).toBeNull();
    expect(codexWindow({ used_percent: 90, resets_in_seconds: 60 }, now - 120_000, now)).toBeNull();
  });

  it('ignores windows without a percent', () => {
    expect(codexWindow(null, now, now)).toBeNull();
    expect(codexWindow({ used_percent: '50' }, now, now)).toBeNull();
  });
});
