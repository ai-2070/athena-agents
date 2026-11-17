// A Brain answer is made in the project it was asked in: another project opened while it looks at the folder doesn't
// put that project's agents into what the model is told (BH-070).
import { describe, expect, it, vi } from 'vitest';

const asked: string[] = [];
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null, reached: false }));
vi.mock('../../server/brain.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brain.ts')>()),
  brainModel: () => ({ provider: 'openrouter', model: 'mock', fallback: false }),
  think: async (system: string, user: string) => {
    asked.push(`${system}\n${user}`);
    return 'Noted.';
  },
}));
// (the Brain's run on its engine, played by the tests' stand-in: it asks think() above)
vi.mock('../../server/brainrun.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brainrun.ts')>()),
  runBrain: (await import('./brain-fake.ts')).thinkingBrain,
}));
vi.mock('../../server/projects.ts', async (orig) => {
  const real = await orig<typeof import('../../server/projects.ts')>();
  return {
    ...real,
    brainInfo: async (...args: Parameters<typeof real.brainInfo>) => {
      gate.reached = true;
      if (gate.hold) await gate.hold;
      return real.brainInfo(...args);
    },
  };
});

const { ask } = await import('../../server/overseer.ts');
const { createProject } = await import('../../server/projects.ts');
const { setActiveProject, withProject } = await import('../../server/store.ts');
const { newAgent } = await import('../../server/library.ts');

describe('a Brain answer while another project opens', () => {
  it('tells the model only the project it was asked in', async () => {
    const a = await createProject({ name: 'Asked here', mode: 'new' });
    withProject(a, () => newAgent({ name: 'Agent of A' }));
    const b = await createProject({ name: 'Opened meanwhile', mode: 'new' });
    withProject(b, () => newAgent({ name: 'Agent of B' }));
    setActiveProject(a.id);
    let release = () => {};
    gate.hold = new Promise<void>((r) => (release = r));
    const answering = ask('Who is on the team?');
    await vi.waitFor(() => expect(gate.reached).toBe(true));
    setActiveProject(b.id);
    release();
    gate.hold = null;
    await answering;
    const prompt = asked.at(-1) || '';
    expect(prompt).toContain('Agent of A');
    expect(prompt).not.toContain('Agent of B');
  });
});
