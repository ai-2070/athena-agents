// The Brain on opencode: one `opencode run` on its own server, as an agent that may at most read in the
// project folder, the question on stdin, its JSON lines read into the answer and the Brain chat's steps.
// (The lines' shapes are those of opencode 2.2.7.)
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { saveSettings } from '../../server/store.ts';
import type { ThinkPart } from '../../server/brain.ts';

const fake = vi.hoisted(() => ({
  lines: [] as string[],
  code: 0,
  stderr: '',
  calls: [] as {
    args: string[];
    input: string;
    cwd?: string;
    config: Record<string, unknown>;
    brief: string;
    env: NodeJS.ProcessEnv;
  }[],
}));
vi.mock('../../server/util.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/util.ts')>()),
  which: (cmd: string) => (cmd === 'opencode' ? '/usr/bin/opencode' : null),
  run: async (
    cmd: string,
    args: string[],
    o: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (l: string) => void },
  ) => {
    if (cmd !== 'opencode' || args[0] !== 'run') return { code: 0, stdout: 'opencode v2.2.7\n', stderr: '' };
    const config = JSON.parse(fs.readFileSync(String(o.env?.OPENCODE_CONFIG), 'utf8')) as Record<string, unknown>;
    const system = String((config.agents as Record<string, { system: string }>)['athena-brain']!.system);
    fake.calls.push({
      args,
      input: o.input || '',
      cwd: o.cwd,
      config,
      brief: fs.readFileSync(system.slice(6, -1), 'utf8'),
      env: o.env || {},
    });
    for (const l of fake.lines) o.onLine?.(l);
    return { code: fake.code, stdout: fake.lines.join('\n'), stderr: fake.stderr };
  },
}));

const { think } = await import('../../server/brain.ts');
const line = (type: string, part: object) => JSON.stringify({ type, timestamp: 1, sessionID: 'ses_1', part });

beforeEach(() => {
  fake.lines = [];
  fake.code = 0;
  fake.stderr = '';
  fake.calls = [];
});

describe('think() on opencode', () => {
  it('asks once on its own server, reads what it says, and keeps nothing in its session lists', async () => {
    saveSettings({ brain: { provider: 'opencode', model: 'openrouter/deepseek/flash' } });
    fake.lines = [
      line('step_start', { type: 'step-start' }),
      line('text', { id: 'p1', type: 'text', text: 'Let me look.' }),
      line('tool_use', {
        id: 'call_1',
        type: 'tool',
        tool: 'glob',
        state: { status: 'completed', input: { pattern: '*.md' }, output: 'PROJECT.md' },
      }),
      line('step_finish', { type: 'step-finish', reason: 'tool-calls', cost: 0.0001 }),
      line('text', { id: 'p2', type: 'text', text: 'There is a PROJECT.md.' }),
    ];
    const parts: ThinkPart[] = [];
    const answer = await think('You are the Brain.', 'What is here?', {
      tools: 'Read,Glob,Grep',
      cwd: '/proj',
      onPart: (p) => parts.push(p),
    });
    expect(answer).toBe('Let me look.\n\nThere is a PROJECT.md.');
    expect(parts).toEqual([
      { kind: 'text', text: 'Let me look.' },
      { kind: 'tool', id: 'call_1', name: 'glob', args: { pattern: '*.md' } },
      { kind: 'tool_result', id: 'call_1', text: 'PROJECT.md', isError: false },
      { kind: 'text', text: '\n\nThere is a PROJECT.md.' },
    ]);
    const c = fake.calls[0]!;
    expect(c.args).toEqual([
      'run',
      '--standalone',
      '--format',
      'json',
      '--archived',
      '--agent',
      'athena-brain',
      '-m',
      'openrouter/deepseek/flash',
    ]);
    expect(c.input).toBe('What is here?');
    expect(c.brief).toBe('You are the Brain.');
    expect(c.cwd).toBe('/proj');
    // it may read, nothing else (and no .env files)
    const rules = (
      c.config.agents as Record<string, { permissions: { action: string; resource: string; effect: string }[] }>
    )['athena-brain']!.permissions;
    expect(rules[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    expect(rules.filter((r) => r.effect === 'allow').map((r) => r.action)).toEqual(['read', 'glob', 'grep']);
    expect(rules.at(-1)).toMatchObject({ action: 'read', effect: 'deny' });
    // the files are gone after
    expect(fs.existsSync(String(c.env.OPENCODE_CONFIG))).toBe(false);
  });

  it('without tools it may not even read; with no model, opencode picks', async () => {
    saveSettings({ brain: { provider: 'opencode', model: '' } });
    fake.lines = [line('text', { id: 'p1', type: 'text', text: '{"kind":"none"}' })];
    expect(await think('Route this.', 'hello')).toBe('{"kind":"none"}');
    const c = fake.calls[0]!;
    expect(c.args).not.toContain('-m');
    const rules = (c.config.agents as Record<string, { permissions: { effect: string }[] }>)['athena-brain']!
      .permissions;
    expect(rules).toEqual([{ action: '*', resource: '*', effect: 'deny' }]);
  });

  it('says why when it gives no answer', async () => {
    saveSettings({ brain: { provider: 'opencode', model: '' } });
    fake.lines = [
      JSON.stringify({ type: 'error', error: { type: 'provider.free-limit', message: 'Free usage limit reached.' } }),
    ];
    fake.code = 1;
    await expect(think('s', 'u')).rejects.toThrow(/Free usage limit reached/);
  });
});
