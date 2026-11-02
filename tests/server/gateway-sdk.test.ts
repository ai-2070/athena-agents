import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { dataPath } from '../../server/util.ts';

const exec = promisify(execFile);

describe('pinned Chat SDK transport proof', () => {
  it.each(['bun', process.execPath])('receives and replies with a private file under %s', async (runtime) => {
    const { stdout } = await exec(runtime, ['scripts/gateways-smoke.ts'], { env: process.env, timeout: 20000, windowsHide: true });
    expect(stdout).toContain('Telegram polling, sender filter, private download, file reply and persistent subscription pass');
  });

  it('bundles the SDK and state adapter and runs from read-only application files outside the repo', async () => {
    const directory = dataPath('sdk-bundle');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'proof.mjs');
    await exec('bun', ['build', 'scripts/gateways-smoke.ts', '--target=bun', '--outfile', file], { env: process.env, timeout: 20000, windowsHide: true });
    fs.chmodSync(file, 0o444);
    fs.chmodSync(directory, 0o555);
    try {
      const { stdout } = await exec('bun', [file], { cwd: directory, env: process.env, timeout: 20000, windowsHide: true });
      expect(stdout).toContain('persistent subscription pass');
    } finally {
      fs.chmodSync(directory, 0o755);
      fs.chmodSync(file, 0o644);
    }
  });
});
