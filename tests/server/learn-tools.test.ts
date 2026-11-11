// What agents learn with: read_skill with a name that is no skill searches the whole library, save_skill saves a skill
// with its files (and keeps the old version, files included, in History). /learn and the learn skill rely on both.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as skills from '../../server/skills.ts';
import { callTool } from '../../server/tools.ts';
import { newAgent } from '../../server/library.ts';
import { agents } from '../../server/store.ts';
import { listVersions } from '../../server/versions.ts';

// (autonomy "auto": save_skill is low risk, so it asks only an agent set to ask)
const learner = () =>
  newAgent({ name: `Learner ${Math.random().toString(36).slice(2, 7)}`, autonomy: 'auto', toolGroups: [] });

describe('read_skill with a name that is no skill', () => {
  it('lists the library skills that match its words, so an agent finds ones it was not given', async () => {
    skills.saveSkill({
      name: 'Postgres replication',
      description: 'Use when setting up streaming replication or a failover.',
      body: 'Steps.',
    });
    const r = await callTool(learner(), 'read_skill', { name: 'replication failover' });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain(
      'There is no skill called "replication failover". Skills in the library that match its words (open one with read_skill and its id):',
    );
    expect(r.text).toContain('- postgres-replication: Postgres replication.');
    const none = await callTool(learner(), 'read_skill', { name: 'zzz-nothing-like-it' });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('No skill in the library matches its words either.');
    // a name too short to search lists nothing rather than every skill
    expect((await callTool(learner(), 'read_skill', { name: 'zz' })).text).not.toContain('- postgres-replication');
    // nor do words nearly every description has ("Use when…")
    const common = await callTool(learner(), 'read_skill', { name: 'use-the-skill when' });
    expect(common.isError).toBe(true);
    expect(common.text).not.toContain('- postgres-replication');
    // a wrong word among them doesn't hide the right one; ids with underscores are read as words
    expect((await callTool(learner(), 'read_skill', { name: 'use postgres_failover' })).text).toContain(
      '- postgres-replication',
    );
  });
});

describe('save_skill', () => {
  it('saves a new skill with its reference files, and gives it to the agent that learned it', async () => {
    const a = learner();
    const r = await callTool(a, 'save_skill', {
      name: 'Designing data systems',
      description: 'Use when choosing how to store, replicate or partition data.',
      body: '## Open these when\n- references/ch05-replication.md: copies of data on several machines',
      files: [{ path: 'references/ch05-replication.md', text: '# Replication\n- leaders and followers (ch. 5)' }],
    });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Saved the skill "Designing data systems" (id: designing-data-systems) with 1 file.');
    const s = skills.getSkill('designing-data-systems')!;
    expect(s.files.map((f) => f.path)).toEqual(['references/ch05-replication.md']);
    expect(agents.get(a.id)?.skills).toContain('designing-data-systems');
    // a second skill under a name that's taken is refused: update the first
    const again = await callTool(a, 'save_skill', {
      name: 'Designing data systems',
      description: 'x',
      body: 'y',
    }).catch((e: unknown) => ({ text: String(e), isError: true }));
    expect(again.text).toMatch(/exists already: update it/);
  });

  it('updates a skill as one change: the old text and files stay in History, and bringing it back brings them back', async () => {
    const a = learner();
    await callTool(a, 'save_skill', {
      name: 'Release checklist',
      description: 'Use before each release.',
      body: 'Old steps.',
      files: [{ path: 'references/old.md', text: 'old notes' }],
    });
    await callTool(a, 'save_skill', {
      skill: 'release-checklist',
      name: 'Release checklist',
      description: 'Use before each release.',
      body: 'New steps.',
      files: [{ path: 'references/new.md', text: 'new notes' }],
      remove: ['references/old.md'],
    });
    const now = skills.getSkill('release-checklist')!;
    expect(now.body).toContain('New steps.');
    expect(now.files.map((f) => f.path)).toEqual(['references/new.md']);
    const kept = listVersions<skills.SkillVersionItem>(skills.skillVersionsDir('release-checklist'));
    const before = kept.find((v) => v.item.body.includes('Old steps.'))!;
    expect(kept.filter((v) => v.item.body.includes('Old steps.'))).toHaveLength(1);
    expect(before.item.files).toEqual(['references/old.md']);
    skills.restoreSkill(before.item, before.id);
    expect(skills.getSkill('release-checklist')?.files.map((f) => f.path)).toEqual(['references/old.md']);
    // an update isn't given again to the agent: it was given when it was made
    expect(agents.get(a.id)?.skills.filter((x) => x === 'release-checklist')).toHaveLength(1);
  });

  it('keeps files to references/, scripts/ and templates/, with plain names and a size limit', async () => {
    const a = learner();
    const tryFile = (p: string, text = 'x') =>
      callTool(a, 'save_skill', {
        name: `Paths ${p}`,
        description: 'Use for a test.',
        body: 'b',
        files: [{ path: p, text }],
      }).catch((e: unknown) => ({ text: String(e), isError: true }));
    for (const bad of [
      '../escape.md',
      'references/../../escape.md',
      'SKILL.md',
      'notes.md',
      '/etc/passwd',
      'references/.hidden',
      'C:\\temp\\x.md',
    ]) {
      expect((await tryFile(bad)).text, bad).toMatch(/can't be one of a skill's files/);
    }
    expect((await tryFile('references/big.md', 'x'.repeat(skills.SKILL_FILE_MAX + 1))).text).toMatch(/too big/);
    expect(fs.existsSync(path.join(path.dirname(skills.skillDir('release-checklist')), '..', 'escape.md'))).toBe(false);
    const ok = await tryFile('scripts/tool.py', 'print(1)\n');
    expect(ok.isError).toBeFalsy();
  });

  it('refuses an update to a skill that does not exist', async () => {
    const r = await callTool(learner(), 'save_skill', {
      skill: 'no-such-skill',
      name: 'X',
      description: 'Use never.',
      body: 'b',
    }).catch((e: unknown) => ({ text: String(e), isError: true }));
    expect(r.text).toMatch(/There is no skill "no-such-skill"/);
  });
});
