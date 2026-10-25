// The Brain's actions: parsing its ```actions block and carrying them out (teams, members, PROJECT.md, delegate).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyActions, parseActions } from '../../server/overseer.ts';
import { agents, workflows, activeProject } from '../../server/store.ts';
import { newAgent } from '../../server/library.ts';
import { ensureBrain } from '../../server/projects.ts';

describe('parseActions()', () => {
  it('splits the reply from the actions block', () => {
    const r = parseActions('Building it now.\n```actions\n[{"do":"create_team","name":"Crew"}]\n```');
    expect(r.answer).toBe('Building it now.');
    expect(r.actions).toEqual([{ do: 'create_team', name: 'Crew' }]);
  });

  it('accepts a single action object and tolerates text around the JSON', () => {
    expect(parseActions('ok\n```actions\n{"do":"hire","members":[]}\n```').actions).toEqual([{ do: 'hire', members: [] }]);
    expect(parseActions('```actions\nhere: [{"do":"hire"}] done\n```').actions).toEqual([{ do: 'hire' }]);
  });

  it('a plain answer has no actions; broken JSON gives none instead of failing', () => {
    expect(parseActions('Nobody is working right now.')).toEqual({ answer: 'Nobody is working right now.', actions: [] });
    expect(parseActions('x\n```actions\n[{oops\n```').actions).toEqual([]);
  });
});

describe('applyActions()', () => {
  it('builds a team from existing and new agents, with a lead', () => {
    const writer = newAgent({ name: 'Writer' });
    const before = agents.list().length;
    const r = applyActions([
      { do: 'create_team', name: 'Social', description: 'Posts', members: [{ agent: writer.id }, { new: { name: 'Designer', emoji: '🎨', specialty: 'images', instructions: 'Make images.' } }], lead: { agent: writer.id } },
    ]);
    expect(agents.list().length).toBe(before + 1);
    const team = workflows.list().find((w) => w.name === 'Social')!;
    expect(team.members).toHaveLength(2);
    expect(team.lead).toBe(writer.id);
    expect(r.done.map((d) => d.kind)).toEqual(['hired', 'team']);
  });

  it('adds and removes members, and updates the goal and lead', () => {
    const a = newAgent({ name: 'A' });
    const b = newAgent({ name: 'B' });
    applyActions([{ do: 'create_team', name: 'Pair', members: [{ agent: a.id }] }]);
    const team = workflows.list().find((w) => w.name === 'Pair')!;
    applyActions([{ do: 'add_members', team: team.id, members: [{ agent: b.id }] }]);
    expect(workflows.get(team.id)!.members).toEqual([a.id, b.id]);
    applyActions([{ do: 'update_team', team: team.id, description: 'New goal', lead: b.id }]);
    expect(workflows.get(team.id)).toMatchObject({ description: 'New goal', lead: b.id });
    applyActions([{ do: 'remove_members', team: team.id, agents: [b.id] }]);
    expect(workflows.get(team.id)).toMatchObject({ members: [a.id], lead: null });
    // removing someone from a team never deletes the agent
    expect(agents.get(b.id)).not.toBeNull();
  });

  it('can delegate to the team it just built ("new")', () => {
    const a = newAgent({ name: 'Solo' });
    const r = applyActions([
      { do: 'create_team', name: 'Fresh', members: [{ agent: a.id }] },
      { do: 'delegate', to: 'team', id: 'new', message: 'Start on the launch posts.' },
    ]);
    expect(r.delegate).toMatchObject({ kind: 'branch', name: 'Fresh', message: 'Start on the launch posts.' });
  });

  it('reports unknown teams and agents instead of throwing', () => {
    const r = applyActions([
      { do: 'add_members', team: 'missing', members: [] },
      { do: 'delegate', to: 'agent', id: 'nobody', message: 'x' },
    ]);
    expect(r.delegate).toBeNull();
    expect(r.done.every((d) => d.kind === 'error')).toBe(true);
  });

  it('writes PROJECT.md and keeps the old version', () => {
    const dir = ensureBrain(activeProject());
    applyActions([{ do: 'write_project_md', content: '# Project\n\nFirst version of the brief.' }]);
    applyActions([{ do: 'write_project_md', content: '# Project\n\nSecond version of the brief.' }]);
    expect(fs.readFileSync(path.join(dir, 'PROJECT.md'), 'utf8')).toContain('Second version');
    const hist = fs.readdirSync(path.join(dir, '.brain-history'));
    expect(hist.length).toBe(1);
    expect(fs.readFileSync(path.join(dir, '.brain-history', hist[0]), 'utf8')).toContain('First version');
  });

  it('ignores a PROJECT.md that is (almost) empty', () => {
    const r = applyActions([{ do: 'write_project_md', content: 'hi' }]);
    expect(r.done[0].kind).toBe('error');
  });
});
