import { describe, expect, it } from 'vitest';
import {
  activeProject,
  agents,
  bus,
  chats,
  emit,
  getSettings,
  listProjects,
  rememberAlwaysAllow,
  saveSettings,
  secretStatus,
  setActiveProject,
  setSecret,
  withProject,
  workflows,
} from '../../server/store.ts';
import { dataPath, readJSON, writeJSON } from '../../server/util.ts';
import type { Agent } from '../../shared/types.ts';

describe('settings and secrets', () => {
  it('has defaults and merges nested changes', () => {
    const s = getSettings();
    expect(s.defaults.engine).toBe('claude-code');
    expect(s.look.scale).toBe(100);
    saveSettings({ look: { scale: 125 } });
    const after = getSettings();
    expect(after.look.scale).toBe(125);
    // the rest of the nested object is kept
    expect(after.look.accent).toBe('aegean');
    expect(after.defaults.engine).toBe('claude-code');
    expect(after.defaults.veniceModel).toBe('');
    saveSettings({ defaults: { veniceModel: 'venice-model' } });
    expect(getSettings().defaults).toMatchObject({
      veniceModel: 'venice-model',
      openrouterModel: s.defaults.openrouterModel,
    });
  });

  it('an older "station" holding the voxel look moves to stationLook; the map quality starts at Balanced', () => {
    // (a settings file from before: no stationLook yet)
    const file = dataPath('settings.json');
    writeJSON(file, {
      ...readJSON<object>(file, {}),
      look: { scale: 100, accent: 'lime', motion: 'full', station: 'world' },
    });
    expect(getSettings().look).toMatchObject({ station: 'balanced', stationLook: 'world' });
    saveSettings({ look: { station: 'saver', stationLook: 'classic' } });
    expect(getSettings().look).toMatchObject({ station: 'saver', stationLook: 'classic' });
  });

  it('never hands out a secret, only whether it is set and its last 4 characters', () => {
    setSecret('openrouterKey', 'sk-or-v1-abcdefgh12345678');
    const st = secretStatus();
    expect(st.openrouterKey.set).toBe(true);
    expect(st.openrouterKey.hint).toBe('…5678');
    expect(JSON.stringify(st)).not.toContain('abcdefgh');
    expect(st.anthropicKey.set).toBe(false);
  });
});

describe('projects', () => {
  it('starts with one default project, which is active', () => {
    const list = listProjects();
    expect(list.length).toBe(1);
    expect(activeProject().id).toBe(list[0].id);
  });

  it('refuses to switch to a project that does not exist', () => {
    expect(() => setActiveProject('nope')).toThrow();
  });
});

describe('collections', () => {
  it('saves, lists, gets and removes items, stamping dates', () => {
    const a = agents.save({ id: 'tester-1', name: 'Tester' } as Partial<Agent>);
    expect(a.createdAt).toBeTypeOf('number');
    expect(agents.get('tester-1')?.name).toBe('Tester');
    expect(agents.list().map((x) => x.id)).toContain('tester-1');
    agents.remove('tester-1');
    expect(agents.get('tester-1')).toBeNull();
  });

  it('Always allow adds to what the agent has, once each, and skips an agent that is gone', () => {
    agents.save({ id: 'tester-2', name: 'Tester', alwaysAllow: ['Bash'] } as Partial<Agent>);
    rememberAlwaysAllow('tester-2', ['Bash', 'opencode:read:.env']);
    expect(agents.get('tester-2')?.alwaysAllow).toEqual(['Bash', 'opencode:read:.env']);
    agents.remove('tester-2');
    rememberAlwaysAllow('tester-2', ['Bash']);
    expect(agents.get('tester-2')).toBeNull();
  });

  it('rejects ids that could escape the folder', () => {
    expect(workflows.get('../settings')).toBeNull();
    expect(workflows.get('a/b')).toBeNull();
  });
});

describe('chats', () => {
  it('creates, saves and lists an agent chat', () => {
    const c = chats.create('agent-x', 'Hello');
    c.items.push({ type: 'user', text: 'hi' });
    chats.save(c);
    expect(chats.get('agent-x', c.id)?.items).toHaveLength(1);
    expect(chats.list('agent-x')[0]).toMatchObject({ id: c.id, title: 'Hello', count: 1 });
  });

  it('marks a team session with its team, and the mark survives a rename', () => {
    const c = chats.create('agent-y', 'Team: Social', 'team-1');
    c.title = 'Renamed';
    chats.save(c);
    expect(chats.list('agent-y')[0]).toMatchObject({ id: c.id, title: 'Renamed', teamId: 'team-1' });
    expect(chats.list('agent-x').every((x) => x.teamId === null)).toBe(true);
  });

  it('rejects unsafe agent ids', () => {
    expect(() => chats.list('../../etc')).toThrow();
  });
});

describe('events', () => {
  it("say which project a chat's event is from (a copied project has the same ids), and leave the rest alone", () => {
    const seen: Record<string, unknown>[] = [];
    const listen = (ev: Record<string, unknown>) => seen.push(ev);
    bus.on('event', listen);
    try {
      const p = { ...activeProject(), id: 'elsewhere' };
      withProject(p, () => emit('run', { chatId: 'c1' }));
      // (a workflow's progress too: a copied project's workflow has the same id)
      withProject(p, () => emit('workflow-run', { id: 'w1' }));
      emit('queue', { chatId: 'c1', projectId: 'given' });
      emit('settings');
    } finally {
      bus.off('event', listen);
    }
    expect(seen.map((e) => [e.type, e.projectId])).toEqual([
      ['run', 'elsewhere'],
      ['workflow-run', 'elsewhere'],
      ['queue', 'given'],
      ['settings', undefined],
    ]);
  });
});

describe('removing the open project', () => {
  it('says another project is open now', async () => {
    const { createProject, removeProject } = await import('../../server/projects.ts');
    const keep = await createProject({ name: 'Stays here', mode: 'new' });
    const gone = await createProject({ name: 'Goes away', mode: 'new' });
    expect(activeProject().id).toBe(gone.id);
    const seen: Record<string, unknown>[] = [];
    const listen = (ev: Record<string, unknown>) => ev.type === 'project' && seen.push(ev);
    bus.on('event', listen);
    try {
      removeProject(gone.id);
    } finally {
      bus.off('event', listen);
    }
    expect(seen).toHaveLength(1);
    expect(activeProject().id).not.toBe(gone.id);
    expect(seen[0]!.id).toBe(activeProject().id);
    expect(keep.id).toBeTruthy();
  });
});
