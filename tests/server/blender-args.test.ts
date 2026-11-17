// Blender reads its arguments in order: the exit code for a failing script is set before the script runs, or a
// script that fails could still end as "Finished" (BH-164).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const ran = vi.hoisted(() => [] as { cmd: string; args: string[] }[]);
vi.mock('../../server/util.ts', async (orig) => {
  const real = await orig<typeof import('../../server/util.ts')>();
  return {
    ...real,
    run: async (cmd: string, args: string[]) => {
      ran.push({ cmd, args });
      return { code: 0, stdout: 'ok', stderr: '' };
    },
  };
});

const { callTool } = await import('../../server/tools.ts');
const { saveSettings } = await import('../../server/store.ts');
const { dataPath, ensureDir } = await import('../../server/util.ts');

describe('blender_run_python', () => {
  it('sets the exit code for a failing script before the script', async () => {
    const exe = path.join(
      ensureDir(dataPath('fake-blender-args')),
      process.platform === 'win32' ? 'blender.exe' : 'blender',
    );
    fs.writeFileSync(exe, '');
    saveSettings({ paths: { blender: exe } });
    try {
      await callTool(
        { id: 'b', name: 'Blender user', toolGroups: ['blender'], autonomy: 'full', knowledge: { folders: [] } },
        'blender_run_python',
        { code: 'print(1)' },
      );
    } finally {
      saveSettings({ paths: { blender: '' } });
    }
    const args = ran.find((r) => r.cmd === exe)!.args;
    expect(args.indexOf('--python-exit-code')).toBeGreaterThan(-1);
    expect(args.indexOf('--python-exit-code')).toBeLessThan(args.indexOf('--python'));
  });
});
