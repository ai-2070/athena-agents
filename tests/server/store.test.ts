import { describe, expect, it } from 'vitest';
import { activeProject, agents, chats, getSettings, listProjects, saveSettings, secretStatus, setActiveProject, setSecret, workflows } from '../../server/store.ts';
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
    expect(after.look.accent).toBe('lime');
    expect(after.defaults.engine).toBe('claude-code');
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

  it('rejects unsafe agent ids', () => {
    expect(() => chats.list('../../etc')).toThrow();
  });
});
