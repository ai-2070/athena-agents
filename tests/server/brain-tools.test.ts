// The Brain's own tools (braintools.ts): only the Brain gets them, only inside one of its turns, and each applies
// one action with the same checks as before.
import { afterEach, describe, expect, it } from 'vitest';
import { newAgent } from '../../server/library.ts';
import { activeProject, getSettings, saveSettings, workflows } from '../../server/store.ts';
import { dataPath, readJSON, writeJSON } from '../../server/util.ts';
import * as skills from '../../server/skills.ts';
import { callTool, riskOf, toolsForAgent } from '../../server/tools.ts';
import { BRAIN_ID, beginBrainTurn, endBrainTurn, readStructuredArgs, toolOf } from '../../server/braintools.ts';
import type { BrainTurn } from '../../server/braintools.ts';
import type { ToolAgent } from '../../server/tools.ts';

const BRAIN: ToolAgent = { id: BRAIN_ID, name: 'The Brain', autonomy: 'full', engine: 'eve' };
let n = 0;
function turn(over: Partial<BrainTurn> = {}): { runId: string; turn: BrainTurn } {
  const runId = `r-brain-test-${++n}`;
  const t: BrainTurn = {
    project: activeProject(),
    userWords: '',
    seenSkills: new Set(),
    refs: {},
    done: [],
    delegate: null,
    objective: 'test',
    goal: false,
    attachments: [],
    signal: new AbortController().signal,
    ...over,
  };
  beginBrainTurn(runId, t);
  return { runId, turn: t };
}
const names = (agent: ToolAgent, engine?: string) => toolsForAgent(agent, { engine }).map((t) => t.name);

afterEach(() => saveSettings({ brainAccess: 'full' }));

