// Stop while the script sandbox is still starting (it takes a moment the first time): nothing is built (BH-146).
import { describe, expect, it, vi } from 'vitest';

const gate = vi.hoisted(() => ({ open: null as (() => void) | null, started: null as (() => void) | null }));
vi.mock('../../server/voxel/script.ts', async (orig) => {
  const real = await orig<typeof import('../../server/voxel/script.ts')>();
  return {
    ...real,
    loadSandbox: async () => {
      gate.started?.();
      await new Promise<void>((r) => (gate.open = r));
      return real.loadSandbox();
    },
  };
});

const { callTool } = await import('../../server/tools.ts');
const { newAgent } = await import('../../server/library.ts');
const { agents, saveSettings } = await import('../../server/store.ts');
const { shownWorld } = await import('../../server/voxel/link.ts');

describe('stopping a script build while its sandbox starts', () => {
  it('builds nothing', async () => {
    saveSettings({ look: { stationLook: 'world' } });
    const a = agents.save(newAgent({ name: 'Stopped coder', toolGroups: ['world'], autonomy: 'full' }));
    const stop = new AbortController();
    const started = new Promise<void>((r) => (gate.started = r));
    const result = callTool(
      a,
      'world_build',
      { object: 'Never', code: 'use("stone"); box([0, 0, 0], [1, 1, 1]);' },
      { signal: stop.signal },
    );
    await started;
    stop.abort();
    gate.open?.();
    const r = await result;
    expect(r.isError).toBe(true);
    expect(shownWorld().world?.objects.some((o) => o.name === 'Never') ?? false).toBe(false);
  });
});
