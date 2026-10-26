// Skill folders that come with the dashboard (skills/ in the repo), and reading long skill files.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as skills from '../../server/skills.ts';
import { parseGitHubUrl } from '../../server/skillinstall.ts';
import { callTool } from '../../server/tools.ts';
import { dataPath } from '../../server/util.ts';

const agent = { id: 'a1', name: 'Tester' };

describe('bundled skills', () => {
  it('include the storytold, OOMOL and Composio skills', () => {
    const slugs = skills.bundledSkills().map((b) => b.slug);
    expect(slugs).toEqual(expect.arrayContaining(['storytold', 'storytold-install', 'vectorcraft', 'photocraft', 'figcraft', 'oo', 'oo-find-skills', 'oo-create-skill', 'oo-publish-skill', 'composio']));
    expect(slugs).toHaveLength(20);
    // the library holds one skill per id, so no two bundles may share one
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('remember their real folder in the repo, so Download again updates them', () => {
    for (const b of skills.bundledSkills()) {
      // what installing from that link works out (skillinstall.ts): the same repo, branch and folder
      const link = parseGitHubUrl(b.origin.url);
      expect(`${link.owner}/${link.repo}`).toBe(b.origin.repo);
      expect(link.rest[0]).toBe(b.origin.ref);
      expect(link.rest.slice(1).join('/')).toBe(b.origin.path);
    }
    const origin = Object.fromEntries(skills.bundledSkills().map((b) => [b.slug, b.origin]));
    expect(origin.oo).toMatchObject({ repo: 'oomol-lab/oo-cli', path: 'contrib/skills/shared/oo' });
    expect(origin.composio).toMatchObject({ repo: 'ComposioHQ/skills', path: 'skills/composio' });
  });

  it("are added once, keep where they came from, and don't replace a skill of yours", () => {
    // a skill of yours with the same id as a bundled one
    const mine = dataPath('skills', 'cadcraft');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'SKILL.md'), '---\nname: My CAD notes\ndescription: Mine.\n---\nmine');

    skills.ensureBuiltinSkills();
    const v = skills.getSkill('vectorcraft');
    expect(v?.name).toBe('vectorcraft');
    expect(v?.files.map((f) => f.path)).toContain('references/commands.md');
    expect(v?.origin).toMatchObject({ repo: 'hermes-pro/storytold-skills', path: 'vectorcraft', url: 'https://github.com/hermes-pro/storytold-skills/tree/main/vectorcraft' });
    expect(skills.getSkill('storytold-install')?.files.map((f) => f.path)).toContain('scripts/storytold_tools.py');
    expect(skills.getSkill('oo')?.files.map((f) => f.path)).toContain('references/connector-execution.md');
    expect(skills.getSkill('composio')?.files.map((f) => f.path)).toContain('rules/composio-cli.md');
    expect(skills.getSkill('composio')?.origin).toMatchObject({ repo: 'ComposioHQ/skills', path: 'skills/composio', url: 'https://github.com/ComposioHQ/skills/tree/main/skills/composio' });
    expect(skills.getSkill('cadcraft')?.name).toBe('My CAD notes');
    // nothing half-copied left behind
    expect(fs.readdirSync(dataPath('tmp')).filter((x) => x.startsWith('bundled-'))).toEqual([]);
  });

  it('stay deleted once deleted', () => {
    skills.ensureBuiltinSkills();
    skills.deleteSkillEverywhere('photocraft');
    skills.ensureBuiltinSkills();
    expect(skills.getSkill('photocraft')).toBeNull();
  });
});

describe('read_skill on long files', () => {
  it('searches a file, or all of a skill\'s files, like grep', async () => {
    skills.ensureBuiltinSkills();
    const one = await callTool(agent, 'read_skill', { name: 'figcraft', file: 'references/node-properties.md', find: 'sizingH' });
    expect(one.text).toMatch(/references\/node-properties\.md:\d+: .*sizingH/);
    const all = await callTool(agent, 'read_skill', { name: 'figcraft', find: 'variable[.]set' });
    expect(all.text).toContain('references/commands.md:');
    // not a regular expression: searched as plain text
    const plain = await callTool(agent, 'read_skill', { name: 'figcraft', find: 'set_properties {ids' });
    expect(plain.text).toContain('SKILL.md:');
    expect((await callTool(agent, 'read_skill', { name: 'figcraft', find: 'no-such-words-anywhere' })).text).toContain('No line');
  });

  it('reads a file too long for one go in parts', () => {
    const s = skills.saveSkill({ name: 'Long ref', description: 'Use for long refs.', body: 'See ref.md' })!;
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1} ${'x'.repeat(30)}`);
    fs.writeFileSync(dataPath('skills', s.slug, 'ref.md'), lines.join('\n'));
    const first = skills.readSkillFile(s.slug, 'ref.md');
    expect(first.length).toBeLessThan(61000);
    const next = Number(/Go on with from=(\d+)/.exec(first)?.[1]);
    expect(first).toContain(`line ${next - 1} `);
    expect(first).not.toContain(`line ${next} `);
    const rest = skills.readSkillFile(s.slug, 'ref.md', next);
    expect(rest.startsWith(`line ${next} `)).toBe(true);
    expect(rest).toContain('line 2500 ');
    expect(rest).not.toContain('Go on with');
  });

  it("points a Hermes skill's folder at the skill in the library", async () => {
    skills.ensureBuiltinSkills();
    const r = await callTool(agent, 'read_skill', { name: 'gridcraft' });
    expect(r.text).not.toContain('${HERMES_SKILL_DIR}');
    expect(r.text).toContain(`${skills.skillDir('gridcraft').split(path.sep).join('/')}/references/functions.md`);
  });
});
