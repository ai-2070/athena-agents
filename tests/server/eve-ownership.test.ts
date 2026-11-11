import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { claimEveRuntime, eveOwnershipPort } from '../../server/eve/ownership.ts';
import { EveRuntime } from '../../server/eve/runtime.ts';
import { dataPath } from '../../server/util.ts';

describe('Eve process ownership', () => {
  it('has one owner per resolved runtime directory, with idempotent release', async () => {
    const directory = dataPath('runtime', 'ownership-fixture');
    const release = await claimEveRuntime(directory);
    try {
      expect(eveOwnershipPort(directory)).toBe(eveOwnershipPort(dataPath('runtime', '.', 'ownership-fixture')));
      await expect(claimEveRuntime(directory)).rejects.toThrow('ownership port');
    } finally {
      await release();
    }
    await release();
    const again = await claimEveRuntime(directory);
    await again();
  });

  it('releases ownership on process death without trusting a stale PID or lease file', async () => {
    const directory = dataPath('runtime', 'crashed-ownership-fixture');
    const code = `import { claimEveRuntime } from './server/eve/ownership.ts'; await claimEveRuntime(${JSON.stringify(directory)}); console.log('owned'); setInterval(()=>{},1000);`;
    const child = spawn('bun', ['--eval', code], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      const output = await Promise.race([
        once(child.stdout!, 'data').then((chunks: unknown[]) => String(chunks[0])),
        once(child, 'exit').then(() => {
          throw new Error('The ownership fixture exited early.');
        }),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error('The ownership fixture timed out.')), 10000).unref();
        }),
      ]);
      expect(output).toContain('owned');
      await expect(claimEveRuntime(directory)).rejects.toThrow('ownership port');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      const release = await claimEveRuntime(directory);
      await release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('does not reconcile or launch while another process owns the runtime', async () => {
    const directory = dataPath('runtime', 'claimed-startup-fixture');
    const release = await claimEveRuntime(directory);
    let mutations = 0;
    const runtime = new EveRuntime({
      claim: () => claimEveRuntime(directory),
      prepare: () => {
        mutations++;
      },
      bridge: async () => {
        throw new Error('Must not open');
      },
      host: async () => {
        throw new Error('Must not launch');
      },
      recover: async () => {
        mutations++;
      },
      hasWork: () => false,
    });
    try {
      await expect(runtime.ready()).rejects.toThrow('ownership port');
      expect(mutations).toBe(0);
    } finally {
      await runtime.close();
      await release();
    }
  });
});
