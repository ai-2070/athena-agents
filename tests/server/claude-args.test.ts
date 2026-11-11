// How an agent's autonomy maps to Claude Code's permission mode.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { claudeArgs, claudeEnv, parseAuthStatus, status } from '../../server/engines/claude.ts';
import { setSecret } from '../../server/store.ts';

// A pretend `claude` that answers `auth status` the way the real one does: an API key in its
// environment counts as signed in ("api_key"), otherwise there is no login on this test PC.
const calls = vi.hoisted(() => [] as { args: string[]; env: Record<string, string | undefined> }[]);
vi.mock('../../server/util.ts', async (orig) => {
  const real = await orig<typeof import('../../server/util.ts')>();
  return {
    ...real,
    which: (cmd: string) => (cmd === 'claude' ? '/usr/bin/claude' : real.which(cmd)),
    run: async (cmd: string, args: string[] = [], opts: { env?: Record<string, string | undefined> } = {}) => {
      if (cmd !== 'claude') return real.run(cmd, args, opts);
      const env = { ...process.env, ...(opts.env || {}) };
      calls.push({ args, env });
      if (args[0] === '--version') return { code: 0, stdout: '9.9.9', stderr: '' };
      return {
        code: 0,
        stdout: env.ANTHROPIC_API_KEY ? '{"loggedIn": true, "authMethod": "api_key"}' : '{"loggedIn": false}',
        stderr: '',
      };
    },
  };
});
import { newAgent } from '../../server/library.ts';
import type { Agent } from '../../shared/types.ts';

const files = { promptFile: 'prompt.md', mcpFile: 'mcp.json' };
const modeOf = (args: string[]) => args[args.indexOf('--permission-mode') + 1];
const agent = (autonomy: Agent['autonomy']) =>
  newAgent({ name: `Claude ${autonomy}`, engine: 'claude-code', autonomy });

describe('claudeArgs() permission mode', () => {
  it('"Ask first" never auto-accepts edits: it uses the default mode and routes prompts to the dashboard', () => {
    const args = claudeArgs(agent('ask'), files);
    expect(modeOf(args)).toBe('default');
    expect(args).not.toContain('acceptEdits');
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('mcp__dashboard__permission_prompt');
  });

  it('"Ask first" in a terminal asks there (no prompt tool)', () => {
    const args = claudeArgs(agent('ask'), { ...files, interactive: true });
    expect(modeOf(args)).toBe('default');
    expect(args).not.toContain('--permission-prompt-tool');
  });

  it('auto and full keep their modes', () => {
    expect(modeOf(claudeArgs(agent('auto'), files))).toBe('auto');
    expect(modeOf(claudeArgs(agent('full'), files))).toBe('bypassPermissions');
  });
});

describe('claudeArgs() questions', () => {
  it("turns off Claude's own question box in dashboard runs: it asks with ask_user (the Outbox)", () => {
    const args = claudeArgs(agent('auto'), files);
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('AskUserQuestion');
    const blocked = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--allowedTools'));
    expect(blocked).toEqual(['AskUserQuestion', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TodoWrite']);
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toContain('mcp__dashboard');
    expect(claudeArgs(agent('full'), files)).toContain('--disallowedTools');
  });

  it('keeps it in a terminal, where you are there to answer', () => {
    expect(claudeArgs(agent('auto'), { ...files, interactive: true })).not.toContain('--disallowedTools');
  });
});

describe('parseAuthStatus()', () => {
  it('reads the login from `claude auth status`, which also knows about the macOS Keychain', () => {
    expect(parseAuthStatus('{\n  "loggedIn": true,\n  "authMethod": "claude.ai"\n}\n')).toBe(true);
    expect(parseAuthStatus('{"loggedIn": false}')).toBe(false);
  });

  it('gives up on output it does not understand, so the credentials file decides', () => {
    expect(parseAuthStatus("error: unknown command 'auth'")).toBeNull();
    expect(parseAuthStatus('{"authMethod": "claude.ai"}')).toBeNull();
    expect(parseAuthStatus('{ not json')).toBeNull();
  });
});

describe('claudeEnv() sign-in', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    setSecret('anthropicKey', null);
  });
  const withAuth = (claudeAuth: Agent['claudeAuth']) => ({ ...agent('auto'), claudeAuth });

  it('"My Claude login" leaves out keys, tokens and endpoints that would win over the login', () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: 'sk-env',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
      ANTHROPIC_PROFILE: 'work',
      anthropic_api_key: 'sk-lower',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      KEEP_ME: '1',
    });
    const env = claudeEnv(withAuth('login'));
    for (const k of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_PROFILE',
      'anthropic_api_key',
    ])
      expect(env).not.toHaveProperty(k);
    // a subscription token from `claude setup-token` is still your login
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth');
    expect(env.KEEP_ME).toBe('1');
    expect(env.MCP_TOOL_TIMEOUT).toBeTruthy();
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-env');
  });

  it('agents saved without a choice use the login too', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    expect(claudeEnv({ ...agent('auto'), claudeAuth: '' })).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('an API key from Settings is the one used, not a leftover token or endpoint', () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: 'sk-env',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
    });
    setSecret('anthropicKey', 'sk-settings');
    const env = claudeEnv(withAuth('anthropic'));
    expect(env.ANTHROPIC_API_KEY).toBe('sk-settings');
    expect(env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
  });
});

describe('status() login', () => {
  it('a key in the environment is not a Claude login', async () => {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    try {
      expect(status().loggedIn).toBe(false);
      await new Promise((r) => setTimeout(r, 0));
      const ask = calls.find((c) => c.args[0] === 'auth');
      expect(ask?.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(status().loggedIn).toBe(false);
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });
});
