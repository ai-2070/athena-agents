// Tool output: commands keep their start and end, run in the platform's shell, and schemas say what tools read.
import { describe, it, expect } from 'vitest';
import { callTool, toolDefs } from '../../server/tools.ts';
import { commandShell, truncateMiddle } from '../../server/util.ts';

const shell = { id: 'shell-agent', name: 'Sheller', toolGroups: ['shell', 'social'], autonomy: 'full' as const };

describe('truncateMiddle', () => {
  it('keeps the start and the end of long text', () => {
    const text = `START${'x'.repeat(10_000)}END`;
    const cut = truncateMiddle(text, 1000);
    expect(cut.startsWith('START')).toBe(true);
    expect(cut.endsWith('END')).toBe(true);
    expect(cut).toMatch(/characters left out here/);
    expect(cut.length).toBeLessThan(1100);
    expect(truncateMiddle('short', 1000)).toBe('short');
  });
});

describe('run_command', () => {
  it("runs in this platform's shell and starts with the exit code", async () => {
    const r = await callTool(shell, 'run_command', { command: 'echo hello-athena' });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^exit 0\n/);
    expect(r.text).toContain('hello-athena');
  });

  it('keeps the end of long output, where errors usually are', async () => {
    const command = /PowerShell/.test(commandShell().name)
      ? '1..4000 | ForEach-Object { "line $_" }; "LAST-LINE"'
      : 'for i in $(seq 1 4000); do echo "line $i"; done; echo LAST-LINE';
    const r = await callTool(shell, 'run_command', { command });
    expect(r.text).toContain('line 1');
    expect(r.text).toContain('LAST-LINE');
    expect(r.text).toMatch(/left out here/);
  });

  it('names the shell it uses', () => {
    const tool = toolDefs(shell).find((t) => t.name === 'run_command')!;
    expect(tool.description).toContain(`Run a ${commandShell().name} command`);
  });
});

describe('schemas', () => {
  it('reddit_draft_post offers the note it reads', () => {
    const tool = toolDefs(shell).find((t) => t.name === 'reddit_draft_post')!;
    expect(Object.keys(tool.parameters.properties || {})).toContain('note');
  });

  it('X reads say how many they return at most', () => {
    for (const name of ['x_recent_posts', 'x_mentions'])
      expect(toolDefs(shell).find((t) => t.name === name)!.parameters.properties!.limit.description).toMatch(/5-50/);
  });
});
