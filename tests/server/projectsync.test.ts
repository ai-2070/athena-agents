import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agents, workflows, setActiveProject } from '../../server/store.ts';
import { createProject, removeProject } from '../../server/projects.ts';
import { newAgent } from '../../server/library.ts';
import * as sync from '../../server/projectsync.ts';
import type { Team } from '../../shared/types.ts';

const folder = (name: string) => path.join(os.homedir(), 'projects', name);

describe('auto-save into the project folder', () => {
  it('writes agents, teams and project info into <folder>/.dashboard, never secrets', async () => {
    const p = await createProject({ name: 'Saved one', mode: 'new', folder: folder('saved-one'), description: 'A test project' });
    const a = newAgent({ name: 'Writer' });
    workflows.save({ name: 'Crew', members: [a.id], lead: a.id, steps: [] } as Partial<Team>);
    const st = sync.saveProject(p.id);
    expect(st).toMatchObject({ agents: 1, teams: 1 });
    const file = JSON.parse(fs.readFileSync(path.join(p.brainPath, '.dashboard', 'project.json'), 'utf8'));
    expect(file.app).toBe('my-dashboard');
    expect(file.project).toMatchObject({ name: 'Saved one', description: 'A test project' });
    expect(file.agents.map((x: { name: string }) => x.name)).toEqual(['Writer']);
    expect(JSON.stringify(file)).not.toMatch(/openrouterKey|secret/i);
    expect(sync.peek(p.brainPath)).toMatchObject({ name: 'Saved one', agents: 1, teams: 1 });
  });

  it('keeps a backup when a save would have fewer agents than the last one', async () => {
    const p = await createProject({ name: 'Backups', mode: 'new', folder: folder('backups') });
    const a = newAgent({ name: 'One' });
    newAgent({ name: 'Two' });
    sync.saveProject(p.id);
    agents.remove(a.id);
    sync.saveProject(p.id);
    const backups = fs.readdirSync(path.join(p.brainPath, '.dashboard', 'backups'));
    expect(backups.length).toBe(1);
    const old = JSON.parse(fs.readFileSync(path.join(p.brainPath, '.dashboard', 'backups', backups[0]), 'utf8'));
    expect(old.agents).toHaveLength(2);
  });

  it('opening a saved folder as a new project brings its agents and teams back', async () => {
    const dir = folder('round-trip');
    const p = await createProject({ name: 'Round trip', mode: 'new', folder: dir });
    const a = newAgent({ name: 'Researcher', skills: ['method'] });
    workflows.save({ name: 'Research desk', members: [a.id], lead: a.id, steps: [] } as Partial<Team>);
    sync.saveProject(p.id);
    // remove it from the dashboard, then open the same folder again
    const other = await createProject({ name: 'Elsewhere', mode: 'new', folder: folder('elsewhere') });
    setActiveProject(other.id);
    removeProject(p.id);
    const again = await createProject({ name: 'Round trip again', mode: 'existing', folder: dir });
    const restored = sync.restoreInto(again.id, dir);
    expect(restored).toMatchObject({ agents: 1, teams: 1 });
    setActiveProject(again.id);
    expect(agents.list().map((x) => [x.name, x.skills])).toEqual([['Researcher', ['method']]]);
    expect(workflows.list()[0]).toMatchObject({ name: 'Research desk', members: [a.id], lead: a.id });
  });

  it('never restores over a project that already has agents', async () => {
    const dir = folder('busy');
    const p = await createProject({ name: 'Busy', mode: 'new', folder: dir });
    newAgent({ name: 'Already here' });
    sync.saveProject(p.id);
    expect(sync.restoreInto(p.id, dir)).toBeNull();
  });
});