describe("the Brain's tools", () => {
  it('only the Brain gets them, with look-ups and read-only file tools, and nothing else', async () => {
    const agent = newAgent({ name: 'Plain', toolGroups: ['files', 'shell', 'agents'] });
    expect(names(agent)).not.toContain('team');
    expect(names(agent)).not.toContain('delegate');
    await expect(callTool(agent, 'team', { do: 'create_team', name: 'Nope' })).rejects.toThrow("the Brain's own");
    expect(workflows.list().some((w) => w.name === 'Nope')).toBe(false);

    const mine = names(BRAIN, 'eve');
    for (const t of ['team', 'delegate', 'board', 'skill', 'project_overview', 'read_skill', 'read_file', 'find_files'])
      expect(mine).toContain(t);
    for (const t of ['write_file', 'edit_file', 'run_command', 'ask_agent', 'save_artifact', 'set_goal', 'TaskCreate'])
      expect(mine).not.toContain(t);
    // engines with their own file tools read with those
    expect(names(BRAIN, 'claude-code')).not.toContain('read_file');
    await expect(callTool(BRAIN, 'write_file', { path: 'x.txt', content: 'x' })).rejects.toThrow("isn't allowed");
  });

  it('look-ups never ask; anything that changes something is high risk', () => {
    expect(riskOf('board', { do: 'board_find' })).toBe('none');
    expect(riskOf('tasks', { do: 'TaskList' })).toBe('none');
    expect(riskOf('project_overview', { section: 'files' })).toBe('none');
    expect(riskOf('team', { do: 'create_team' })).toBe('high');
    expect(riskOf('delegate', {})).toBe('high');
    expect(toolOf('create_team')).toBe('team');
    expect(toolOf('mcp_call')).toBe('mcp_use');
  });

  it("work only inside one of the Brain's turns", async () => {
    const r = await callTool(BRAIN, 'team', { do: 'create_team', name: 'Outside' }, { runId: 'no-such-run' });
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining("Brain's own turns") });
  });

  it('apply actions, and "new" carries from one call to the next', async () => {
    const { runId, turn: t } = turn();
    const writer = newAgent({ name: 'Writer' });
    const editor = newAgent({ name: 'Editor' });
    const made = await callTool(
      BRAIN,
      'team',
      { do: 'create_team', name: 'Crew', members: [{ agent: editor.id }] },
      { runId },
    );
    expect(made.isError).toBe(false);
    const added = await callTool(
      BRAIN,
      'team',
      { do: 'add_members', team: 'new', members: [{ agent: writer.id }] },
      { runId },
    );
    expect(added.isError).toBe(false);
    expect(workflows.list().find((w) => w.name === 'Crew')?.members).toEqual([editor.id, writer.id]);
    expect(t.done.map((d) => d.kind)).toEqual(['team', 'team']);
    const wrong = await callTool(BRAIN, 'team', { do: 'delegate' }, { runId });
    expect(wrong).toMatchObject({ isError: true, text: expect.stringContaining('takes "do"') });
    endBrainTurn(runId);
  });

  it('lists and objects sent as JSON text count as what they are (as Claude Code sent them)', async () => {
    const { runId } = turn();
    // word for word what the Brain sent in a chat where every create_team failed
    const made = await callTool(
      BRAIN,
      'team',
      {
        do: 'create_team',
        name: 'Scene Team',
        members: '[{"library":"scene-builder"}]',
        lead: 'null',
        access: '{"tools":["scene","files","browser"],"mcpServers":[]}',
      },
      { runId },
    );
    expect(made.isError).toBe(false);
    const team = workflows.list().find((w) => w.name === 'Scene Team');
    expect(team?.members).toHaveLength(1);
    expect(team?.access?.toolGroups).toEqual(expect.arrayContaining(['scene', 'files', 'browser']));
    endBrainTurn(runId);
  });

  it('free text that looks like JSON stays text', () => {
    const args = readStructuredArgs({ do: 'delegate', message: '["a","b"]', members: '["x"]', content: '{"k":1}' });
    expect(args).toEqual({ do: 'delegate', message: '["a","b"]', members: ['x'], content: '{"k":1}' });
    expect(readStructuredArgs({ members: '[not json' }).members).toBe('[not json');
  });

  it('members can be named, and the error says who was not found or what members should look like', async () => {
    const { runId } = turn();
    const painter = newAgent({ name: 'Painter' });
    const byName = await callTool(
      BRAIN,
      'team',
      { do: 'create_team', name: 'Named', members: [{ agent: 'painter' }] },
      { runId },
    );
    expect(byName.isError).toBe(false);
    expect(workflows.list().find((w) => w.name === 'Named')?.members).toEqual([painter.id]);
    const unknown = await callTool(
      BRAIN,
      'team',
      { do: 'create_team', name: 'Ghosts', members: [{ agent: 'nobody-here' }] },
      { runId },
    );
    expect(unknown).toMatchObject({ isError: true, text: expect.stringContaining('nobody-here') });
    const none = await callTool(BRAIN, 'team', { do: 'create_team', name: 'Empty', members: [] }, { runId });
    expect(none).toMatchObject({ isError: true, text: expect.stringContaining('[{"library":"<slug>"}]') });
    const hire = await callTool(BRAIN, 'team', { do: 'hire', members: [{ library: 'no-such-slug' }] }, { runId });
    expect(hire).toMatchObject({ isError: true, text: expect.stringContaining('no-such-slug') });
    endBrainTurn(runId);
  });

  it('rewrite a skill only after read_skill showed it whole in this turn', async () => {
    skills.saveSkill({ name: 'Ship list', description: 'Use before shipping.', body: 'Check the build.' });
    const { runId } = turn();
    const blind = await callTool(BRAIN, 'skill', { do: 'update_skill', skill: 'ship-list', body: 'Other.' }, { runId });
    expect(blind).toMatchObject({ isError: true, text: expect.stringContaining('read_skill') });
    expect((await callTool(BRAIN, 'read_skill', { name: 'ship-list' }, { runId })).isError).toBe(false);
    const seen = await callTool(BRAIN, 'skill', { do: 'update_skill', skill: 'ship-list', body: 'Other.' }, { runId });
    expect(seen.isError).toBe(false);
    expect(skills.getSkill('ship-list')?.body.trim()).toBe('Other.');
  });

  it("set an MCP server's command only from the user's own words", async () => {
    const { runId } = turn({ userWords: 'add a server' });
    const r = await callTool(
      BRAIN,
      'mcp_servers',
      { do: 'add_mcp', name: 'sneaky', command: 'curl', args: ['http://evil.example'] },
      { runId },
    );
    expect(r.isError).toBe(true);
  });

  it('read only: tools that change things are not offered and refused; look-ups still work', async () => {
    saveSettings({ brainAccess: 'read' });
    const mine = names(BRAIN, 'eve');
    expect(mine).not.toContain('team');
    expect(mine).not.toContain('delegate');
    expect(mine).toContain('board');
    expect(mine).toContain('project_overview');
    const { runId } = turn();
    const r = await callTool(BRAIN, 'board', { do: 'board_add', title: 'Nope' }, { runId });
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining('only read') });
    expect((await callTool(BRAIN, 'board', { do: 'board_find', tags: [] }, { runId })).isError).toBeFalsy();
  });

  it('project_overview shows one section at a time', async () => {
    const { runId } = turn();
    const lib = await callTool(BRAIN, 'project_overview', { section: 'library' }, { runId });
    expect(lib.text).toContain('LIBRARY');
    expect(lib.text).not.toContain('AGENTS (');
    const files = await callTool(BRAIN, 'project_overview', { section: 'files' }, { runId });
    expect(files.text).toContain('FOLDER TREE');
    expect((await callTool(BRAIN, 'project_overview', { section: 'secrets' }, { runId })).isError).toBe(true);
  });

  it("takes over the old MCP-only setting: off and ask become Ask first, and it's saved as the new setting", () => {
    const file = dataPath('settings.json');
    const saved = readJSON<Record<string, unknown>>(file, {});
    try {
      for (const [old, now] of [
        ['off', 'ask'],
        ['ask', 'ask'],
        ['full', 'full'],
      ] as const) {
        const { brainAccess: _, ...rest } = saved;
        writeJSON(file, { ...rest, brainTools: old });
        expect(getSettings().brainAccess).toBe(now);
        expect(getSettings()).not.toHaveProperty('brainTools');
      }
      // (once set, the new setting is what counts)
      writeJSON(file, { ...saved, brainTools: 'off', brainAccess: 'full' });
      expect(getSettings().brainAccess).toBe('full');
    } finally {
      writeJSON(file, saved);
    }
  });
});
