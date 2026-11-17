// Auto-save saves a project shortly after its name or description changes, and after its world link changes, open
// or not (BH-013).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createProject, updateProject } from '../../server/projects.ts';
import { emit } from '../../server/store.ts';
import * as sync from '../../server/projectsync.ts';

const saved = (folder: string) =>
  JSON.parse(fs.readFileSync(path.join(folder, '.dashboard', 'project.json'), 'utf8')) as {
    project?: { name?: string; description?: string };
  };
afterAll(() => vi.useRealTimers());

describe('auto-save on project changes', () => {
  it('saves after a rename or a new description, and after a world link change', async () => {
    const folder = path.join(os.homedir(), 'projects', 'watched');
    const p = await createProject({ name: 'Watched', mode: 'new', folder });
    sync.saveProject(p.id);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval'] });
    sync.startAutoSave();
    updateProject(p.id, { name: 'Watched, renamed', description: 'Now with words' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(saved(folder).project).toMatchObject({ name: 'Watched, renamed', description: 'Now with words' });
    // a world link change for this project (not the open one) names it in the event
    fs.rmSync(path.join(folder, '.dashboard', 'project.json'));
    emit('world', { project: p.id });
    await vi.advanceTimersByTimeAsync(3000);
    expect(fs.existsSync(path.join(folder, '.dashboard', 'project.json'))).toBe(true);
  });
});
