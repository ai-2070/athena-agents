import { describe, expect, it } from 'vitest';
import { agents, workflows } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import * as presets from '../../server/presets.ts';
import type { Team } from '../../shared/types.ts';

function crew() {
  const lead = newAgent({ name: 'Planner', emoji: '🧭', skills: ['plan'] });
  const maker = newAgent({ name: 'Maker', emoji: '🎨' });
  const team = workflows.save({ name: 'Crew', description: 'Make things', members: [lead.id, maker.id], lead: lead.id, skills: ['handoff'], steps: [] } as Partial<Team>);
  return { lead, maker, team };
}

describe('cloning', () => {
  it('clones a team with the same members', () => {
    const { lead, maker, team } = crew();
    const copy = presets.cloneTeam(team.id);
    expect(copy.id).not.toBe(team.id);
    expect(copy.name).toBe('Crew (copy)');
    expect(copy.members).toEqual([lead.id, maker.id]);
    expect(copy.lead).toBe(lead.id);
    expect(copy.skills).toEqual(['handoff']);
  });

  it('clones a team with copies of its agents, keeping who leads', () => {
    const { lead, maker, team } = crew();
    const before = agents.list().length;
    const copy = presets.cloneTeam(team.id, { withAgents: true });
    expect(agents.list().length).toBe(before + 2);
    expect(copy.members).not.toContain(lead.id);
    expect(copy.members).not.toContain(maker.id);
    const newLead = agents.get(copy.lead!);
    expect(newLead?.name).toBe('Planner (copy)');
    expect(newLead?.skills).toEqual(['plan']);
  });
});

describe('presets', () => {
  it('saves an agent and makes a fresh one from it', () => {
    const a = newAgent({ name: 'Writer', specialty: 'writes posts', skills: ['voice'] });
    const p = presets.saveAgentPreset(a.id);
    const listed = presets.listPresets().find((x) => x.id === p.id);
    expect(listed).toMatchObject({ kind: 'agent', name: 'Writer', skills: ['voice'] });
    const made = presets.usePreset(p.id);
    if (!('agent' in made)) throw new Error('expected an agent');
    expect(made.agent.id).not.toBe(a.id);
    expect(made.agent.specialty).toBe('writes posts');
    expect(made.agent.skills).toEqual(['voice']);
    expect(made.agent.source.type).toBe('preset');
  });

  it('saves a whole team and recreates it with new agents and the same lead', () => {
    const { team } = crew();
    const p = presets.saveTeamPreset(team.id);
    const listed = presets.listPresets().find((x) => x.id === p.id);
    expect(listed?.members?.map((m) => m.name)).toEqual(['Planner', 'Maker']);
    expect(listed?.lead).toBe('Planner');
    const made = presets.usePreset(p.id);
    if (!('team' in made)) throw new Error('expected a team');
    expect(made.agents).toHaveLength(2);
    expect(made.team.members).toEqual(made.agents.map((x) => x.id));
    expect(agents.get(made.team.lead!)?.name).toBe('Planner');
  });

  it('deletes presets, and rejects ids that are not presets', () => {
    const a = newAgent({ name: 'Gone' });
    const p = presets.saveAgentPreset(a.id);
    presets.deletePreset(p.id);
    expect(presets.listPresets().some((x) => x.id === p.id)).toBe(false);
    expect(() => presets.deletePreset('../settings')).toThrow();
  });
});
