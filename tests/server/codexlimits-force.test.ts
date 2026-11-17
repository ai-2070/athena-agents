// A forced limits read (just after a reset) doesn't hand back a read that began before the reset (BH-101).
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

// each start of `codex app-server` takes the next of these: the usage it reports, once it is let go
const reads = vi.hoisted(() => [] as { percent: number; go: Promise<void> }[]);
vi.mock('../../server/util.ts', async (orig) => {
  const real = await orig<typeof import('../../server/util.ts')>();
  return {
    ...real,
    killTree: () => {},
    spawnCommand: (cmd: string, ...rest: unknown[]) => {
      if (cmd !== 'codex') return (real.spawnCommand as (...a: unknown[]) => unknown)(cmd, ...rest);
      const next = reads.shift()!;
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        pid: 1,
      });
      child.stdin.on('data', async (d: Buffer) => {
        for (const line of d.toString().split('\n').filter(Boolean)) {
          const m = JSON.parse(line) as { id?: number };
          if (m.id === 1) child.stdout.write(`${JSON.stringify({ id: 1, result: {} })}\n`);
          if (m.id === 2) {
            await next.go;
            const window = { usedPercent: next.percent, windowDurationMins: 300, resetsAt: null };
            child.stdout.write(`${JSON.stringify({ id: 2, result: { rateLimits: { primary: window } } })}\n`);
          }
        }
      });
      return child;
    },
  };
});

const { codexLimits } = await import('../../server/codexlimits.ts');

describe('reading Codex limits after a reset', () => {
  it('waits for a read already going, then reads again', async () => {
    let letGo = () => {};
    reads.push({ percent: 90, go: new Promise<void>((r) => (letGo = r)) });
    reads.push({ percent: 0, go: Promise.resolve() });
    // a tab's regular read, still going when the reset happens
    const before = codexLimits();
    await new Promise((r) => setTimeout(r, 20));
    const after = codexLimits({ force: true });
    letGo();
    expect((await before)?.windows[0]?.percent).toBe(90);
    expect((await after)?.windows[0]?.percent).toBe(0);
  });
});
