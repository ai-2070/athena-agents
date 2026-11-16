// Stop while Codex's version is still being looked up: nothing is started afterwards (BH-033).
import { describe, expect, it, vi } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { chats } from '../../server/store.ts';

const held = vi.hoisted(() => ({ release: () => {}, spawned: [] as string[] }));
vi.mock('../../server/util.ts', async (orig) => {
  const real = await orig<typeof import('../../server/util.ts')>();
  return {
    ...real,
    which: (cmd: string) => (cmd === 'codex' ? '/usr/bin/codex' : real.which(cmd)),
    // `codex --version` and `codex login status` answer only when the test lets them
    run: (cmd: string, args: string[], o: object) =>
      cmd === 'codex'
        ? new Promise((resolve) => {
            const was = held.release;
            held.release = () => {
              was();
              resolve({ code: 0, stdout: args[0] === '--version' ? 'codex-cli 0.166.0' : 'Logged in', stderr: '' });
            };
          })
        : real.run(cmd, args, o),
    spawnCommand: (cmd: string, args: string[]) => {
      held.spawned.push(cmd);
      throw new Error(`should not start ${cmd} ${args.join(' ')}`);
    },
  };
});

describe('Codex and Stop', () => {
  it('starts nothing when stopped while it looks up the version', async () => {
    const { run } = await import('../../server/engines/codex.ts');
    const agent = newAgent({ name: 'Coder', engine: 'codex' });
    const stop = new AbortController();
    const going = run({
      agent,
      chat: chats.create(agent.id),
      text: 'Do it',
      signal: stop.signal,
      onEvent: () => {},
      systemPrompt: 'You are Coder.',
      runId: 'r-stop',
      depth: 0,
      attachments: [],
    });
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    held.release();
    await expect(going).rejects.toThrow('Stopped.');
    expect(held.spawned).toEqual([]);
  });
});
