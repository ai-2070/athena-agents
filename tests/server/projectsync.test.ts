import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agents, workflows, setActiveProject, setSecret } from '../../server/store.ts';
import { createProject, removeProject } from '../../server/projects.ts';
import { newAgent } from '../../server/library.ts';
import { dataPath } from '../../server/util.ts';
import * as sync from '../../server/projectsync.ts';
import type { Team } from '../../shared/types.ts';

const folder = (name: string) => path.join(os.homedir(), 'projects', name);
// every file under dir, as one string
const allText = (dir: string): string =>
  fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'utf8'))
    .join('\n');
const linksWork = process.platform !== 'win32'; // file links need admin rights on Windows

describe('auto-save into the project folder', () => {
  it('writes agents, teams and project info into <folder>/.dashboard, never secrets', async () => {
    setSecret('openrouterKey', 'sk-or-v1-sentinel-do-not-save-4242');
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
    expect(allText(path.join(p.brainPath, '.dashboard'))).not.toContain('sentinel-do-not-save');
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

  it('keeps a backup when only a routine was deleted, and brings routines back from the folder', async () => {
    const { saveRoutine, deleteRoutine } = await import('../../server/routines.ts');
    const p = await createProject({ name: 'Routine backups', mode: 'new', folder: folder('routine-backups') });
    newAgent({ name: 'Keeper' });
    const r1 = saveRoutine({ name: 'Daily', text: '@Keeper checks in.' });
    saveRoutine({ name: 'Weekly', text: '@Keeper sums up.' });
    sync.saveProject(p.id);
    deleteRoutine(r1.id);
    sync.saveProject(p.id);
    const dir = path.join(p.brainPath, '.dashboard');
    const backups = fs.readdirSync(path.join(dir, 'backups'));
    expect(backups.length).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'backups', backups[0]), 'utf8')).routines.map((x: { name: string }) => x.name).sort()).toEqual(['Daily', 'Weekly']);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')).routines.map((x: { name: string }) => x.name)).toEqual(['Weekly']);
    // the folder opened as another project brings the routine back
    const copy = await createProject({ name: 'Routine copy', mode: 'existing', folder: p.brainPath });
    expect(sync.restoreInto(copy.id, p.brainPath)).toMatchObject({ agents: 1 });
    expect(fs.readdirSync(dataPath('projects', copy.id, 'routines'))).toHaveLength(1);
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

  it('drops team chats and knowledge files that were deleted in the dashboard', async () => {
    const p = await createProject({ name: 'Pruned', mode: 'new', folder: folder('pruned') });
    const src = (...x: string[]) => dataPath('projects', p.id, ...x);
    const out = (...x: string[]) => path.join(p.brainPath, '.dashboard', ...x);
    fs.mkdirSync(src('teamchats'), { recursive: true });
    fs.writeFileSync(src('teamchats', 'gone.json'), '{"messages":[]}');
    fs.writeFileSync(src('teamchats', 'kept.json'), '{"messages":[]}');
    fs.mkdirSync(src('knowledge', 'agent-1'), { recursive: true });
    fs.writeFileSync(src('knowledge', 'agent-1', 'old.md'), 'old');
    fs.writeFileSync(src('knowledge', 'agent-1', 'still.md'), 'still');
    fs.mkdirSync(src('knowledge', 'agent-2'), { recursive: true });
    fs.writeFileSync(src('knowledge', 'agent-2', 'notes.md'), 'notes');
    sync.saveProject(p.id);
    expect(fs.existsSync(out('teamchats', 'gone.json'))).toBe(true);
    expect(fs.existsSync(out('knowledge', 'agent-2', 'notes.md'))).toBe(true);
    fs.rmSync(src('teamchats', 'gone.json'));
    fs.rmSync(src('knowledge', 'agent-1', 'old.md'));
    fs.rmSync(src('knowledge', 'agent-2'), { recursive: true });
    expect(sync.saveProject(p.id)?.error).toBeUndefined();
    expect(fs.readdirSync(out('teamchats'))).toEqual(['kept.json']);
    expect(fs.readdirSync(out('knowledge'))).toEqual(['agent-1']);
    expect(fs.readdirSync(out('knowledge', 'agent-1'))).toEqual(['still.md']);
  });

  it.runIf(linksWork)("won't write through a link planted in the project folder", async () => {
    const p = await createProject({ name: 'Planted', mode: 'new', folder: folder('planted') });
    const victim = path.join(os.homedir(), 'victim.txt');
    fs.writeFileSync(victim, 'original');
    fs.mkdirSync(path.join(p.brainPath, '.dashboard', 'teamchats'), { recursive: true });
    fs.symlinkSync(victim, path.join(p.brainPath, '.dashboard', 'teamchats', 'team-1.json'));
    fs.mkdirSync(dataPath('projects', p.id, 'teamchats'), { recursive: true });
    fs.writeFileSync(dataPath('projects', p.id, 'teamchats', 'team-1.json'), '{"messages":["overwritten"]}');
    expect(sync.saveProject(p.id)?.error).toMatch(/link/);
    expect(fs.readFileSync(victim, 'utf8')).toBe('original');
  });

  it.runIf(linksWork)("won't empty a folder that a planted knowledge link points at", async () => {
    const p = await createProject({ name: 'Planted dir', mode: 'new', folder: folder('planted-dir') });
    const precious = path.join(os.homedir(), 'precious');
    fs.mkdirSync(precious, { recursive: true });
    fs.writeFileSync(path.join(precious, 'thesis.md'), 'years of work');
    fs.mkdirSync(path.join(p.brainPath, '.dashboard'), { recursive: true });
    fs.symlinkSync(precious, path.join(p.brainPath, '.dashboard', 'knowledge'));
    fs.mkdirSync(dataPath('projects', p.id, 'knowledge', 'agent-1'), { recursive: true });
    fs.writeFileSync(dataPath('projects', p.id, 'knowledge', 'agent-1', 'a.md'), 'a');
    expect(sync.saveProject(p.id)?.error).toMatch(/link/);
    expect(fs.readdirSync(precious)).toEqual(['thesis.md']);
  });

  it.runIf(linksWork)("doesn't follow links when restoring team chats", async () => {
    const dir = folder('crafted');
    const secret = path.join(os.homedir(), 'secret.json');
    fs.writeFileSync(secret, '{"token":"abc"}');
    fs.mkdirSync(path.join(dir, '.dashboard', 'teamchats'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.dashboard', 'project.json'), JSON.stringify({ format: 1, app: 'my-dashboard', project: {}, agents: [], teams: [] }));
    fs.symlinkSync(secret, path.join(dir, '.dashboard', 'teamchats', 'stolen.json'));
    const p = await createProject({ name: 'Crafted', mode: 'existing', folder: dir });
    sync.restoreInto(p.id, dir);
    expect(fs.existsSync(dataPath('projects', p.id, 'teamchats', 'stolen.json'))).toBe(false);
  });
});
