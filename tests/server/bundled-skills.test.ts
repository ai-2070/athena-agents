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
  it('include the storytold, OOMOL, Composio and Orca skills', () => {
    const slugs = skills.bundledSkills().map((b) => b.slug);
    expect(slugs).toEqual(expect.arrayContaining(['storytold', 'storytold-install', 'vectorcraft', 'photocraft', 'figcraft', 'oo', 'oo-find-skills', 'oo-create-skill', 'oo-publish-skill', 'composio', 'orca-cli', 'orchestration', 'computer-use', 'orca-linear', 'orca-jira', 'jira-tickets', 'orca-emulator', 'orca-emulator-android', 'orca-per-workspace-env']));
    expect(slugs).toHaveLength(29);
    // only Orca's current name for its Linear skill, not the old one too
    expect(slugs).not.toContain('linear-tickets');
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
    expect(origin['orca-cli']).toMatchObject({ repo: 'stablyai/orca', path: 'skills/orca-cli' });
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
    expect(skills.getSkill('orchestration')?.origin).toMatchObject({ repo: 'stablyai/orca', path: 'skills/orchestration', url: 'https://github.com/stablyai/orca/tree/main/skills/orchestration' });
    // Orca writes its descriptions as folded YAML ("description: >-")
    expect(skills.getSkill('orchestration')?.description).toMatch(/^Coordinate supervised Orca workers: .* coordinate a DAG, and for terminal control/);
    expect(skills.getSkill('cadcraft')?.name).toBe('My CAD notes');
    // nothing half-copied left behind
    expect(fs.readdirSync(dataPath('tmp')).filter((x) => x.startsWith('bundled-'))).toEqual([]);
  });

  it('include a skill of our own for starting coding agents in Orca', () => {
    skills.ensureBuiltinSkills();
    const s = skills.getSkill('orca-agents');
    expect(s?.name).toBe('Start agents in Orca');
    // Orca's ids for each agent, and the check that Orca is installed before anything starts
    for (const id of ['claude', 'codex', 'pi', 'omp', 'openclaw']) expect(s?.body).toContain(`| \`${id}\` |`);
    expect(s?.body).toContain('ORCA status --json');
    expect(s?.body).toContain('ORCA worktree create --name <short-task-name> --no-parent --agent <id> --prompt "<brief>" --json');
    expect(s?.body).toContain('ORCA agent launch --agent <id>');
    // not one of the bundled folders, so no GitHub origin
    expect(s?.origin).toBeFalsy();
    expect(skills.bundledSkills().map((b) => b.slug)).not.toContain('orca-agents');
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
