// launch_program and open_path ask first for anything that runs code, judged on what really starts.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { riskOf } from '../../server/tools.ts';
import { launchTarget } from '../../server/programs.ts';
import { dataPath, ensureDir } from '../../server/util.ts';

describe('launch risk', () => {
  it('an interpreter with a trailing space is still an interpreter', () => {
    const dir = ensureDir(dataPath('fake-bin'));
    const node = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.writeFileSync(node, '');
    // the same program for the check and the launch
    expect(launchTarget(`${node} `, true)?.exe).toBe(node);
    expect(riskOf('launch_program', { program: `${node} `, file: 'notes.txt' })).toBe('high');
    expect(riskOf('launch_program', { program: node, file: 'notes.txt' })).toBe('high');
    expect(riskOf('launch_program', { program: ' NODE ' })).toBe('high');
  });

  it('any version or windowless variant of an interpreter is one too', () => {
    const dir = ensureDir(dataPath('fake-bin-variants'));
    for (const name of ['python3.12', 'pythonw.exe', 'python3.12w', 'node22', 'javaw.exe', 'perl5.36', 'pwsh.exe']) {
      const exe = path.join(dir, name);
      fs.writeFileSync(exe, '');
      expect(riskOf('launch_program', { program: exe, file: path.join(dir, 'script.txt') }), name).toBe('high');
      expect(riskOf('launch_program', { program: name }), name).toBe('high');
    }
    // a program that only looks a bit like one is still a plain launch
    expect(riskOf('launch_program', { program: 'photoshop' })).toBe('low');
    expect(riskOf('launch_program', { program: 'notepad' })).toBe('low');
  });

  it('a script handed to a program needs a yes, Adobe scripts too', () => {
    expect(riskOf('launch_program', { program: 'photoshop', file: 'x.jsx' })).toBe('high');
    expect(riskOf('launch_program', { program: 'photoshop', file: 'x.jsxbin' })).toBe('high');
    expect(riskOf('launch_program', { program: 'photoshop', file: 'x.py. ' })).toBe('high');
    expect(riskOf('open_path', { path: 'C:/x/run.jsx' })).toBe('high');
    expect(riskOf('open_path', { path: 'C:/x/run.bat  ' })).toBe('high');
    expect(riskOf('open_path', { path: 'C:/x/picture.png' })).toBe('low');
  });
});

describe('a program path set in Settings', () => {
  it('is the one launched at once, whatever the last scan found', async () => {
    const { saveSettings } = await import('../../server/store.ts');
    const { discoverPrograms } = await import('../../server/programs.ts');
    await discoverPrograms();
    const dir = ensureDir(dataPath('fake-blender'));
    const exe = path.join(dir, process.platform === 'win32' ? 'blender-4.exe' : 'blender-4');
    fs.writeFileSync(exe, '');
    saveSettings({ paths: { blender: exe } });
    try {
      expect(launchTarget('blender', false)).toMatchObject({ exe, onPath: false });
    } finally {
      saveSettings({ paths: { blender: '' } });
    }
  });
});

describe('a program that cannot start', () => {
  it('says so instead of "Started"', async () => {
    const { saveSettings } = await import('../../server/store.ts');
    const { launchProgram } = await import('../../server/programs.ts');
    const dir = ensureDir(dataPath('fake-broken'));
    // (not a program at all, only named like one, and not runnable)
    const exe = path.join(dir, process.platform === 'win32' ? 'blender-broken.exe' : 'blender-broken');
    fs.writeFileSync(exe, 'not a program');
    if (process.platform !== 'win32') fs.chmodSync(exe, 0o644);
    saveSettings({ paths: { blender: exe } });
    try {
      await expect(launchProgram('blender')).rejects.toThrow(/didn't start/);
    } finally {
      saveSettings({ paths: { blender: '' } });
    }
  });
});
