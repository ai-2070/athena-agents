// The Brain's answer belongs to the project it was asked in, even if you switch projects while it thinks.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  activeProject,
  listProjects,
  saveProjects,
  setActiveProject,
  withProject,
  workflows,
} from '../../server/store.ts';
import { ensureBrain } from '../../server/projects.ts';
import { ask, history } from '../../server/overseer.ts';

// the "model" switches projects while it thinks, then asks for a team and a new PROJECT.md
vi.mock('../../server/brainrun.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brainrun.ts')>()),
  runBrain: (await import('./brain-fake.ts')).thinkingBrain,
}));
vi.mock('../../server/brain.ts', async (orig) => ({
  ...(await orig<typeof import('../../server/brain.ts')>()),
  brainModel: () => ({ provider: 'openrouter', model: 'mock', fallback: false }),
  think: async () => {
    setActiveProject('other-2');
    return 'Done.\n```actions\n[{"do":"create_team","name":"Ghost","members":[{"new":{"name":"Ghost"}}]},{"do":"write_project_md","content":"# Somewhere else entirely, long enough"}]\n```';
  },
}));

describe('ask()', () => {
  it('applies its actions in the project it was asked in, not the one you switched to', async () => {
    const home = activeProject();
    saveProjects([
      ...listProjects(),
      { ...home, id: 'other-2', name: 'Other', brainPath: path.join(path.dirname(home.brainPath), 'other-2') },
    ]);
    try {
      const r = await ask('Set things up');
      expect(r.done.map((d) => d.kind)).toEqual(['hired', 'team', 'file']);
      expect(workflows.list().some((w) => w.name === 'Ghost')).toBe(false);
      expect(withProject(home, () => workflows.list().some((w) => w.name === 'Ghost'))).toBe(true);
      expect(fs.existsSync(path.join(ensureBrain(activeProject()), 'PROJECT.md'))).toBe(false);
      // the exchange is kept in the chat of the project it was asked in
      expect(history(home.id).map((m) => m.role)).toEqual(['user', 'brain']);
      expect(history('other-2')).toEqual([]);
    } finally {
      setActiveProject(home.id);
    }
    expect(workflows.list().some((w) => w.name === 'Ghost')).toBe(true);
  });
});
