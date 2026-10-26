import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agents, chats, workflows, setActiveProject, setSecret, bus } from '../../server/store.ts';
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

  it("brings an agent's chats back too, with the engine's memory of them", async () => {
    const dir = folder('chats-trip');
    const p = await createProject({ name: 'Chats trip', mode: 'new', folder: dir });
    const a = newAgent({ name: 'Talker' });
    const c = chats.create(a.id, 'Planning');
    c.items.push({ type: 'user', text: 'distinctive-user-message', ts: Date.now() });
    c.sessionId = 'session-123';
    c.llm = [{ role: 'user', content: 'distinctive-user-message' }];
    chats.save(c);
    sync.saveProject(p.id);
    expect(fs.existsSync(path.join(dir, '.dashboard', 'chats', a.id, `${c.id}.json`))).toBe(true);
    const other = await createProject({ name: 'Somewhere', mode: 'new', folder: folder('somewhere') });
    setActiveProject(other.id);
    removeProject(p.id);
    const again = await createProject({ name: 'Chats trip again', mode: 'existing', folder: dir });
    expect(sync.restoreInto(again.id, dir)).toMatchObject({ agents: 1, chats: 1 });
    setActiveProject(again.id);
    expect(chats.list(a.id).map((x) => x.title)).toEqual(['Planning']);
    const back = chats.get(a.id, c.id)!;
    expect(back.items.map((i) => (i.type === 'user' ? i.text : i.type))).toEqual(['distinctive-user-message']);
    expect(back).toMatchObject({ id: c.id, agentId: a.id, sessionId: 'session-123', llm: [{ role: 'user', content: 'distinctive-user-message' }] });
  });

  it('drops agent chats that were deleted in the dashboard', async () => {
    const p = await createProject({ name: 'Chat prune', mode: 'new', folder: folder('chat-prune') });
    const a = newAgent({ name: 'Pruner' });
    const keep = chats.create(a.id, 'Keep');
    const gone = chats.create(a.id, 'Gone');
    sync.saveProject(p.id);
    chats.remove(a.id, gone.id);
    sync.saveProject(p.id);
    expect(fs.readdirSync(path.join(p.brainPath, '.dashboard', 'chats', a.id))).toEqual([`${keep.id}.json`]);
  });

  it('a chat change is announced with its project, so the auto-save saves the right one', async () => {
    const p = await createProject({ name: 'Announce', mode: 'new', folder: folder('announce') });
    const a = newAgent({ name: 'Announcer' });
    const seen: unknown[] = [];
    const on = (ev: { type: string; project?: unknown }) => ev.type === 'chats' && seen.push(ev.project);
    bus.on('event', on);
    try {
      chats.create(a.id, 'Hello');
    } finally {
      bus.off('event', on);
    }
    expect(seen).toEqual([p.id]);
  });

  it("doesn't restore chats through links, or chats of agents it didn't restore", async () => {
    const dir = folder('crafted-chats');
    const d = path.join(dir, '.dashboard');
    fs.mkdirSync(path.join(d, 'chats', 'agent-1'), { recursive: true });
    fs.mkdirSync(path.join(d, 'chats', 'stranger'), { recursive: true });
    fs.writeFileSync(path.join(d, 'project.json'), JSON.stringify({ format: 1, app: 'my-dashboard', project: {}, agents: [{ id: 'agent-1', name: 'One' }], teams: [] }));
    const chat = (id: string, agentId: string) => JSON.stringify({ id, agentId, title: 't', items: [], llm: [], sessionId: null, createdAt: 1, updatedAt: 1 });
    // claims another agent and id: it's put back where it was saved
    fs.writeFileSync(path.join(d, 'chats', 'agent-1', 'c-ok.json'), chat('c-other', 'someone-else'));
    fs.writeFileSync(path.join(d, 'chats', 'stranger', 'c-x.json'), chat('c-x', 'stranger'));
    fs.writeFileSync(path.join(d, 'chats', 'agent-1', 'not-a-chat.json'), '{"hello":1}');
    if (linksWork) {
      const secret = path.join(os.homedir(), 'chat-secret.json');
      fs.writeFileSync(secret, chat('c-secret', 'agent-1'));
      fs.symlinkSync(secret, path.join(d, 'chats', 'agent-1', 'c-secret.json'));
    }
    const p = await createProject({ name: 'Crafted chats', mode: 'existing', folder: dir });
    expect(sync.restoreInto(p.id, dir)).toMatchObject({ chats: 1 });
    expect(fs.readdirSync(dataPath('projects', p.id, 'chats'))).toEqual(['agent-1']);
    expect(fs.readdirSync(dataPath('projects', p.id, 'chats', 'agent-1'))).toEqual(['c-ok.json']);
    expect(JSON.parse(fs.readFileSync(dataPath('projects', p.id, 'chats', 'agent-1', 'c-ok.json'), 'utf8'))).toMatchObject({ id: 'c-ok', agentId: 'agent-1' });
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
