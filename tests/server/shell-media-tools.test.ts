// run_command picks the shell this PC has; the media tools run in the agent's workspace.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { callTool, toolDefs } from '../../server/tools.ts';
import { commandShell, pickShell } from '../../server/util.ts';
import type { ToolAgent } from '../../server/tools.ts';

// Pretend ffmpeg, ffprobe, ImageMagick and HandBrakeCLI are installed and note where each was started.
const FAKE = ['ffmpeg', 'ffprobe', 'magick', 'HandBrakeCLI'];
const started = vi.hoisted(() => [] as { cmd: string; cwd?: string }[]);
vi.mock('../../server/util.ts', async (orig) => {
  const real = await orig<typeof import('../../server/util.ts')>();
  const fake = (cmd: string) => FAKE.includes(path.basename(cmd));
  return {
    ...real,
    which: (cmd: string) => (fake(cmd) ? `/fake/${cmd}` : real.which(cmd)),
    run: async (cmd: string, args: string[] = [], opts: import('../../server/util.ts').RunOptions = {}) => {
      if (!fake(cmd)) return real.run(cmd, args, opts);
      started.push({ cmd: path.basename(cmd), cwd: opts.cwd });
      return { code: 0, stdout: '{}', stderr: '' };
    },
  };
});

function agentWith(groups: string[]): { agent: ToolAgent; workspace: string } {
  const workspace = fs.mkdtempSync(path.join(os.homedir(), 'tools-'));
  return { workspace, agent: { id: `t-${path.basename(workspace)}`, name: 'Tools', toolGroups: groups, autonomy: 'full', workspace, knowledge: { folders: [] } } };
}

describe('pickShell()', () => {
  const has = (...found: string[]) => (cmd: string) => (found.includes(cmd) ? `/bin/${cmd}` : null);

  it('prefers PowerShell 7 everywhere it is installed', () => {
    expect(pickShell(true, has('pwsh', 'powershell')).name).toBe('PowerShell 7');
    expect(pickShell(false, has('pwsh', 'bash')).exe).toBe('/bin/pwsh');
    expect(pickShell(true, has('pwsh')).args('dir')).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'dir']);
  });

  it('falls back to Windows PowerShell on Windows', () => {
    const sh = pickShell(true, has('powershell', 'bash'));
    expect(sh.name).toBe('Windows PowerShell');
    expect(sh.args('dir')).toEqual(['-NoProfile', '-NonInteractive', '-Command', 'dir']);
    expect(pickShell(true, has()).exe).toBe('powershell');
  });

  it('uses bash, else sh, on macOS and Linux, where powershell usually is not there', () => {
    const bash = pickShell(false, has('powershell', 'bash', 'sh'));
    expect(bash.exe).toBe('/bin/bash');
    expect(bash.args('ls')).toEqual(['--noprofile', '--norc', '-c', 'ls']);
    const sh = pickShell(false, has('sh'));
    expect(sh.name).toBe('sh');
    expect(sh.args('ls')).toEqual(['-c', 'ls']);
    expect(pickShell(false, has()).exe).toBe('/bin/sh');
  });
});

describe('run_command', () => {
  it('names the shell it uses on this PC', () => {
    const { agent } = agentWith(['shell']);
    const tool = toolDefs(agent).find((t) => t.name === 'run_command');
    expect(tool?.description).toContain(`Run a ${commandShell().name} command`);
  });

  it('runs in that shell, in the workspace', async () => {
    const { agent, workspace } = agentWith(['shell']);
    const r = await callTool(agent, 'run_command', { command: 'echo made > made.txt' });
    expect(r.isError).toBeFalsy();
    expect(fs.existsSync(path.join(workspace, 'made.txt'))).toBe(true);
  }, 30_000);
});

describe('media tools', () => {
  it('start in the workspace, not the app folder', async () => {
    const { agent, workspace } = agentWith(['media']);
    fs.writeFileSync(path.join(workspace, 'in.mp4'), '');
    started.length = 0;
    await callTool(agent, 'ffmpeg', { args: ['-n', '-i', 'in.mp4', 'out.mp4'] });
    await callTool(agent, 'ffprobe', { file: 'in.mp4' });
    await callTool(agent, 'imagemagick', { args: ['in.png', 'out.webp'] });
    const hb = await callTool(agent, 'handbrake_encode', { input: path.join(workspace, 'in.mp4'), output: path.join(workspace, 'out.mkv') });
    expect(hb.text).toContain('HandBrake');
    expect(started.map((s) => s.cmd).sort()).toEqual(['HandBrakeCLI', 'ffmpeg', 'ffprobe', 'magick']);
    for (const s of started) expect(s.cwd).toBe(workspace);
  });

  it('ffmpeg is told not to overwrite unless the file is its own', () => {
    const { agent } = agentWith(['media']);
    const desc = toolDefs(agent).find((t) => t.name === 'ffmpeg')?.description || '';
    expect(desc).toContain('-n (never overwrite)');
    expect(desc).not.toMatch(/always pass -y/i);
    expect(desc).not.toContain('"-y"');
  });
});
