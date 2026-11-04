// The shell tool (run_command): what it hands the shell it picked (commandShell).
import { describe, expect, it, vi } from 'vitest';
import type { RunOptions } from '../../server/util.ts';

const calls: { cmd: string; args: string[]; opts: RunOptions }[] = [];
vi.mock('../../server/util.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/util.ts')>()),
  run: async (cmd: string, args: string[] = [], opts: RunOptions = {}) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: 'ok', stderr: '' };
  },
}));

const { callTool } = await import('../../server/tools.ts');
const { commandShell } = await import('../../server/util.ts');
// the user has said yes to this tool for good, so no approval is asked for
const agent = { id: 'a1', name: 'Tester', toolGroups: ['shell'], alwaysAllow: ['run_command'] };

describe('run_command', () => {
  it('runs the shell with Python set to print UTF-8, unless the user chose otherwise', async () => {
    const before = process.env.PYTHONUTF8;
    try {
      delete process.env.PYTHONUTF8;
      await callTool(agent, 'run_command', { command: 'python make_report.py' });
      const sh = commandShell();
      expect(calls.at(-1)).toMatchObject({ cmd: sh.exe, args: sh.args('python make_report.py') });
      expect(calls.at(-1)?.opts.env).toEqual({ PYTHONUTF8: '1' });

      process.env.PYTHONUTF8 = '0';
      await callTool(agent, 'run_command', { command: 'python make_report.py' });
      expect(calls.at(-1)?.opts.env).toEqual({ PYTHONUTF8: '0' });
    } finally {
      if (before === undefined) delete process.env.PYTHONUTF8;
      else process.env.PYTHONUTF8 = before;
    }
  });
});
